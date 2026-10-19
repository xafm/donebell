import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { SETTLING_MS } from '../src/content/detector.ts';
import { contentFixture, element } from './dom-fixture.ts';

const labels = { stop: 'Durdur', copy: 'Kopyala', regenerate: 'Yanıtı yeniden oluştur', userCopy: 'Mesajı kopyala' };
const button = (label: string) => element('button', { 'aria-label': label });
function toolbar(user = false) {
  const root = element('div', { class: 'turn-action-controls' });
  root.append(...(user ? [button(labels.userCopy)] : [button(labels.copy), button('Sesli oku'), button(labels.regenerate)]));
  return root;
}

// Completed hierarchy comes from the supplied capture. The unfinished variant
// is a synthetic hypothesis: the paired section/content mounts before actions.
// No article, test IDs, assistant roles, streaming attributes or message text.
function logicalTurn(options: { completed?: boolean; pending?: boolean; suffix?: string } = {}) {
  const group = element('div');
  const wrapper = element('div');
  const inner = element('div');
  const pair = element('div', { class: 'flex flex-col gap-1.5' });
  const sectionClass = `block-${options.suffix ?? 'BQZwFn'}`;
  const user = element('div', { class: sectionClass });
  const userGroup = element('div', { class: 'group/user-message' });
  const userActions = toolbar(true);
  userGroup.append(element('div'), userActions);
  user.append(userGroup);
  const response = element('div', { class: sectionClass });
  const responseRoot = element('div', { class: 'DilResponseRoot-HfQrEh' });
  const activity = element('div');
  const actions = toolbar();
  responseRoot.append(activity);
  if (options.completed) responseRoot.append(actions);
  response.append(responseRoot);
  pair.append(user);
  if (!options.pending) pair.append(response);
  inner.append(pair);
  wrapper.append(inner);
  group.append(wrapper);
  return { group, pair, user, userGroup, userActions, response, responseRoot, activity, actions };
}
type Turn = ReturnType<typeof logicalTurn>;
let imports = 0;
async function boot(t: TestContext, count = 8) {
  const f = contentFixture(t);
  const region = element('div', { role: 'region', 'aria-label': 'Konuşma' });
  const content = element('div', { class: 'transcriptContent-l_FOQD' });
  const outer = element('div');
  const transcript = element('div', { class: 'flex flex-col' });
  const history = Array.from({ length: count }, () => logicalTurn({ completed: true }));
  transcript.append(...history.map(turn => turn.group));
  outer.append(transcript);
  content.append(outer);
  region.append(content);
  const composer = element('form');
  const editor = element('div', { contenteditable: 'true' });
  const control = button('Sesli iletişimi başlat');
  composer.append(editor, control);
  f.main.append(region, composer);
  await import(`../src/content/index.ts?generic=${++imports}`);
  await Promise.resolve();

  async function setControl(label: string) {
    control.setAttribute('aria-label', label);
    await f.flush([{ target: control, type: 'attributes', attributeName: 'aria-label' }]);
  }
  async function mountResponse(turn: Turn) {
    turn.pair.append(turn.response);
    await f.flush([{ target: turn.pair, addedNodes: [turn.response] }]);
  }
  async function begin(pending = false) {
    const turn = logicalTurn({ pending: true });
    transcript.append(turn.group);
    await f.flush([{ target: transcript, addedNodes: [turn.group] }]);
    await setControl(labels.stop);
    if (!pending) await mountResponse(turn);
    return turn;
  }
  async function complete(turn: Turn) {
    turn.responseRoot.append(turn.actions);
    await f.flush([{ target: turn.responseRoot, addedNodes: [turn.actions] }]);
    await setControl('Gönder'); // The voice button is not required.
  }
  async function finish(turn: Turn) {
    await complete(turn);
    const count = f.messages.length;
    await f.advance(SETTLING_MS - 1);
    assert.equal(f.messages.length, count);
    await f.advance(1);
  }
  return { ...f, region, transcript, history, composer, editor, control, setControl, mountResponse, begin, complete, finish };
}

