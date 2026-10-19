// Built-in IDs come from the build catalog; persisted IDs must remain stable.
export type BuiltInSoundId = string;
// Custom IDs are opaque record keys, never file paths. The Phase 2 single slot
// keeps the ID `custom`; later imports are `custom:<lowercase v4 UUID>`.
export const LEGACY_CUSTOM_ID = 'custom';
export type CustomSoundId = typeof LEGACY_CUSTOM_ID | `custom:${string}`;
export type SoundId = BuiltInSoundId | CustomSoundId;
export type BuiltInSound = { id: BuiltInSoundId; name: string; file?: string };

export const DEFAULT_SOUND_ID: BuiltInSoundId = 'original';
export const DEFAULT_BUILT_IN_SOUNDS: readonly BuiltInSound[] = [
  { id: DEFAULT_SOUND_ID, name: 'Original Chime' },
];

// The build injects only the catalog it ships. Direct source imports use the
// public default and never read optional local assets.
declare const __DONEBELL_BUILT_IN_SOUNDS__: readonly BuiltInSound[];
export const BUILT_IN_SOUNDS: readonly BuiltInSound[] =
  typeof __DONEBELL_BUILT_IN_SOUNDS__ === 'undefined'
    ? DEFAULT_BUILT_IN_SOUNDS : __DONEBELL_BUILT_IN_SOUNDS__;
export const BUILT_IN_SOUND_IDS: readonly BuiltInSoundId[] = BUILT_IN_SOUNDS.map(sound => sound.id);

// Resolve unavailable built-ins in memory, without rewriting stored selections.
// The popup then displays the same effective selection the worker will play.
export function availableSoundSelection(selected: readonly SoundId[]): SoundId[] {
  const available = selected.filter(id => isCustomSoundId(id) || BUILT_IN_SOUNDS.some(sound => sound.id === id));
  return available.length > 0 ? available : [DEFAULT_SOUND_ID];
}

const customIdPattern = /^custom:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isBuiltInSoundId(value: unknown): value is BuiltInSoundId {
  return typeof value === 'string' && (BUILT_IN_SOUND_IDS as readonly string[]).includes(value);
}

export function isCustomSoundId(value: unknown): value is CustomSoundId {
  return typeof value === 'string' && (value === LEGACY_CUSTOM_ID || customIdPattern.test(value));
}

export function isSoundId(value: unknown): value is SoundId {
  return isBuiltInSoundId(value) || isCustomSoundId(value);
}

// Storage may contain IDs from another build. Preserve safe opaque IDs there,
// while messages and playback accept only the current catalog via isSoundId.
export function isStoredSoundId(value: unknown): value is SoundId {
  return isCustomSoundId(value) || (typeof value === 'string' && value.length <= 64 &&
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) && !/[^a-z0-9-]/.test(value));
}

export function newCustomSoundId(): CustomSoundId {
  return `custom:${crypto.randomUUID()}`;
}

export function soundFile(id: SoundId): string | undefined {
  return BUILT_IN_SOUNDS.find(sound => sound.id === id)?.file;
}
