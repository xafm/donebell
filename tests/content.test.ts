import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { SETTLING_MS } from '../src/content/detector.ts';
import { action, contentFixture, element, type FixtureElement } from './dom-fixture.ts';

let imports = 0;
type Fixture = ReturnType<typeof contentFixture>;
async function boot(t: TestContext, path = '/', setup?: (fixture: Fixture) => void): Promise<Fixture> {
  const fixture = contentFixture(t, path);
  setup?.(fixture);
  const module = `../src/content/index.ts?fixture=${++imports}`;
  await import(module);
  await Promise.resolve();
  return fixture;
}
function response(wrapped = true) {
  const assistant = element('div', { 'data-message-author-role': 'assistant' });
  const root = wrapped ? element('article', { 'data-testid': 'conversation-turn-1' }) : assistant;
  if (wrapped) root.append(assistant);
  return { assistant, root };
}
async function begin(f: Fixture, options: { wrapped?: boolean; streaming?: boolean; mount?: boolean } = {}) {
  const stop = element('button', { 'data-testid': 'stop-button' });
  f.main.append(stop);
  await f.flush([{ target: f.main, addedNodes: [stop] }]);
  const turn = response(options.wrapped);
  if (options.streaming !== false) turn.root.setAttribute('data-is-streaming', 'true');
  if (options.mount !== false) {
    f.main.append(turn.root);
    await f.flush([{ target: f.main, addedNodes: [turn.root] }]);
  }
  return { ...turn, stop };
}
async function finish(f: Fixture, turn: { root: FixtureElement; stop: FixtureElement }, controls = ['copy', 'feedback']) {
  turn.stop.remove();
  turn.root.removeAttribute('data-is-streaming');
  turn.root.append(...controls.map(name => action(name as 'copy' | 'feedback')));
  await f.flush([
    { target: f.main },
    { target: turn.root, type: 'attributes', attributeName: 'data-is-streaming' },
    { target: turn.root },
  ]);
  assert.equal(f.messages.length, 0, 'must wait for settling');
  await f.advance(SETTLING_MS);
}
function oneCompletion(f: Fixture): void {
  assert.equal(f.messages.length, 1);
  assert.deepEqual(Object.keys(f.messages[0]).sort(), ['cycleId', 'type']);
  assert.equal(f.messages[0].type, 'RESPONSE_COMPLETED');
  assert.match(f.messages[0].cycleId, /^[\da-f-]{36}$/);
}

for (const composer of ['send', 'microphone', 'disabled send', 'hidden send', 'absent']) {
  test(`completion works with composer: ${composer}`, async t => {
    const f = await boot(t);
    if (composer !== 'absent') {
      const button = element('button', { 'data-testid': composer === 'microphone' ? 'voice-button' : 'send-button' });
      button.disabled = composer === 'disabled send';
      if (composer === 'hidden send') button.setAttribute('hidden', '');
      f.main.append(button);
    }
    const turn = await begin(f);
    await finish(f, turn);
    oneCompletion(f);
    await f.flush([{ target: turn.root, type: 'characterData' }]);
    await f.advance(10_000);
    oneCompletion(f);
  });
}

for (const controls of [['copy', 'feedback'], ['copy'], ['feedback'], []]) {
  test(`observed streaming completes with actions: ${controls.join(', ') || 'none'}`, async t => {
    const f = await boot(t);
    const turn = await begin(f);
    await finish(f, turn, controls);
    assert.equal(f.messages.length, controls.length ? 1 : 0);
  });
}

for (const controls of [['copy'], ['feedback']]) {
  test(`${controls[0]} alone without explicit streaming history is insufficient`, async t => {
    const f = await boot(t);
    const turn = await begin(f, { streaming: false });
    await finish(f, turn, controls);
    await f.advance(100_000);
    assert.equal(f.messages.length, 0);
  });
}

test('the full toolbar still completes when no explicit streaming marker is available', async t => {
  const f = await boot(t);
  await finish(f, await begin(f, { streaming: false }));
  oneCompletion(f);
});

test('early Copy and a temporarily missing Stop cannot complete a still-streaming response', async t => {
  const f = await boot(t);
  const turn = await begin(f);
  turn.root.append(action('copy'));
  turn.stop.remove();
  await f.flush([{ target: f.main }, { target: turn.root }]);
  await f.advance(10_000);
  assert.equal(f.messages.length, 0);
  f.main.append(turn.stop);
  await f.flush([{ target: f.main, addedNodes: [turn.stop] }]);
  await finish(f, turn, ['feedback']);
  oneCompletion(f);
});

test('a streaming pause with no completion actions stays silent', async t => {
  const f = await boot(t);
  const turn = await begin(f);
  await finish(f, turn, []);
  await f.advance(100_000);
  assert.equal(f.messages.length, 0);
});

