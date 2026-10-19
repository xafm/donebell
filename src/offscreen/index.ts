import { diagnostic } from '../content/diagnostics.ts';
import { readCustomSound } from '../shared/custom-sound.ts';
import {
  errorSummary, isPlaybackCommand, isPreviewCommand, type AudioResult,
} from '../shared/messages.ts';
import { isCustomSoundId, soundFile, type SoundId } from '../shared/sounds.ts';
import { loadMedia, playClip, releaseMedia, type Clip } from './player.ts';

// This ledger survives service-worker restarts for the lifetime of this document.
// There is no replay/retry in the content script if this document is later closed.
const events = new Map<string, Promise<AudioResult>>();
const MAX_EVENTS = 256;
let queue: Promise<unknown> = Promise.resolve();
// At most one preview plays; a newer preview or a real completion stops it.
let preview: AbortController | undefined;

// Custom files retain their existing fallback. A broken packaged sound reports
// failure rather than playing a chime under a misleading built-in sound label.
async function resolveClip(soundId: SoundId): Promise<{ clip: Clip; release(): void }> {
  const chime = { clip: { kind: 'chime' } as Clip, release() {} };
  if (soundId === 'original') return chime;
  let objectUrl: string | undefined;
  try {
    let url: string;
    if (isCustomSoundId(soundId)) {
      const custom = await readCustomSound(soundId);
      if (!custom) { diagnostic('Sound fallback', 'custom-missing'); return chime; }
      url = objectUrl = URL.createObjectURL(custom.blob);
    } else {
      const file = soundFile(soundId);
      if (!file) throw new Error('Packaged sound unavailable');
      url = chrome.runtime.getURL(`sounds/${file}`);
    }
    const element = await loadMedia(url);
    return {
      clip: { kind: 'media', element },
      release() {
        releaseMedia(element);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      },
    };
  } catch (error) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (!isCustomSoundId(soundId)) throw error;
    diagnostic('Sound fallback', `load ${errorSummary(error)}`);
    return chime;
  }
}

async function play(soundId: SoundId, volume: number, signal?: AbortSignal): Promise<AudioResult> {
  if (volume === 0) return { ok: true }; // Silent by request; no audio resources needed.
  let resolved: Awaited<ReturnType<typeof resolveClip>> | undefined;
  try {
    resolved = await resolveClip(soundId);
    return await playClip(resolved.clip, volume, signal) ? { ok: true } : { ok: false, reason: 'audio' };
  } catch {
    return { ok: false, reason: 'audio' }; // Never break the serialized queue.
  } finally {
    try { resolved?.release(); } catch { /* Nothing left to release. */ }
  }
}

function playPreview(soundId: SoundId, volume: number): Promise<AudioResult> {
  preview?.abort();
  const controller = new AbortController();
  preview = controller;
  return play(soundId, volume, controller.signal).finally(() => {
    if (preview === controller) preview = undefined;
  });
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const completion = isPlaybackCommand(message);
  if (!completion && !isPreviewCommand(message)) {
    // Content-script and popup messages also reach this document; only flag malformed audio commands.
    const type = (message as { type?: unknown } | null)?.type;
    if (type === 'PLAY_COMPLETION' || type === 'PLAY_PREVIEW') diagnostic('Command rejected', 'message-shape');
    return;
  }
  // Only our worker (no tab, expected worker URL if supplied) may authorize audio.
  // Content scripts and the popup share the extension ID, so checking that alone is insufficient.
  if (sender.id !== chrome.runtime.id || sender.tab ||
      (sender.url !== undefined && sender.url !== chrome.runtime.getURL('background/index.js'))) {
    diagnostic('Command rejected', sender.id !== chrome.runtime.id ? 'sender-extension' : sender.tab ? 'sender-tab' : 'sender-url');
    return;
  }
  if (!completion) {
    diagnostic('Preview accepted');
    void playPreview(message.soundId, message.volume).then(sendResponse);
    return true;
  }
  diagnostic('Command accepted');
  const { eventId, soundId, volume } = message;
  let result = events.get(eventId);
  if (!result) {
    result = queue.then(() => {
      preview?.abort(); // A real completion takes priority over a preview.
      return play(soundId, volume);
    });
    events.set(eventId, result); // Register before playback starts.
    queue = result;
    void result.then(() => {
      // Bound memory; never evict queued/in-flight entries.
      if (events.size > MAX_EVENTS) {
        for (const key of events.keys()) {
          if (key === eventId) break;
          events.delete(key);
          if (events.size <= MAX_EVENTS) break;
        }
      }
    });
  }
  void result.then(sendResponse);
  return true;
});
