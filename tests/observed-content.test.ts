import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { SETTLING_MS } from '../src/content/detector.ts';
import { contentFixture, element, type FixtureElement } from './dom-fixture.ts';

// The recording establishes these labels and region, NOT article/form ancestry.
// Semantic articles/forms below are conditional compatibility fixtures. The
// ambiguous-layout test explicitly verifies silence without such a boundary.
const tr = { voice: 'Sesli iletişimi başlat', send: 'Gönder', stop: 'Durdur', regenerate: 'Yanıtı yeniden oluştur', copy: 'Kopyala' };
const en = { voice: 'Start voice mode', send: 'Send prompt', stop: 'Stop generating', regenerate: 'Regenerate response', copy: 'Copy' };
const button = (label: string) => element('button', { 'aria-label': label });
let imports = 0;

async function boot(t: TestContext, labels = tr, setup?: (region: FixtureElement) => void) {
  const f = contentFixture(t);
  const region = element('div', { role: 'region', 'aria-label': labels === tr ? 'Konuşma' : 'Conversation' });
  const composer = element('form');
  const editor = element('div', { contenteditable: 'true' });
  const control = button(labels.voice);
  composer.append(editor, control);
  f.main.append(region, composer);
  setup?.(region);
  await import(`../src/content/index.ts?observed=${++imports}`);
  await Promise.resolve();

  async function setControl(label: string) {
    // React may reuse a single button and change its accessible name.
    control.setAttribute('aria-label', label);
    await f.flush([{ target: control, type: 'attributes', attributeName: 'aria-label' }]);
  }
  async function begin(root = element('article')) {
    await setControl(labels.send);
    await setControl(labels.stop);
    if (!root.isConnected) {
      region.append(root);
      await f.flush([{ target: region, addedNodes: [root] }]);
    }
    return root;
  }
  async function end(root: FixtureElement, regenerate = button(labels.regenerate)) {
    root.append(regenerate);
    await setControl(labels.voice);
    await f.flush([{ target: root, addedNodes: [regenerate] }]);
    assert.equal(f.messages.length, 0, 'wait for the full settling period');
    await f.advance(SETTLING_MS);
    return regenerate;
  }
  function noLegacyAttributes() {
    assert.equal(f.main.querySelector('[data-testid]'), null);
    assert.equal(f.main.querySelector('[data-message-author-role]'), null);
  }
  return { ...f, region, composer, editor, control, labels, setControl, begin, end, noLegacyAttributes };
}

for (const labels of [tr, en]) {
  test(`${labels === tr ? 'Turkish observed' : 'English fallback'} Voice -> Send -> Stop -> Voice completes exactly once`, async t => {
    const f = await boot(t, labels);
    const root = await f.begin();
    await f.end(root);
    assert.equal(f.messages.length, 1);
    assert.match(f.messages[0].cycleId, /^[\da-f-]{36}$/);
    await f.flush([{ target: root, type: 'characterData' }]);
    await f.advance(100_000);
    assert.equal(f.messages.length, 1);
    f.noLegacyAttributes();
  });
}

test('typing, deleting and editing with historical completion controls never arms a cycle', async t => {
  const f = await boot(t, tr, region => {
    const old = element('article');
    old.append(button(tr.regenerate), button(tr.copy));
    region.append(old);
  });
  for (let i = 0; i < 3; i++) {
    await f.setControl(tr.send);
    await f.flush([{ target: f.editor, type: 'characterData' }]);
    await f.setControl(tr.voice);
    await f.advance(10_000);
  }
  assert.equal(f.cycleIds.length, 0);
  assert.equal(f.messages.length, 0);
});

for (const activation of ['pointerdown', 'click', 'Enter', ' ']) {
  test(`Turkish manual Stop via ${activation} remains silent when Voice and Regenerate return`, async t => {
    const f = await boot(t);
    const root = await f.begin();
    f.document.emit(activation === 'Enter' || activation === ' ' ? 'keydown' : activation, {
      target: f.control, key: activation,
    });
    await f.end(root);
    await f.advance(10_000);
    assert.equal(f.messages.length, 0);
  });
}