function debug(t: TestContext) {
  Object.defineProperty(globalThis, '__DONEBELL_DEBUG__', { configurable: true, value: true });
  t.after(() => Reflect.deleteProperty(globalThis, '__DONEBELL_DEBUG__'));
  const logs: string[] = [];
  t.mock.method(console, 'debug', (message: string) => logs.push(message));
  return logs;
}

test('generic capture: eight completed sibling turns load silently with separate user/assistant toolbars', async t => {
  const f = await boot(t);
  assert.equal(f.region.querySelectorAll('article, [role="article"], [data-testid], [data-message-author-role]').length, 0);
  assert.equal(f.region.querySelectorAll('button[aria-label="Mesajı kopyala"]').length, 8);
  assert.equal(f.region.querySelectorAll('button[aria-label="Kopyala"]').length, 8);
  assert.equal(f.region.querySelectorAll('[class~="turn-action-controls"]').length, 16);
  await f.advance(100_000);
  assert.equal(f.cycleIds.length, 0);
  assert.equal(f.messages.length, 0);
});

test('generic capture: delayed response mount preserves one lifecycle and completes after 1200ms', async t => {
  const logs = debug(t);
  const f = await boot(t);
  const turn = await f.begin(true);
  await f.advance(10_000);
  assert.equal(f.cycleIds.length, 1);
  assert.equal(f.messages.length, 0);
  await f.mountResponse(turn);
  for (let i = 0; i < 3; i++) await f.flush([{ target: turn.activity, type: 'characterData' }]);
  await f.finish(turn);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].cycleId, f.cycleIds[0]);
  for (const stage of ['Conversation region found', 'Turn boundary recognized', 'Current response attributed',
    'Current response completion evidence found', 'Completion confirmed', 'Playback requested', 'Playback result: success']) {
    assert.equal(logs.filter(log => log === `[DoneBell] ${stage}`).length, 1, stage);
  }
  await f.flush([{ target: turn.activity, type: 'characterData' }]);
  await f.advance(100_000);
  assert.equal(f.messages.length, 1);
});

test('generic capture: historical controls and Stop disappearance cannot finish an unfinished response', async t => {
  const logs = debug(t);
  const f = await boot(t);
  await f.begin();
  await f.setControl('Sesli iletişimi başlat');
  await f.advance(100_000);
  assert.equal(f.messages.length, 0);
  assert.ok(logs.includes('[DoneBell] Current response attributed'));
  assert.ok(logs.includes('[DoneBell] Attribution unavailable: no new finished-response evidence'));
});

test('generic capture: unrelated div, historical toolbar rerender, user actions and sibling toolbar stay isolated', async t => {
  const f = await boot(t);
  const turn = await f.begin();
  const unrelated = element('div');
  unrelated.append(element('div'), toolbar());
  f.region.append(unrelated);
  const old = f.history[3];
  old.actions.remove();
  const rerendered = toolbar();
  old.responseRoot.append(rerendered);
  turn.userActions.remove();
  const userActions = toolbar(true);
  turn.userGroup.append(userActions);
  const sibling = toolbar();
  turn.pair.parentElement!.append(sibling);
  await f.flush([
    { target: f.region, addedNodes: [unrelated] },
    { target: old.responseRoot, addedNodes: [rerendered] },
    { target: turn.userGroup, addedNodes: [userActions] },
    { target: turn.pair.parentElement!, addedNodes: [sibling] },
  ]);
  await f.setControl('Gönder');
  await f.advance(100_000);
  assert.equal(f.messages.length, 0);
});

for (const activation of ['pointerdown', 'click', 'Enter', ' ']) {
  for (const nearCompletion of [false, true]) {
    test(`generic capture: manual Stop via ${JSON.stringify(activation)} ${nearCompletion ? 'just before completion' : 'during streaming'} cancels`, async t => {
      const f = await boot(t);
      const turn = await f.begin();
      if (nearCompletion) {
        turn.responseRoot.append(turn.actions);
        await f.flush([{ target: turn.responseRoot, addedNodes: [turn.actions] }]);
      }
      f.document.emit(activation === 'Enter' || activation === ' ' ? 'keydown' : activation,
        { target: f.control, key: activation });
      await f.finish(turn);
      await f.advance(100_000);
      assert.equal(f.messages.length, 0);
    });
  }
}

