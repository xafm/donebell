import { isCustomSoundId, LEGACY_CUSTOM_ID, type CustomSoundId } from './sounds.ts';

// Custom sounds, stored as Blobs in extension-origin IndexedDB. Shared by the
// popup (import/rename/remove), the worker (availability) and the offscreen
// document (playback).
export const MAX_CUSTOM_BYTES = 10 * 1024 * 1024;
export const MAX_CUSTOM_SECONDS = 15;
export const MAX_NAME_LENGTH = 60;
export const CUSTOM_TYPES = ['audio/mpeg', 'audio/wav'] as const;

// `name` is the editable display name; `fileName` is the sanitized original
// filename and never changes. `created` only orders the list.
export type CustomSound = {
  id: CustomSoundId; name: string; fileName: string; blob: Blob; duration: number; created: number;
};

const DB_NAME = 'donebell';
const DB_VERSION = 2;
const STORE = 'custom-sounds';
// Version 1: a single record under `current` in `custom-sound`.
const LEGACY_STORE = 'custom-sound';
const LEGACY_KEY = 'current';
// Legacy names were sanitized filenames of up to 80 characters; keep accepting them.
const MAX_STORED_NAME = 100;

const unsafeCharacters = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

function isLegacySound(value: unknown): value is { name: string; blob: Blob; duration: number } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string' && record.name.length > 0 && record.name.length <= MAX_STORED_NAME &&
    record.blob instanceof Blob && record.blob.size > 0 && record.blob.size <= MAX_CUSTOM_BYTES &&
    (CUSTOM_TYPES as readonly string[]).includes(record.blob.type) &&
    typeof record.duration === 'number' && record.duration > 0 && record.duration <= MAX_CUSTOM_SECONDS;
}

function isCustomSound(value: unknown): value is CustomSound {
  if (!isLegacySound(value)) return false;
  const record = value as Record<string, unknown>;
  return isCustomSoundId(record.id) &&
    typeof record.fileName === 'string' && record.fileName.length > 0 && record.fileName.length <= MAX_STORED_NAME &&
    typeof record.created === 'number' && Number.isFinite(record.created);
}

// Runs inside the versionchange transaction, which is atomic: the legacy store
// is dropped only in the same transaction that writes its replacement, so a
// failed upgrade leaves version 1 and its record untouched. Re-running is safe.
function upgrade(request: IDBOpenDBRequest): void {
  const db = request.result;
  const transaction = request.transaction!;
  const store = db.objectStoreNames.contains(STORE)
    ? transaction.objectStore(STORE) : db.createObjectStore(STORE, { keyPath: 'id' });
  if (!db.objectStoreNames.contains(LEGACY_STORE)) return;
  const legacy = transaction.objectStore(LEGACY_STORE).get(LEGACY_KEY);
  legacy.onsuccess = () => {
    const value: unknown = legacy.result;
    // A malformed legacy record was already unplayable (read as absent).
    if (isLegacySound(value)) {
      const record: CustomSound = {
        id: LEGACY_CUSTOM_ID, name: value.name, fileName: value.name,
        blob: value.blob, duration: value.duration, created: 0,
      };
      store.put(record);
    }
    db.deleteObjectStore(LEGACY_STORE);
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;
    request.onupgradeneeded = () => upgrade(request);
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; } // The caller already gave up.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error('Database blocked')); };
  });
}

// `run` queues requests and returns a getter for the result, read on commit so
// a write is durable before the caller relies on it.
async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => () => T): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const result = run(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(result());
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Transaction aborted'));
    });
  } finally {
    db.close();
  }
}

// Valid records in import order; malformed records are skipped, never deleted.
export async function listCustomSounds(): Promise<CustomSound[]> {
  const values = await transact('readonly', store => {
    const request = store.getAll();
    return () => request.result as unknown[];
  });
  return values.filter(isCustomSound).sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
}

// Missing or malformed records read as absent.
export async function readCustomSound(id: CustomSoundId): Promise<CustomSound | null> {
  const value = await transact('readonly', store => {
    const request = store.get(id);
    return () => request.result as unknown;
  });
  return isCustomSound(value) && value.id === id ? value : null;
}

// `add`, not `put`: an ID collision fails instead of overwriting another sound.
export async function addCustomSound(sound: CustomSound): Promise<void> {
  const record: CustomSound = {
    id: sound.id, name: sound.name, fileName: sound.fileName,
    blob: sound.blob, duration: sound.duration, created: sound.created,
  };
  await transact('readwrite', store => {
    store.add(record);
    return () => undefined;
  });
}

// Changes only the display name; returns false if the sound no longer exists.
export async function renameCustomSound(id: CustomSoundId, name: string): Promise<boolean> {
  return transact('readwrite', store => {
    let renamed = false;
    const request = store.get(id);
    request.onsuccess = () => {
      const value: unknown = request.result;
      if (!isCustomSound(value)) return;
      const record: CustomSound = { ...value, name };
      store.put(record);
      renamed = true;
    };
    return () => renamed;
  });
}

export async function deleteCustomSound(id: CustomSoundId): Promise<void> {
  await transact('readwrite', store => {
    store.delete(id);
    return () => undefined;
  });
}

function clean(text: string): string {
  return text.normalize('NFC').replace(unsafeCharacters, '').replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length > max ? `${characters.slice(0, max - 1).join('')}…` : text;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? '';
}

// Display-only filename: no path, control, or bidi-override characters; bounded length.
export function sanitizeFileName(name: string): string {
  return truncate(clean(baseName(name)), 80) || 'Custom sound';
}

// Default display name: the sanitized filename without its extension.
export function defaultSoundName(fileName: string): string {
  return truncate(clean(baseName(fileName).replace(/\.[a-z0-9]+$/i, '')), MAX_NAME_LENGTH) || 'Custom sound';
}

// A user-entered name, cleaned and capped; null when nothing usable remains.
export function sanitizeSoundName(name: string): string | null {
  const characters = Array.from(clean(name)).slice(0, MAX_NAME_LENGTH);
  return characters.join('').trim() || null;
}