test('new response completes with historical Regenerate, assistant Copy and user Copy present', async t => {
  const f = await boot(t, tr, region => {
    const old = element('article');
    old.append(button(tr.regenerate), button(tr.copy), button('Sesli oku'), button('Diğer işlemler'));
    const user = element('article');
    user.append(button('Mesajı kopyala'));
    region.append(old, user);
  });
  await f.end(await f.begin());
  assert.equal(f.messages.length, 1);
  f.noLegacyAttributes();
});

test('historical Regenerate and a returning voice button cannot complete an unfinished response', async t => {
  const f = await boot(t, tr, region => {
    const old = element('article');
    old.append(button(tr.regenerate));
    region.append(old);
  });
  await f.begin();
  await f.setControl(tr.voice);
  await f.advance(100_000);
  assert.equal(f.messages.length, 0);
});

test('a late-added Regenerate on a historical response cannot finish the new response', async t => {
  const old = element('article');
  const f = await boot(t, tr, region => region.append(old));
  await f.begin();
  old.append(button(tr.regenerate));
  await f.flush([{ target: old }]);
  await f.setControl(tr.voice);
  await f.advance(10_000);
  assert.equal(f.messages.length, 0);
});

test('historical completion control moved into a new response is not new evidence', async t => {
  const regenerate = button(tr.regenerate);
  const f = await boot(t, tr, region => {
    const old = element('article');
    old.append(regenerate);
    region.append(old);
  });
  const root = await f.begin();
  await f.end(root, regenerate);
  assert.equal(f.messages.length, 0);
});

for (const method of ['hidden', 'disabled', 'removed', 'renamed']) {
  test(`regeneration reuses the response and ${method} Regenerate control, with Copy still present`, async t => {
    const root = element('article');
    const regenerate = button(tr.regenerate);
    root.append(button(tr.copy), regenerate);
    const f = await boot(t, tr, region => region.append(root));
    if (method === 'removed') regenerate.remove();
    else if (method === 'disabled') regenerate.disabled = true;
    else if (method === 'renamed') regenerate.setAttribute('aria-label', 'Diğer işlemler');
    else regenerate.setAttribute('hidden', '');
    // Withdrawal and Stop may arrive in one observer batch.
    await f.setControl(tr.stop);
    await f.flush([{ target: root }]);
    regenerate.disabled = false;
    regenerate.removeAttribute('hidden');
    regenerate.setAttribute('aria-label', tr.regenerate);
    await f.end(root, regenerate);
    assert.equal(f.messages.length, 1);
    f.noLegacyAttributes();
  });
}

test('unchanged historical Regenerate stays silent even if its response mutates during generation', async t => {
  const root = element('article');
  root.append(button(tr.regenerate));
  const f = await boot(t, tr, region => region.append(root));
  await f.begin(root);
  await f.flush([{ target: root, type: 'characterData' }]);
  await f.setControl(tr.voice);
  await f.advance(10_000);
  assert.equal(f.messages.length, 0);
});

test('consecutive Turkish responses and regeneration each emit one distinct cycle', async t => {
  const f = await boot(t);
  await f.end(await f.begin());
  const first = f.messages[0].cycleId;
  f.messages.length = 0;
  const root = await f.begin();
  const regenerate = await f.end(root);
  const second = f.messages[0].cycleId;
  f.messages.length = 0;
  regenerate.disabled = true;
  await f.setControl(tr.stop);
  regenerate.disabled = false;
  await f.end(root, regenerate);
  assert.equal(f.messages.length, 1);
  assert.equal(new Set([first, second, f.messages[0].cycleId]).size, 3);
});

