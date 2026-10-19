import { diagnostic } from '../content/diagnostics.ts';
import { errorSummary } from '../shared/messages.ts';

// One playback engine for completions and previews. Every request gets its own
// AudioContext, routed through a master gain, and releases it afterwards.
export type Clip = { kind: 'chime' } | { kind: 'media'; element: HTMLAudioElement };

const RESUME_TIMEOUT_MS = 1500;
const LOAD_TIMEOUT_MS = 3000;
const CHIME_TIMEOUT_MS = 2500;
const END_SLACK_MS = 2500;
const MAX_MEDIA_MS = 16_000; // Custom sounds are limited to 15 s at import.

function bounded<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

// Loads a local file (packaged extension URL or blob: URL) without playing it.
// Media elements are used because the extension CSP forbids fetch().
export async function loadMedia(url: string): Promise<HTMLAudioElement> {
  const element = new Audio();
  element.preload = 'auto';
  element.loop = false;
  try {
    await bounded(new Promise<void>((resolve, reject) => {
      element.oncanplaythrough = () => resolve();
      element.onerror = () => reject(new Error('Audio load failed'));
      element.src = url;
    }), LOAD_TIMEOUT_MS, 'Audio load timed out');
  } catch (error) {
    releaseMedia(element);
    throw error;
  } finally {
    element.oncanplaythrough = element.onerror = null;
  }
  return element;
}

export function releaseMedia(element: HTMLAudioElement): void {
  element.onended = element.onerror = null;
  element.pause();
  element.removeAttribute('src');
  element.load();
}

function stopped(signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (!signal) return;
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

// Resolves true when the clip finished or was deliberately stopped via `signal`.
export async function playClip(clip: Clip, volume: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return true;
  let context: AudioContext | undefined;
  const oscillators: OscillatorNode[] = [];
  const nodes: AudioNode[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stage = 'context-create';
  try {
    context = new AudioContext();
    if (context.state === 'suspended') {
      stage = 'context-resume';
      // resume() may remain pending under autoplay policy; bound the attempt.
      await bounded(context.resume(), RESUME_TIMEOUT_MS, 'Audio resume timed out');
    }
    stage = `context-${context.state}`;
    if (context.state !== 'running') throw new Error('Audio context unavailable');
    if (signal?.aborted) return true;
    stage = 'playback';
    // Linear master gain: 100% is unity, so the Original Chime is unchanged.
    const master = context.createGain();
    master.gain.value = volume / 100;
    master.connect(context.destination);
    nodes.push(master);
    let ended: Promise<void>;
    if (clip.kind === 'chime') {
      const start = context.currentTime + 0.015;
      for (const [offset, frequency] of [[0, 659.25], [0.18, 880]] as const) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillators.push(oscillator);
        nodes.push(gain);
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start + offset);
        gain.gain.linearRampToValueAtTime(0.13, start + offset + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, start + offset + 0.32);
        gain.gain.setValueAtTime(0, start + offset + 0.34);
        oscillator.connect(gain);
        gain.connect(master);
        oscillator.start(start + offset);
        oscillator.stop(start + offset + 0.35);
      }
      ended = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Audio completion timed out')), CHIME_TIMEOUT_MS);
        oscillators[1].onended = () => resolve();
      });
    } else {
      const { element } = clip;
      const source = context.createMediaElementSource(element);
      source.connect(master);
      nodes.push(source);
      // The timeout follows the file's own length (bounded), not the chime's.
      const duration = Number.isFinite(element.duration) && element.duration > 0
        ? Math.min(element.duration * 1000, MAX_MEDIA_MS) : MAX_MEDIA_MS;
      ended = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Audio completion timed out')), duration + END_SLACK_MS);
        element.onended = () => resolve();
        element.onerror = () => reject(new Error('Audio playback failed'));
      });
      stage = 'media-play';
      await element.play();
      stage = 'playback';
    }
    await Promise.race([ended, stopped(signal)]);
    stage = 'playback-end';
    if (!signal?.aborted && context.state !== 'running') throw new Error('Audio context interrupted');
    return true;
  } catch (error) {
    diagnostic('Sound failed', `${stage} ${errorSummary(error)}`);
    console.warn('[DoneBell] Sound playback failed.');
    return false;
  } finally {
    clearTimeout(timer);
    if (clip.kind === 'media') clip.element.pause();
    for (const oscillator of oscillators) {
      try { oscillator.stop(); } catch { /* Already stopped. */ }
    }
    for (const node of nodes) node.disconnect();
    if (context && context.state !== 'closed') {
      try { await context.close(); } catch { /* No resources to reuse. */ }
    }
  }
}
