import { diagnostic } from '../content/diagnostics.ts';
import {
  errorSummary, isAudioResult, isCompletionEvent, isDocumentId, isPreviewRequest,
  type PlaybackCommand, type PlaybackResult, type PreviewCommand, type PreviewRequest, type PreviewResult,
} from '../shared/messages.ts';
import { listCustomSounds } from '../shared/custom-sound.ts';
import { loadSettings, migrateSettings } from '../shared/settings.ts';
import { availableSoundSelection, DEFAULT_SOUND_ID, isCustomSoundId, type SoundId } from '../shared/sounds.ts';

const offscreenPath = 'offscreen/offscreen.html';
const popupPath = 'popup/popup.html';
let creating: Promise<void> | undefined;
const pending = new Map<string, Promise<PlaybackResult>>();

// Persist defaults, migrate the Phase 2 `soundId`, and repair corrupt fields once
// on install/update, without overwriting valid stored values. Reads also
// normalize, so this is not required for correctness.
chrome.runtime.onInstalled.addListener(() => {
  void migrateSettings().catch(() => diagnostic('Settings migration failed'));
});

async function ensureOffscreen(): Promise<void> {
  if (creating) return creating;
  creating = (async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [chrome.runtime.getURL(offscreenPath)],
    });
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: offscreenPath,
        reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: 'Play a short local notification sound for a confirmed ChatGPT response completion.',
      });
    }
  })();
  try { await creating; } finally { creating = undefined; }
}

// Returns a safe rejection code, or null for the ChatGPT top-frame content script.
function senderRejection(sender: chrome.runtime.MessageSender): string | null {
  if (sender.id !== chrome.runtime.id) return 'extension';
  if (sender.frameId !== 0) return 'frame';
  if (!Number.isInteger(sender.tab?.id) || sender.tab!.id! < 0) return 'tab';
  if (!isDocumentId(sender.documentId)) return 'document';
  try {
    return sender.origin === 'https://chatgpt.com' &&
      new URL(sender.url ?? '').origin === 'https://chatgpt.com' ? null : 'origin';
  } catch { return 'origin'; }
}

// Only the extension's own action popup (an extension page without a tab) may preview.
function isPopupSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || sender.tab || typeof sender.url !== 'string') return false;
  const extensionOrigin = chrome.runtime.getURL('').replace(/\/$/, '');
  return sender.url.split(/[?#]/)[0] === chrome.runtime.getURL(popupPath) &&
    (sender.origin === undefined || sender.origin === extensionOrigin);
}

async function sendToOffscreen(command: PlaybackCommand | PreviewCommand): Promise<PreviewResult> {
  let stage = 'offscreen-create';
  try {
    await ensureOffscreen(); // Check every time: Chrome can close idle audio documents.
    stage = 'offscreen-message';
    const result: unknown = await chrome.runtime.sendMessage(command);
    if (!isAudioResult(result)) {
      diagnostic('Offscreen delivery failed', `offscreen-ack ${result === undefined ? 'missing' : 'invalid'}`);
      console.warn('[DoneBell] Offscreen audio delivery failed.');
      return { ok: false, reason: 'delivery' };
    }
    diagnostic('Offscreen result', result.ok ? 'success' : result.reason);
    return result;
  } catch (error) {
    // No automatic re-send after an ambiguous failure: it could duplicate audio.
    diagnostic('Offscreen delivery failed', `${stage} ${errorSummary(error)}`);
    console.warn('[DoneBell] Offscreen audio delivery failed.');
    return { ok: false, reason: 'delivery' };
  }
}

// Uniform index in [0, length) from the browser CSPRNG, by rejection sampling.
function randomIndex(length: number): number {
  if (length <= 1) return 0;
  const limit = Math.floor(0x1_0000_0000 / length) * length;
  const value = new Uint32Array(1);
  do crypto.getRandomValues(value); while (value[0] >= limit);
  return value[0] % length;
}

// Picks one selected sound for one completion. Custom sounds whose records are
// missing or invalid are excluded; if the store cannot be read, they stay
// eligible and the offscreen document falls back to the Original Chime.
async function chooseSound(selected: readonly SoundId[]): Promise<SoundId> {
  let candidates = availableSoundSelection(selected);
  if (candidates.some(isCustomSoundId)) {
    try {
      const available = new Set<string>((await listCustomSounds()).map(sound => sound.id));
      candidates = candidates.filter(id => !isCustomSoundId(id) || available.has(id));
    } catch (error) {
      diagnostic('Custom sounds unreadable', errorSummary(error));
    }
  }
  if (candidates.length === 0) { diagnostic('Sound fallback', 'no-valid-selection'); return DEFAULT_SOUND_ID; }
  diagnostic('Sound chosen', `${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`);
  return candidates[randomIndex(candidates.length)];
}

async function forward(eventId: string, tab: chrome.tabs.Tab): Promise<PlaybackResult> {
  // Read the latest preferences for every completion; storage failure yields defaults.
  const settings = await loadSettings();
  if (!settings.enabled) { diagnostic('Completion skipped', 'disabled'); return { ok: false, reason: 'disabled' }; }
  // `tab.active` is the sender tab's state when the completion was sent.
  if (settings.backgroundOnly && tab.active) {
    diagnostic('Completion skipped', 'active-tab');
    return { ok: false, reason: 'background' };
  }
  // Chosen exactly once per event: `pending` coalesces duplicates in this worker,
  // and the offscreen ledger keys on `eventId`, so a later duplicate never replays.
  const soundId = await chooseSound(settings.selectedSoundIds);
  return sendToOffscreen({ type: 'PLAY_COMPLETION', eventId, soundId, volume: settings.volume });
}

function preview(request: PreviewRequest): Promise<PreviewResult> {
  // Previews ignore `enabled` and `backgroundOnly`, and use the popup's current volume.
  return sendToOffscreen({ type: 'PLAY_PREVIEW', soundId: request.soundId, volume: request.volume });
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isPreviewRequest(message)) {
    if (!isPopupSender(sender)) { diagnostic('Preview rejected', 'sender'); return; }
    diagnostic('Preview accepted');
    void preview(message).then(sendResponse);
    return true;
  }
  if (!isCompletionEvent(message)) { diagnostic('Completion rejected', 'message-shape'); return; }
  const rejection = senderRejection(sender);
  if (rejection) { diagnostic('Completion rejected', `sender-${rejection}`); return; }
  diagnostic('Completion accepted');
  // Browser-provided tab/document identity prevents cross-tab collisions. Neither
  // routes nor ChatGPT message IDs are forwarded to the audio document.
  const eventId = `${sender.tab!.id}:${sender.documentId}:${message.cycleId}`;
  let request = pending.get(eventId);
  if (!request) {
    request = forward(eventId, sender.tab!);
    pending.set(eventId, request);
    void request.finally(() => pending.delete(eventId));
  }
  void request.then(sendResponse);
  return true; // Chrome 116-compatible asynchronous response, no permanent port.
});