test('temporary Stop disappearance without positive response completion remains silent and can resume', async t => {
  const f = await boot(t);
  const root = await f.begin();
  await f.setControl(tr.voice);
  await f.advance(10_000);
  assert.equal(f.messages.length, 0);
  await f.setControl(tr.stop);
  await f.end(root);
  assert.equal(f.messages.length, 1);
});

test('Stop returning during settling discards the pending confirmation', async t => {
  const f = await boot(t);
  const root = await f.begin();
  const regenerate = button(tr.regenerate);
  root.append(regenerate);
  await f.setControl(tr.voice);
  await f.advance(1000);
  regenerate.remove();
  await f.setControl(tr.stop);
  await f.advance(10_000);
  assert.equal(f.messages.length, 0);
  await f.end(root, regenerate);
  assert.equal(f.messages.length, 1);
});

for (const withCopy of [false, true]) {
  test(`Stop -> Voice with ${withCopy ? 'only Copy' : 'no response actions'} is insufficient`, async t => {
    const f = await boot(t);
    const root = await f.begin();
    if (withCopy) root.append(button(tr.copy));
    await f.setControl(tr.voice);
    await f.advance(100_000);
    assert.equal(f.messages.length, 0);
  });
}

for (const settling of [false, true]) {
  test(`recognized current-response error ${settling ? 'during settling' : 'during generation'} cancels`, async t => {
    const f = await boot(t);
    const root = await f.begin();
    if (settling) {
      root.append(button(tr.regenerate));
      await f.setControl(tr.voice);
      await f.advance(1000);
    }
    root.append(button('Retry'));
    await f.flush([{ target: root }]);
    await f.end(root);
    assert.equal(f.messages.length, 0);
  });
}

test('historical response error is isolated while a new response succeeds', async t => {
  const f = await boot(t, tr, region => {
    const old = element('article');
    old.append(button('Retry'));
    region.append(old);
  });
  await f.end(await f.begin());
  assert.equal(f.messages.length, 1);
});

test('background-tab completion revalidates after a delayed timer, with no visibility requirement', async t => {
  const f = await boot(t);
  Object.assign(f.document, { hidden: true, visibilityState: 'hidden' });
  const root = await f.begin();
  root.append(button(tr.regenerate));
  await f.setControl(tr.voice);
  await f.advance(60_000);
  assert.equal(f.messages.length, 1);
});

test('response mutations restart settling; composer edits do not', async t => {
  const f = await boot(t);
  const root = await f.begin();
  root.append(button(tr.regenerate));
  await f.setControl(tr.voice);
  await f.advance(1000);
  await f.flush([{ target: root, type: 'characterData' }]);
  await f.advance(1000);
  assert.equal(f.messages.length, 0);
  await f.setControl(tr.send);
  await f.flush([{ target: f.editor, type: 'characterData' }]);
  await f.advance(200);
  assert.equal(f.messages.length, 1);
});

for (const beforeResponse of [true, false]) {
  test(`Turkish new-chat URL promotion ${beforeResponse ? 'before' : 'after'} response mounts preserves one event`, async t => {
    const f = await boot(t);
    let root: FixtureElement;
    if (beforeResponse) await f.setControl(tr.stop);
    else root = await f.begin();
    await f.navigate('/c/new-chat');
    if (beforeResponse) {
      root = element('article');
      f.region.append(root);
      await f.flush([{ target: f.region, addedNodes: [root] }]);
    }
    await f.end(root!);
    assert.equal(f.messages.length, 1);
    assert.equal(f.cycleIds.length, 1);
  });
}

test('ordinary parent containers do not fabricate a response boundary', async t => {
  const f = await boot(t);
  const root = await f.begin(element('div'));
  await f.end(root);
  assert.equal(f.messages.length, 0);
  f.noLegacyAttributes();
});