for (const withdrawal of ['removed', 'hidden', 'disabled', 'renamed', 'replaced toolbar']) {
  test(`generic capture: regeneration with ${withdrawal} evidence completes once`, async t => {
    const f = await boot(t);
    const turn = f.history.at(-1)!;
    const regenerate = turn.actions.querySelector('button[aria-label="Yanıtı yeniden oluştur"]')!;
    if (withdrawal === 'removed') regenerate.remove();
    else if (withdrawal === 'hidden') regenerate.setAttribute('hidden', '');
    else if (withdrawal === 'disabled') regenerate.disabled = true;
    else if (withdrawal === 'renamed') regenerate.setAttribute('aria-label', 'Diğer işlemler');
    else turn.actions.remove();
    await f.setControl(labels.stop);
    await f.flush([{ target: turn.responseRoot }]);
    regenerate.removeAttribute('hidden');
    regenerate.disabled = false;
    regenerate.setAttribute('aria-label', labels.regenerate);
    if (withdrawal === 'replaced toolbar') {
      const fresh = toolbar();
      turn.responseRoot.append(fresh);
      await f.flush([{ target: turn.responseRoot, addedNodes: [fresh] }]);
      await f.setControl('Gönder');
      await f.advance(SETTLING_MS);
    } else {
      turn.actions.append(regenerate);
      await f.finish(turn);
    }
    assert.equal(f.messages.length, 1);
    await f.flush([{ target: turn.activity, type: 'characterData' }]);
    await f.advance(10_000);
    assert.equal(f.messages.length, 1);
  });
}

test('generic capture: continuously available regeneration controls suppress notification', async t => {
  const f = await boot(t);
  const turn = f.history.at(-1)!;
  await f.setControl(labels.stop);
  await f.flush([{ target: turn.activity, type: 'characterData' }]);
  await f.setControl('Gönder');
  await f.advance(100_000);
  assert.equal(f.messages.length, 0);
});

test('generic capture: two consecutive completions emit distinct UUIDs exactly once', async t => {
  const f = await boot(t);
  await f.finish(await f.begin());
  const second = await f.begin();
  await f.finish(second);
  assert.equal(f.messages.length, 2);
  assert.notEqual(f.messages[0].cycleId, f.messages[1].cycleId);
  await f.flush([{ target: second.activity, type: 'characterData' }]);
  await f.advance(100_000);
  assert.equal(f.messages.length, 2);
});

for (const beforeMount of [true, false]) {
  for (const entryChange of [true, false]) {
    test(`generic capture: first-chat URL promotion ${beforeMount ? 'before' : 'after'} response, ${entryChange ? 'Navigation API' : 'observer fallback'}`, async t => {
      const f = await boot(t, 0);
      const turn = await f.begin(beforeMount);
      await f.navigate('/c/new-chat', { entryChange });
      if (beforeMount) await f.mountResponse(turn);
      await f.finish(turn);
      assert.equal(f.messages.length, 1);
      assert.equal(f.cycleIds.length, 1);
    });
  }
}

for (const navigation of ['push', 'traverse', 'sidebar', 'reload']) {
  test(`generic capture: genuine navigation via ${navigation} cancels`, async t => {
    const f = await boot(t);
    const turn = await f.begin();
    if (navigation === 'sidebar') f.document.emit('click', { target: element('a', { href: '/c/other' }) });
    await f.navigate('/c/other', { navigationType: navigation === 'sidebar' ? 'replace' : navigation });
    await f.finish(turn);
    assert.equal(f.messages.length, 0);
  });
}

