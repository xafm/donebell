import { DEFAULT_SOUND_ID, isStoredSoundId, type SoundId } from './sounds.ts';

export type DoneBellSettings = {
  enabled: boolean;
  selectedSoundIds: SoundId[];
  volume: number;
  backgroundOnly: boolean;
};

export const DEFAULT_SETTINGS: Readonly<DoneBellSettings> = Object.freeze({
  enabled: true,
  selectedSoundIds: Object.freeze([DEFAULT_SOUND_ID]) as SoundId[],
  volume: 100,
  backgroundOnly: false,
});

// Bounds a corrupt or hostile array; far above any realistic library size.
const MAX_SELECTED = 1000;
// Phase 2 stored a single `soundId`; it is read only to migrate it.
const LEGACY_SOUND_KEY = 'soundId';
const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof DoneBellSettings)[];

export function isVolume(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100;
}

// Valid IDs in their first-seen order, without duplicates; empty if none survive.
export function normalizeSelection(value: unknown): SoundId[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<SoundId>();
  for (const id of value.slice(0, MAX_SELECTED)) if (isStoredSoundId(id)) ids.add(id);
  return [...ids];
}

// Each field falls back independently, so one corrupt value never resets the rest.
export function normalizeSettings(raw: Record<string, unknown>): DoneBellSettings {
  const volume = typeof raw.volume === 'number' && Number.isFinite(raw.volume)
    ? Math.min(100, Math.max(0, Math.round(raw.volume / 5) * 5)) : DEFAULT_SETTINGS.volume;
  const selected = normalizeSelection(raw.selectedSoundIds);
  const legacy = raw[LEGACY_SOUND_KEY];
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_SETTINGS.enabled,
    // The legacy custom slot keeps its `custom` ID in IndexedDB, so it maps directly.
    selectedSoundIds: selected.length > 0 ? selected : isStoredSoundId(legacy) ? [legacy] : [DEFAULT_SOUND_ID],
    volume,
    backgroundOnly: typeof raw.backgroundOnly === 'boolean' ? raw.backgroundOnly : DEFAULT_SETTINGS.backgroundOnly,
  };
}

export async function loadSettings(): Promise<DoneBellSettings> {
  try {
    return normalizeSettings(await chrome.storage.local.get([...KEYS, LEGACY_SOUND_KEY]));
  } catch {
    return normalizeSettings({});
  }
}

export async function saveSettings(patch: Partial<DoneBellSettings>): Promise<void> {
  await chrome.storage.local.set(patch);
}

// Install/update: persist only fields that are missing or need repair, so a
// selection changed concurrently in the popup is never overwritten. The legacy
// key is removed only after its replacement has been written.
export async function migrateSettings(): Promise<void> {
  const raw = await chrome.storage.local.get([...KEYS, LEGACY_SOUND_KEY]);
  const settings = normalizeSettings(raw);
  const patch: Record<string, unknown> = {};
  for (const key of KEYS) {
    if (JSON.stringify(raw[key]) !== JSON.stringify(settings[key])) patch[key] = settings[key];
  }
  if (Object.keys(patch).length > 0) await chrome.storage.local.set(patch);
  if (LEGACY_SOUND_KEY in raw) await chrome.storage.local.remove(LEGACY_SOUND_KEY);
}