test('development diagnostics log lifecycle transitions once and describe ambiguous attribution', async t => {
  Object.defineProperty(globalThis, '__DONEBELL_DEBUG__', { configurable: true, value: true });
  t.after(() => Reflect.deleteProperty(globalThis, '__DONEBELL_DEBUG__'));
  const logs: string[] = [];
  t.mock.method(console, 'debug', (message: string) => logs.push(message));
  const f = await boot(t);
  const root = await f.begin();
  for (let i = 0; i < 3; i++) await f.flush([{ target: root, type: 'characterData' }]);
  await f.end(root);
  await Promise.resolve();
  assert.deepEqual(logs, [
    '[DoneBell] Detector initialized', '[DoneBell] Conversation region found', '[DoneBell] Generation detected',
    '[DoneBell] Turn boundary recognized', '[DoneBell] Current response attributed',
    '[DoneBell] Current response completion evidence found',
    '[DoneBell] Completion candidate', '[DoneBell] Settling',
    '[DoneBell] Completion confirmed', '[DoneBell] Playback requested',
    '[DoneBell] Playback result: success',
  ]);
  f.messages.length = 0;
  await f.begin();
  f.document.emit('keydown', { target: f.control, key: 'Enter' });
  await f.setControl(tr.voice);
  assert.equal(logs.filter(log => log === '[DoneBell] Cancelled: manual Stop').length, 1);
  root.remove();
  await f.begin(element('div'));
  await f.setControl(tr.voice);
  for (let i = 0; i < 3; i++) await f.flush([{ target: f.editor, type: 'characterData' }]);
  assert.equal(logs.filter(log => log.startsWith('[DoneBell] Attribution unavailable')).length, 1);
  assert.equal(f.messages.length, 0);
});

test('sibling controls outside the semantic response cannot complete it', async t => {
  const f = await boot(t);
  await f.begin();
  const toolbar = element('div');
  toolbar.append(button(tr.regenerate), button(tr.copy));
  f.region.append(toolbar);
  await f.setControl(tr.voice);
  await f.advance(10_000);
  assert.equal(f.messages.length, 0);
});

test('Turkish Stop supports the main-level fallback without assuming a composer form', async t => {
  const f = await boot(t);
  f.main.append(f.editor, f.control);
  f.composer.remove();
  await f.flush([{ target: f.main, addedNodes: [f.control] }]);
  await f.end(await f.begin());
  assert.equal(f.messages.length, 1);
  f.noLegacyAttributes();
});

for (const scope of ['response', 'dialog', 'form without editor', 'unclassified conversation container']) {
  test(`unrelated Turkish Stop in ${scope} does not arm a lifecycle`, async t => {
    const f = await boot(t);
    const root = element(scope === 'response' ? 'article' : scope === 'dialog' ? 'dialog' : scope === 'form without editor' ? 'form' : 'div');
    const stop = button(tr.stop);
    root.append(stop);
    (scope === 'response' || scope === 'unclassified conversation container' ? f.region : f.main).append(root);
    await f.flush([{ target: f.main, addedNodes: [root] }]);
    assert.equal(f.cycleIds.length, 0);
    stop.remove();
    root.append(button(tr.regenerate));
    await f.flush([{ target: root }]);
    await f.advance(10_000);
    assert.equal(f.messages.length, 0);
  });
}

test('generic user sections do not override an existing explicit assistant boundary', async t => {
  const f = await boot(t);
  const pair = element('div', { class: 'flex flex-col gap-1.5' });
  const user = element('div', { class: 'block-opaque' });
  const group = element('div', { class: 'group/user-message' });
  const toolbar = element('div', { class: 'turn-action-controls' });
  toolbar.append(button('Mesajı kopyala'));
  group.append(toolbar);
  user.append(group);
  const assistant = element('div', { 'data-message-author-role': 'assistant' });
  pair.append(user, assistant);
  await f.setControl(tr.stop);
  f.region.append(pair);
  await f.flush([{ target: f.region, addedNodes: [pair] }]);
  await f.end(assistant);
  assert.equal(f.messages.length, 1);
});
