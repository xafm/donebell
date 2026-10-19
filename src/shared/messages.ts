import { isVolume } from './settings.ts';
import { isSoundId, type SoundId } from './sounds.ts';

// Content script -> worker: unchanged from Phase 1 (no preferences, no audio).
export type CompletionEvent = { type: 'RESPONSE_COMPLETED'; cycleId: string };
// Worker -> offscreen: a real completion with the worker-resolved preferences.
export type PlaybackCommand = { type: 'PLAY_COMPLETION'; eventId: string; soundId: SoundId; volume: number };
// Popup -> worker, then worker -> offscreen. Previews never carry an event ID,
// so they cannot enter or consume the completion ledger.
export type PreviewRequest = { type: 'PREVIEW_SOUND'; soundId: SoundId; volume: number };
export type PreviewCommand = { type: 'PLAY_PREVIEW'; soundId: SoundId; volume: number };

export type SkipReason = 'disabled' | 'background';
export type FailureReason = 'audio' | 'delivery';
// Offscreen acknowledgements are only `{ ok: true }` or an audio failure.
export type AudioResult = { ok: true } | { ok: false; reason: 'audio' };
export type PreviewResult = { ok: true } | { ok: false; reason: FailureReason };
export type PlaybackResult = { ok: true } | { ok: false; reason: FailureReason | SkipReason };

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const cyclePattern = new RegExp(`^${uuid}$`);
// Chrome serializes MessageSender.documentId as a 32-digit hex token (no hyphens).
// The hyphenated UUID form is still accepted for older fixtures.
const documentId = '(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})';
const documentIdPattern = new RegExp(`^${documentId}$`);
const eventPattern = new RegExp(`^\\d+:${documentId}:${uuid}$`);

function exactRecord(value: unknown, type: string, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  return actual.length === keys.length + 1 && record.type === type && keys.every(key => actual.includes(key));
}

function exactMessage(value: unknown, type: string, field: string): value is Record<string, unknown> {
  return exactRecord(value, type, [field]) && typeof value[field] === 'string';
}

function soundMessage(value: unknown, type: string, extra: readonly string[] = []): value is Record<string, unknown> {
  return exactRecord(value, type, ['soundId', 'volume', ...extra]) && isSoundId(value.soundId) && isVolume(value.volume);
}

export function isCompletionEvent(value: unknown): value is CompletionEvent {
  return exactMessage(value, 'RESPONSE_COMPLETED', 'cycleId') && cyclePattern.test(value.cycleId as string);
}

export function isDocumentId(value: unknown): value is string {
  return typeof value === 'string' && documentIdPattern.test(value);
}

export function isPlaybackCommand(value: unknown): value is PlaybackCommand {
  return soundMessage(value, 'PLAY_COMPLETION', ['eventId']) &&
    typeof value.eventId === 'string' && eventPattern.test(value.eventId);
}

export function isPreviewRequest(value: unknown): value is PreviewRequest {
  return soundMessage(value, 'PREVIEW_SOUND');
}

export function isPreviewCommand(value: unknown): value is PreviewCommand {
  return soundMessage(value, 'PLAY_PREVIEW');
}

function isResult(value: unknown, reasons: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  return (result.ok === true && Object.keys(result).length === 1) ||
    (result.ok === false && Object.keys(result).length === 2 && reasons.includes(result.reason as string));
}

export function isAudioResult(value: unknown): value is AudioResult {
  return isResult(value, ['audio']);
}

export function isPreviewResult(value: unknown): value is PreviewResult {
  return isResult(value, ['audio', 'delivery']);
}

export function isPlaybackResult(value: unknown): value is PlaybackResult {
  return isResult(value, ['audio', 'delivery', 'disabled', 'background']);
}

// Intentional skips are normal outcomes, not failures.
export function isSkipped(result: PlaybackResult): boolean {
  return !result.ok && (result.reason === 'disabled' || result.reason === 'background');
}

// Debug diagnostics only: an error name plus a fixed reason code, never the message text.
export function errorSummary(error: unknown): string {
  const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : typeof error;
  const message = error instanceof Error ? error.message : '';
  const reason = /Receiving end does not exist/i.test(message) ? 'no-receiver'
    : /message port closed/i.test(message) ? 'no-response'
    : /single offscreen/i.test(message) ? 'offscreen-exists'
    : /context invalidated/i.test(message) ? 'context-invalidated'
    : /timed out/i.test(message) ? 'timeout'
    : 'other';
  return `${name}/${reason}`;
}