test('an idle composer and completion actions cannot finish while generation is active', async t => {
  const f = await boot(t);
  const turn = await begin(f);
  turn.root.removeAttribute('data-is-streaming');
  turn.root.append(action('copy'), action('feedback'));
  f.main.append(element('button', { 'data-testid': 'send-button' }));
  await f.flush([{ target: f.main }, { target: turn.root }]);
  await f.advance(10_000);
  assert.equal(f.messages.length, 0);
  await finish(f, turn, []);
  oneCompletion(f);
});

test('controls on a historical response cannot complete the active response', async t => {
  const f = await boot(t, '/', f => {
    const old = response();
    old.root.append(action('copy'), action('feedback'));
    f.main.append(old.root);
  });
  const turn = await begin(f);
  await finish(f, turn, []);
  await f.advance(10_000);
  assert.equal(f.messages.length, 0);
});

test('unwrapped assistant can complete using only its own controls; mutations restart settling', async t => {
  const f = await boot(t);
  const turn = await begin(f, { wrapped: false });
  turn.stop.remove();
  turn.root.removeAttribute('data-is-streaming');
  turn.root.append(action('copy'));
  await f.flush([{ target: f.main }, { target: turn.root }]);
  await f.advance(1000);
  await f.flush([{ target: turn.assistant, type: 'characterData' }]);
  await f.advance(200);
  assert.equal(f.messages.length, 0);
  await f.advance(1000);
  oneCompletion(f);
});

test('unwrapped assistant cannot borrow sibling or neighboring toolbar controls', async t => {
  const f = await boot(t);
  const turn = await begin(f, { wrapped: false });
  const toolbar = element('div');
  toolbar.append(action('copy'), action('feedback'));
  f.main.append(toolbar);
  await finish(f, turn, []);
  assert.equal(f.messages.length, 0);
});

for (const failure of ['retry', 'alert', 'error marker']) {
  test(`historical ${failure} does not poison a successful next cycle`, async t => {
    const f = await boot(t, '/', f => {
      const old = response();
      old.root.append(failure === 'retry' ? action('retry') : element('div', failure === 'alert'
        ? { role: 'alert' } : { 'data-testid': 'conversation-turn-error' }));
      f.main.append(old.root);
    });
    // Stop can appear while the latest assistant still belongs to the failed turn.
    await finish(f, await begin(f));
    oneCompletion(f);
  });
}

test('unrelated alerts and pre-existing global errors do not poison a new cycle', async t => {
  const f = await boot(t, '/', f => f.main.append(element('div', { 'data-testid': 'error-message' })));
  const turn = await begin(f);
  f.main.append(element('div', { role: 'alert' }));
  turn.root.append(element('div', { role: 'alert' }));
  await f.flush([{ target: f.main }, { target: turn.root }]);
  await finish(f, turn);
  oneCompletion(f);
});

for (const failure of ['retry', 'turn marker', 'global marker', 'revealed global marker']) {
  test(`current-cycle ${failure} cancels immediately, followed by a successful retry`, async t => {
    let hidden: FixtureElement;
    const f = await boot(t, '/', f => {
      hidden = element('div', { 'data-testid': 'error-message', hidden: '' });
      f.main.append(hidden);
    });
    const turn = await begin(f);
    if (failure === 'revealed global marker') hidden!.removeAttribute('hidden');
    else if (failure === 'global marker') f.main.append(element('div', { 'data-testid': 'error-message' }));
    else turn.root.append(failure === 'retry' ? action('retry') : element('div', { 'data-testid': 'conversation-turn-error' }));
    await f.flush([{ target: f.main }, { target: turn.root }]);
    await finish(f, turn);
    assert.equal(f.messages.length, 0);
    await finish(f, await begin(f));
    oneCompletion(f);
  });
}

for (const global of [true, false]) {
  test(`${global ? 'global' : 'response'} failure during settling cancels completion`, async t => {
    const f = await boot(t);
    const turn = await begin(f);
    turn.stop.remove();
    turn.root.removeAttribute('data-is-streaming');
    turn.root.append(action('copy'), action('feedback'));
    await f.flush([{ target: f.main }, { target: turn.root }]);
    await f.advance(SETTLING_MS - 1);
    const scope = global ? f.main : turn.root;
    scope.append(element('div', { 'data-testid': 'error-message' }));
    await f.flush([{ target: scope }]);
    await f.advance(10_000);
    assert.equal(f.messages.length, 0);
  });
}

test('streaming evidence from a previous cycle cannot qualify a later single-action response', async t => {
  const f = await boot(t);
  await finish(f, await begin(f));
  oneCompletion(f);
  f.messages.length = 0;
  await finish(f, await begin(f, { streaming: false }), ['copy']);
  assert.equal(f.messages.length, 0);
});