for (const malformed of ['unshared sections', 'multiple response sections', 'no content container', 'multiple toolbars', 'missing user toolbar', 'dialog']) {
  test(`generic capture: uncertain ${malformed} stays silent with an attribution diagnostic`, async t => {
    const logs = debug(t);
    const f = await boot(t);
    const turn = logicalTurn();
    if (malformed === 'unshared sections') turn.response.setAttribute('class', 'unrelated');
    else if (malformed === 'multiple response sections') turn.pair.append(element('div'));
    else if (malformed === 'no content container') turn.responseRoot.remove();
    else if (malformed === 'multiple toolbars') turn.responseRoot.append(toolbar(), toolbar());
    else if (malformed === 'missing user toolbar') turn.userActions.remove();
    else turn.group.setAttribute('role', 'dialog');
    f.transcript.append(turn.group);
    await f.setControl(labels.stop);
    await f.flush([{ target: f.transcript, addedNodes: [turn.group] }]);
    await f.finish(turn);
    await f.advance(10_000);
    assert.equal(f.messages.length, 0);
    assert.ok(logs.some(log => log.startsWith('[DoneBell] Attribution unavailable:')));
    assert.ok(!logs.includes('[DoneBell] Current response attributed'));
  });
}

for (const settling of [false, true]) {
  test(`generic capture: local Retry error ${settling ? 'during settling' : 'during generation'} cancels; historical Retry is isolated`, async t => {
    const f = await boot(t);
    const historicalError = button('Retry');
    f.history[0].responseRoot.append(historicalError);
    await f.flush([{ target: f.history[0].responseRoot, addedNodes: [historicalError] }]);
    const turn = await f.begin();
    if (settling) { await f.complete(turn); await f.advance(SETTLING_MS - 1); }
    const error = button('Retry');
    turn.activity.append(error);
    await f.flush([{ target: turn.activity, addedNodes: [error] }]);
    if (!settling) await f.complete(turn);
    await f.advance(10_000);
    assert.equal(f.messages.length, 0);
    await f.finish(await f.begin());
    assert.equal(f.messages.length, 1);
  });
}

test('generic capture: current activity resets settling; composer and historical changes do not', async t => {
  const f = await boot(t);
  const turn = await f.begin();
  await f.complete(turn);
  await f.advance(1000);
  await f.flush([{ target: turn.activity, type: 'characterData' }]);
  await f.advance(1000);
  assert.equal(f.messages.length, 0);
  await f.flush([
    { target: f.editor, type: 'characterData' },
    { target: f.history[2].activity, type: 'characterData' },
  ]);
  await f.advance(200);
  assert.equal(f.messages.length, 1);
});

test('generic capture: Stop returning during settling invalidates the pending confirmation', async t => {
  const f = await boot(t);
  const turn = await f.begin();
  await f.complete(turn);
  await f.advance(1000);
  turn.actions.remove();
  await f.setControl(labels.stop);
  await f.flush([{ target: turn.responseRoot }]);
  await f.advance(10_000);
  assert.equal(f.messages.length, 0);
  await f.finish(turn);
  assert.equal(f.messages.length, 1);
});

test('generic capture: replacing a response node never inherits the previous candidate', async t => {
  const f = await boot(t);
  const turn = await f.begin();
  turn.response.remove();
  const replacement = logicalTurn({ completed: true });
  turn.pair.append(replacement.response);
  await f.flush([{ target: turn.pair, addedNodes: [replacement.response] }]);
  await f.setControl('Gönder');
  await f.advance(100_000);
  assert.equal(f.messages.length, 0);
});

test('generic capture: a historical control moved to the current response remains ineligible', async t => {
  const f = await boot(t);
  const turn = await f.begin();
  const regenerate = f.history[0].actions.querySelector('button[aria-label="Yanıtı yeniden oluştur"]')!;
  const actions = element('div', { class: 'turn-action-controls' });
  actions.append(regenerate);
  turn.responseRoot.append(actions);
  await f.flush([{ target: turn.responseRoot, addedNodes: [actions] }]);
  await f.setControl('Gönder');
  await f.advance(100_000);
  assert.equal(f.messages.length, 0);
});

