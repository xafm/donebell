import {
  defaultSoundName, MAX_CUSTOM_BYTES, MAX_CUSTOM_SECONDS, sanitizeFileName, type CustomSound,
} from '../shared/custom-sound.ts';
import { newCustomSoundId } from '../shared/sounds.ts';

export class ImportError extends Error {}

const FORMATS = {
  mp3: { type: 'audio/mpeg', mimes: ['audio/mpeg', 'audio/mp3', 'audio/mpeg3', 'audio/x-mpeg-3'] },
  wav: { type: 'audio/wav', mimes: ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'] },
} as const;

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function hasSignature(format: keyof typeof FORMATS, bytes: Uint8Array): boolean {
  if (format === 'wav') return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE';
  // An ID3v2 tag, or a bare MPEG audio frame sync.
  return ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
}

// Accepts a local MP3/WAV only after it decodes within the size and length limits.
// Nothing leaves the browser; the file path is never read or stored.
export async function prepareCustomSound(file: File): Promise<CustomSound> {
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1].toLowerCase();
  const format = extension === 'mp3' || extension === 'wav' ? extension : null;
  if (!format || (file.type && !(FORMATS[format].mimes as readonly string[]).includes(file.type))) {
    throw new ImportError('Choose an MP3 or WAV file.');
  }
  if (file.size === 0) throw new ImportError('This file is empty.');
  if (file.size > MAX_CUSTOM_BYTES) throw new ImportError('File must be 10 MB or smaller.');
  const data = await file.arrayBuffer();
  if (!hasSignature(format, new Uint8Array(data, 0, Math.min(12, data.byteLength)))) {
    throw new ImportError(`Not a valid ${format.toUpperCase()} file.`);
  }
  // Copy before decoding: decodeAudioData detaches its input buffer.
  const blob = new Blob([data], { type: FORMATS[format].type });
  let duration: number;
  try {
    duration = (await new OfflineAudioContext(1, 1, 44100).decodeAudioData(data)).duration;
  } catch {
    throw new ImportError('This file couldn’t be decoded.');
  }
  if (!(duration > 0)) throw new ImportError('This file couldn’t be decoded.');
  if (duration > MAX_CUSTOM_SECONDS) throw new ImportError('Sound must be 15 seconds or shorter.');
  return {
    id: newCustomSoundId(), name: defaultSoundName(file.name), fileName: sanitizeFileName(file.name),
    blob, duration, created: Date.now(),
  };
}
