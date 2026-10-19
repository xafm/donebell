import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlaybackCommand } from '../src/shared/messages.ts';

test('worker validates senders, shares offscreen creation, and recovers after document/worker shutdown', async () => {
  let listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0];
  let exists = false;
  let creations = 0;
  let deliveries = 0;
  let played = 0;
  let failCreation = false;
  let release: () => void = () => {};
  const audioLedger = new Set<string>();
  const fakeChrome = {
    runtime: {
      id: 'donebell-test',
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      getURL: (path: string) => `chrome-extension://donebell-test/${path}`,
      getContexts: async () => exists ? [{}] : [],
      onMessage: { addListener: (fn: typeof listener) => { listener = fn; } },
      sendMessage: async (message: PlaybackCommand) => {
        deliveries++;
        if (!audioLedger.has(message.eventId)) { audioLedger.add(message.eventId); played++; }
        return { ok: true };
      },
    },
    offscreen: {
      Reason: { AUDIO_PLAYBACK: 'AUDIO_PLAYBACK' },
      createDocument: async (options: { reasons: string[]; url: string }) => {
        assert.deepEqual(options.reasons, ['AUDIO_PLAYBACK']);
        assert.equal(options.url, 'offscreen/offscreen.html');
        creations++;
        if (failCreation) throw new Error('Creation rejected');
        await new Promise<void>(resolve => { release = resolve; });
        exists = true;
      },
    },
  };
  globalThis.chrome = fakeChrome as unknown as typeof chrome;
  await import('../src/background/index.ts');
  const sender = {
    id: fakeChrome.runtime.id, origin: 'https://chatgpt.com', url: 'https://chatgpt.com/c/local',
    frameId: 0, tab: { id: 1 }, documentId: crypto.randomUUID(),
  } as chrome.runtime.MessageSender;
  const message = { type: 'RESPONSE_COMPLETED', cycleId: crypto.randomUUID() };
  for (const invalid of [
    { ...sender, id: 'other' }, { ...sender, origin: 'https://example.com' },
    { ...sender, url: 'https://chatgpt.com.evil.test/' }, { ...sender, frameId: 1 },
    { ...sender, tab: undefined }, { ...sender, documentId: undefined },
  ]) assert.equal(listener!(message, invalid, () => assert.fail('Unauthorized acknowledgement')), undefined);
  assert.equal(listener!({ ...message, extra: true }, sender, () => assert.fail()), undefined);
  const request = (payload = message, source = sender) => new Promise<unknown>(resolve => {
    assert.equal(listener!(payload, source, resolve), true);
  });
  const first = request();
  const duplicate = request();
  const otherTab = request(message, { ...sender, tab: { id: 2 } as chrome.tabs.Tab });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(creations, 1);
  release();
  assert.deepEqual(await Promise.all([first, duplicate, otherTab]), [{ ok: true }, { ok: true }, { ok: true }]);
  assert.equal(deliveries, 2);
  assert.equal(played, 2);

  // Reload only the worker module, leaving the simulated audio document alive.
  const restartPath = '../src/background/index.ts?worker-restart';
  await import(restartPath);
  assert.deepEqual(await request(), { ok: true });
  assert.equal(played, 2, 'Audio-side identity survives worker restart');
  assert.equal(creations, 1);

  // Idle closure requires a fresh document on the next legitimate event.
  exists = false;
  const next = request({ ...message, cycleId: crypto.randomUUID() });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(creations, 2);
  release();
  await next;
  assert.equal(played, 3);

  exists = false;
  failCreation = true;
  assert.deepEqual(await request({ ...message, cycleId: crypto.randomUUID() }), { ok: false, reason: 'delivery' });
  failCreation = false;
  const recovered = request({ ...message, cycleId: crypto.randomUUID() });
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.deepEqual(await recovered, { ok: true }, 'Failed creation releases the shared promise');
  assert.equal(creations, 4);

  fakeChrome.runtime.sendMessage = async () => { throw new Error('Unavailable'); };
  assert.deepEqual(await request({ ...message, cycleId: crypto.randomUUID() }), { ok: false, reason: 'delivery' });
  assert.equal(creations, 4);
});
