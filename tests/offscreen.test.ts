import assert from 'node:assert/strict';
import { test } from 'node:test';

test('audio serializes independent events, deduplicates, and reports blocked playback', async () => {
  let listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0];
  let contexts = 0;
  let maxContexts = 0;
  let chimes = 0;
  let rejectResume = false;
  const frequencies: number[] = [];
  class FakeAudioContext {
    state = rejectResume ? 'suspended' : 'running';
    currentTime = 0;
    destination = {};
    constructor() { contexts++; maxContexts = Math.max(maxContexts, contexts); chimes++; }
    resume() { return Promise.reject(new Error('Blocked')); }
    async close() { this.state = 'closed'; contexts--; }
    createOscillator() {
      const node = {
        type: '', frequency: { value: 0 }, onended: null as (() => void) | null,
        connect() {}, disconnect() {}, start() { frequencies.push(node.frequency.value); },
        stop() { queueMicrotask(() => node.onended?.()); },
      };
      return node;
    }
    createGain() {
      return {
        gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {}, disconnect() {},
      };
    }
  }
  globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
  globalThis.chrome = {
    runtime: {
      id: 'donebell-test', getURL: (path: string) => `chrome-extension://donebell-test/${path}`,
      onMessage: { addListener: (fn: typeof listener) => { listener = fn; } },
    },
  } as unknown as typeof chrome;
  await import('../src/offscreen/index.ts');
  const sender = { id: 'donebell-test', url: chrome.runtime.getURL('background/index.js') };
  const command = () => ({ type: 'PLAY_CHIME', eventId: `1:${crypto.randomUUID()}:${crypto.randomUUID()}` });
  const firstCommand = command();
  const request = (message = firstCommand) => new Promise<unknown>(resolve => {
    assert.equal(listener!(message, sender, resolve), true);
  });
  for (const source of [{ ...sender, tab: { id: 1 } }, { ...sender, id: 'other' },
    { ...sender, url: 'https://chatgpt.com/' }]) {
    assert.equal(listener!(firstCommand, source as chrome.runtime.MessageSender, () => assert.fail()), undefined);
  }
  assert.deepEqual(await Promise.all([request(), request(), request(command())]), [{ ok: true }, { ok: true }, { ok: true }]);
  assert.equal(chimes, 2);
  assert.equal(maxContexts, 1);
  assert.equal(contexts, 0);
  assert.deepEqual(frequencies, [659.25, 880, 659.25, 880]);
  assert.deepEqual(await request(), { ok: true });
  assert.equal(chimes, 2, 'Late duplicate is acknowledged without replay');

  rejectResume = true;
  assert.deepEqual(await request(command()), { ok: false, reason: 'audio' });
  assert.equal(contexts, 0);
  rejectResume = false;
  assert.deepEqual(await request(command()), { ok: true }, 'A failure does not poison subsequent requests');
});
