import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCompletionEvent, isPlaybackCommand, isPlaybackResult } from '../src/shared/messages.ts';

test('completion payload accepts only its exact minimal schema', () => {
  const cycleId = crypto.randomUUID();
  assert.ok(isCompletionEvent({ type: 'RESPONSE_COMPLETED', cycleId }));
  for (const value of [null, [], 'RESPONSE_COMPLETED', {},
    { type: 'RESPONSE_COMPLETED', cycleId: 1 },
    { type: 'RESPONSE_COMPLETED', cycleId: 'invalid' },
    { type: 'RESPONSE_COMPLETED', cycleId, text: 'extra' },
    { type: 'PLAY_CHIME', cycleId }]) assert.equal(isCompletionEvent(value), false);
});

test('playback identity distinguishes tabs and documents, with strict schema', () => {
  const eventId = `12:${crypto.randomUUID()}:${crypto.randomUUID()}`;
  assert.ok(isPlaybackCommand({ type: 'PLAY_CHIME', eventId }));
  assert.equal(isPlaybackCommand({ type: 'PLAY_CHIME', eventId: crypto.randomUUID() }), false);
  assert.equal(isPlaybackCommand({ type: 'PLAY_CHIME', eventId, extra: true }), false);
  assert.equal(isCompletionEvent({ type: 'PLAY_CHIME', eventId }), false);
});

test('acknowledgements never turn a failure or missing result into success', () => {
  assert.ok(isPlaybackResult({ ok: true }));
  assert.ok(isPlaybackResult({ ok: false, reason: 'audio' }));
  assert.ok(isPlaybackResult({ ok: false, reason: 'delivery' }));
  for (const value of [undefined, null, {}, { ok: 'true' }, { ok: false }, { ok: true, extra: 1 }]) {
    assert.equal(isPlaybackResult(value), false);
  }
});