for (const wrapped of [true, false]) {
  test(`regenerating a ${wrapped ? 'wrapped' : 'bare'} completed response emits a new cycle UUID`, async t => {
    const f = await boot(t);
    const turn = await begin(f, { wrapped });
    await finish(f, turn);
    const first = f.messages[0].cycleId;
    f.messages.length = 0;
    for (const button of [...turn.root.querySelectorAll('button')]) button.remove();
    turn.root.setAttribute('data-is-streaming', 'true');
    f.main.append(turn.stop);
    await f.flush([{ target: f.main }, { target: turn.root }]);
    await finish(f, turn);
    oneCompletion(f);
    assert.notEqual(f.messages[0].cycleId, first);
  });
}

test('manual Stop remains latched even when completion controls subsequently appear', async t => {
  const f = await boot(t);
  const turn = await begin(f);
  f.document.emit('pointerdown', { target: turn.stop });
  await f.flush([{ target: turn.root }]);
  await finish(f, turn);
  assert.equal(f.messages.length, 0);
});

for (const timing of ['before assistant', 'after assistant', 'before queued sample', 'before observer delivery']) {
  for (const entryChange of [true, false]) {
    test(`URL promotion ${timing}, ${entryChange ? 'Navigation API' : 'observer fallback'} preserves one completion`, async t => {
      const f = await boot(t);
      const turn = await begin(f, { mount: timing === 'after assistant' });
      if (timing === 'before queued sample' || timing === 'before observer delivery') {
        // First discard the cycle above; begin a fresh fixture in idle state.
        f.document.emit('click', { target: element('a', { href: '/c/other' }) });
        turn.stop.remove();
        await f.flush([{ target: f.main }]);
        f.main.append(turn.stop);
        if (timing === 'before queued sample') {
          // The callback queues sample(), but navigate fires synchronously first.
          const observer = f.observers.find(observer => observer.root === f.main)!;
          observer.callback([{ type: 'childList', target: f.main, addedNodes: [] }] as unknown as MutationRecord[], observer as unknown as MutationObserver);
        }
      }
      const cyclesBeforePromotion = f.cycleIds.length;
      await f.navigate('/c/new-chat', { entryChange });
      if (timing !== 'after assistant') f.main.append(turn.root);
      await f.flush([{ target: f.main, addedNodes: [turn.root] }], !entryChange);
      await finish(f, turn);
      oneCompletion(f);
      assert.equal(f.cycleIds.length, cyclesBeforePromotion + (timing.startsWith('before ') && timing !== 'before assistant' ? 1 : 0));
      assert.equal(f.messages[0].cycleId, f.cycleIds.at(-1));
      assert.equal(f.observers.filter(observer => observer.root).length, 2);
    });
  }
}

for (const navigation of ['user replace', 'push', 'sidebar', 'back', 'reload', 'cross-document', 'no event', 'replaced Stop', 'replaced root', 'replaced assistant']) {
  test(`actual or unproven navigation cancels: ${navigation}`, async t => {
    const f = await boot(t);
    const turn = await begin(f);
    if (navigation === 'sidebar') {
      f.document.emit('click', { target: element('a', { href: '/c/existing' }) });
      await f.navigate('/c/existing');
    } else if (navigation === 'no event') {
      f.location.pathname = '/c/existing';
      await f.flush([{ target: f.main }]);
    } else if (navigation.startsWith('replaced ')) {
      await f.navigate('/c/new-chat', { entryChange: false });
      if (navigation === 'replaced Stop') {
        turn.stop.remove();
        f.main.append(element('button', { 'data-testid': 'stop-button' }));
      } else if (navigation === 'replaced root') {
        f.main.remove();
        f.body.append(element('main'));
      } else {
        turn.root.remove();
        const replacement = response();
        f.main.append(replacement.root);
        await f.flush([{ target: f.main, addedNodes: [replacement.root] }]);
      }
      await f.flush([{ target: f.body }]);
    } else {
      await f.navigate(navigation === 'reload' ? '/' : '/c/existing', {
        userInitiated: navigation === 'user replace',
        navigationType: navigation === 'push' ? 'push' : navigation === 'back' ? 'traverse' : navigation === 'reload' ? 'reload' : 'replace',
        sameDocument: navigation !== 'cross-document',
      });
    }
    await finish(f, turn);
    await f.advance(10_000);
    assert.equal(f.messages.length, 0);
  });
}

test('loading or returning to a completed conversation stays silent', async t => {
  const f = await boot(t, '/c/old', f => {
    const old = response();
    old.root.append(action('copy'), action('feedback'));
    f.main.append(old.root);
  });
  await f.advance(10_000);
  await f.navigate('/c/another', { navigationType: 'traverse' });
  f.window.emit('pageshow', { persisted: true });
  await f.advance(10_000);
  assert.equal(f.messages.length, 0);
  assert.equal(f.observers.filter(observer => observer.root).length, 2);
});

test('page exit discards an active cycle and its observers', async t => {
  const f = await boot(t);
  const turn = await begin(f);
  f.window.emit('pagehide');
  await finish(f, turn);
  assert.equal(f.messages.length, 0);
  assert.equal(f.observers.filter(observer => observer.root).length, 0);
});
