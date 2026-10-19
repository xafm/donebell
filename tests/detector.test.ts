import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompletionDetector, SETTLING_MS, type Snapshot } from '../src/content/detector.ts';

const old = {};
const response = {};
const ui = (patch: Partial<Snapshot> = {}): Snapshot => ({
  assistant: old, generating: false, streaming: false, finished: true,
  fullToolbar: true, error: false, globalErrors: [], revision: 0, ...patch,
});
function start(detector = new CompletionDetector()) {
  detector.sample(ui({ generating: true }), 0);
  detector.sample(ui({ assistant: response, generating: true, finished: false, revision: 1 }), 10);
  return detector;
}
function ended(patch: Partial<Snapshot> = {}) { return ui({ assistant: response, revision: 2, ...patch }); }

test('initial load, historical conversations and delayed idle rendering stay silent', () => {
  const detector = new CompletionDetector();
  for (let i = 0; i < 10; i++) assert.equal(detector.sample(ui({ revision: i }), i * 5000), null);
  assert.equal(detector.state, 'IDLE');
});

test('one confirmed response emits one UUID, after the full settling interval', () => {
  const detector = start();
  assert.equal(detector.sample(ended(), 100), null);
  assert.equal(detector.state, 'SETTLING');
  assert.equal(detector.sample(ended(), 100 + SETTLING_MS - 1), null);
  assert.match(detector.sample(ended(), 100 + SETTLING_MS)!, /^[\da-f-]{36}$/);
  for (let i = 0; i < 5; i++) assert.equal(detector.sample(ended({ revision: 3 + i }), 5000 + i * 2000), null);
});

test('Stop and a new response appearing in the same mutation batch use the idle baseline', () => {
  const detector = new CompletionDetector();
  detector.sample(ui(), 0);
  detector.sample(ended({ generating: true, finished: false }), 10);
  detector.sample(ended(), 100);
  assert.ok(detector.sample(ended(), 1300));
});

test('regeneration can remove old actions in the same batch as Stop activates', () => {
  const detector = new CompletionDetector();
  detector.sample(ui(), 0);
  detector.sample(ui({ generating: true, finished: false }), 10);
  detector.sample(ui(), 100);
  assert.ok(detector.sample(ui(), 1300));
});

test('Stop disappearance and timer alone are insufficient', () => {
  const detector = start();
  assert.equal(detector.sample(ended({ finished: false }), 100), null);
  assert.equal(detector.sample(ended({ finished: false }), 100_000), null);
  assert.equal(detector.state, 'GENERATING');
});

test('streaming and tool pauses cannot settle without finished actions', () => {
  const detector = start();
  for (const patch of [{ finished: false }, { streaming: true }]) {
    assert.equal(detector.sample(ended(patch), 100), null);
    assert.equal(detector.sample(ended(patch), 10_000), null);
  }
  assert.equal(detector.settling, false);
});

test('a response need not contain text; the tracker only needs UI evidence', () => {
  const detector = start();
  detector.sample(ended(), 100);
  assert.ok(detector.sample(ended(), 1300));
});

test('response mutations restart settling, unrelated snapshots do not', () => {
  const detector = start();
  detector.sample(ended(), 100);
  detector.sample(ended({ revision: 3 }), 1000);
  assert.equal(detector.sample(ended({ revision: 3 }), 1300), null);
  assert.equal(detector.settlingDelay(1300), 900);
  assert.ok(detector.sample(ended({ revision: 3 }), 2200));
});

test('generation resuming during settling cancels the pending completion', () => {
  const detector = start();
  detector.sample(ended(), 100);
  detector.sample(ended({ generating: true, finished: false, streaming: true }), 500);
  assert.equal(detector.state, 'GENERATING');
  detector.sample(ended(), 2000);
  assert.equal(detector.sample(ended(), 2500), null);
  assert.ok(detector.sample(ended(), 3200));
});

test('manual Stop is latched while control remains visible, and retry can succeed', () => {
  const detector = start();
  detector.cancel();
  detector.sample(ended({ generating: true, finished: false }), 100);
  assert.equal(detector.state, 'CANCELLED');
  assert.equal(detector.sample(ended(), 200), null);
  assert.equal(detector.sample(ended(), 2000), null);
  detector.sample(ended({ generating: true }), 3000);
  detector.sample(ended({ generating: true, finished: false, revision: 3 }), 3010);
  detector.sample(ended({ revision: 4 }), 4000);
  assert.ok(detector.sample(ended({ revision: 4 }), 5200));
});

test('errors during generation or settling remain silent', () => {
  for (const settleFirst of [true, false]) {
    const detector = start();
    if (settleFirst) detector.sample(ended(), 100);
    detector.sample(ended({ error: true }), 200);
    assert.equal(detector.sample(ended(), 5000), null);
    assert.equal(detector.sample(ended(), 10_000), null);
  }
});

test('navigation cancellation and replaced response tokens do not complete', () => {
  const detector = start();
  detector.sample(ended(), 100);
  detector.cancel();
  assert.equal(detector.sample(ended(), 5000), null);
  const replaced = start();
  assert.equal(replaced.sample(ended({ assistant: {} }), 2000), null);
  assert.equal(replaced.sample(ended({ assistant: {} }), 5000), null);
});

test('attaching mid-stream requires explicit streaming evidence on the existing response', () => {
  for (const streaming of [true, false]) {
    const detector = new CompletionDetector();
    detector.sample(ended({ generating: true, finished: false, streaming }), 0);
    detector.sample(ended(), 100);
    assert.equal(!!detector.sample(ended(), 1300), streaming);
  }
});

test('an existing historical toolbar cannot finish a new generation', () => {
  const detector = new CompletionDetector();
  detector.sample(ui({ generating: true }), 0);
  detector.sample(ui(), 100);
  assert.equal(detector.sample(ui(), 5000), null);
});

test('consecutive responses get different lifecycle IDs, with no global cooldown', () => {
  const detector = start();
  detector.sample(ended(), 100);
  const first = detector.sample(ended(), 1300);
  detector.sample(ended({ generating: true }), 1310);
  const next = {};
  detector.sample(ended({ generating: true, assistant: next, finished: false }), 1320);
  detector.sample(ended({ assistant: next }), 1330);
  const second = detector.sample(ended({ assistant: next }), 2530);
  assert.ok(first && second);
  assert.notEqual(first, second);
});

test('a later generation can recover from an ambiguous prior end', () => {
  const detector = start();
  detector.sample(ended({ finished: false }), 100);
  detector.sample(ended({ generating: true }), 500);
  const next = {};
  detector.sample(ended({ assistant: next, generating: true, finished: false }), 510);
  detector.sample(ended({ assistant: next }), 600);
  assert.ok(detector.sample(ended({ assistant: next }), 1800));
});

test('background-style delayed rechecks still validate current UI', () => {
  const detector = start();
  detector.sample(ended(), 100);
  assert.equal(detector.sample(ended({ error: true }), 60_000), null);
  const delayed = start();
  delayed.sample(ended(), 100);
  assert.ok(delayed.sample(ended(), 60_000));
});

test('two detectors maintain independent lifecycle state', () => {
  const first = start();
  const second = start();
  first.cancel();
  second.sample(ended(), 100);
  assert.ok(second.sample(ended(), 1300));
  assert.equal(first.sample(ended(), 1300), null);
});