test('generic capture: opaque class suffix changes preserve local sibling recognition', async t => {
  const f = await boot(t);
  const turn = logicalTurn({ suffix: 'different-build' });
  f.transcript.append(turn.group);
  await f.setControl(labels.stop);
  await f.flush([{ target: f.transcript, addedNodes: [turn.group] }]);
  await f.finish(turn);
  assert.equal(f.messages.length, 1);
});

test('generic capture: background delayed timer rechecks current response without tab visibility', async t => {
  const f = await boot(t);
  Object.assign(f.document, { hidden: true, visibilityState: 'hidden' });
  const turn = await f.begin();
  await f.complete(turn);
  await f.advance(60_000);
  assert.equal(f.messages.length, 1);
});

test('generic index refreshes a current response without structural rescans of historical groups', async t => {
  const f = await boot(t);
  const turn = await f.begin();
  for (const old of f.history) {
    const original = old.group.querySelectorAll.bind(old.group);
    t.mock.method(old.group, 'querySelectorAll', (selector: string) => {
      assert.notEqual(selector, 'button[aria-label="Mesajı kopyala"]', 'historical structure must stay indexed');
      return original(selector);
    });
  }
  await f.flush([{ target: turn.activity, type: 'characterData' }]);
  await f.finish(turn);
  assert.equal(f.messages.length, 1);
});

for (const replacement of ['response', 'logical turn']) {
  test(`generic capture: replacing a historical ${replacement} before attribution cannot impersonate a new response`, async t => {
    const f = await boot(t);
    const old = f.history.at(-1)!;
    await f.setControl(labels.stop);
    const fresh = logicalTurn();
    if (replacement === 'response') {
      old.response.remove();
      old.pair.append(fresh.response);
      await f.flush([{ target: old.pair, addedNodes: [fresh.response] }]);
    } else {
      old.group.remove();
      f.transcript.append(fresh.group);
      await f.flush([{ target: f.transcript, addedNodes: [fresh.group] }]);
    }
    fresh.responseRoot.append(fresh.actions);
    await f.flush([{ target: fresh.responseRoot, addedNodes: [fresh.actions] }]);
    await f.setControl('Gönder');
    await f.advance(100_000);
    assert.equal(f.messages.length, 0);
  });
}

test('generic capture: a new response and Stop in one observer batch use the historical idle baseline', async t => {
  const f = await boot(t);
  const turn = logicalTurn();
  f.transcript.append(turn.group);
  f.control.setAttribute('aria-label', labels.stop);
  await f.flush([
    { target: f.transcript, addedNodes: [turn.group] },
    { target: f.control, type: 'attributes', attributeName: 'aria-label' },
  ]);
  await f.finish(turn);
  assert.equal(f.messages.length, 1);
  assert.equal(f.cycleIds.length, 1);
});

test('generic capture: changing an earlier historical response cannot attribute it to the current cycle', async t => {
  const f = await boot(t);
  const turn = await f.begin(true);
  const old = f.history[2];
  old.actions.remove();
  await f.flush([{ target: old.responseRoot }]);
  old.responseRoot.append(toolbar());
  await f.flush([{ target: old.responseRoot, addedNodes: [...old.responseRoot.children] }]);
  await f.setControl('Gönder');
  await f.advance(100_000);
  assert.equal(f.messages.length, 0);
  assert.ok(!turn.response.isConnected);
});

test('generic capture: a wrapper enclosing several logical turns cannot be one response', async t => {
  const f = await boot(t);
  const wrapper = element('div', { class: 'block-BQZwFn' });
  const first = logicalTurn();
  const second = logicalTurn({ completed: true });
  wrapper.append(first.group, second.group);
  f.transcript.append(wrapper);
  await f.setControl(labels.stop);
  await f.flush([{ target: f.transcript, addedNodes: [wrapper] }]);
  await f.setControl('Gönder');
  await f.advance(100_000);
  assert.equal(f.messages.length, 0);
});
