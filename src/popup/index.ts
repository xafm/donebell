import {
  addCustomSound, deleteCustomSound, listCustomSounds, MAX_NAME_LENGTH, renameCustomSound, sanitizeFileName,
  sanitizeSoundName, type CustomSound,
} from '../shared/custom-sound.ts';
import { isPreviewResult, type PreviewRequest } from '../shared/messages.ts';
import { loadSettings, normalizeSettings, saveSettings, type DoneBellSettings } from '../shared/settings.ts';
import {
  availableSoundSelection, BUILT_IN_SOUNDS, DEFAULT_SOUND_ID, isCustomSoundId, type CustomSoundId, type SoundId,
} from '../shared/sounds.ts';
import { ImportError, prepareCustomSound } from './import.ts';

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

const ui = {
  enabled: byId<HTMLInputElement>('enabled'),
  sounds: byId<HTMLDivElement>('sounds'),
  builtins: byId<HTMLDivElement>('builtin-sounds'),
  customs: byId<HTMLDivElement>('custom-sounds'),
  selectionCount: byId<HTMLParagraphElement>('selection-count'),
  builtinCount: byId<HTMLSpanElement>('builtin-count'),
  customCount: byId<HTMLSpanElement>('custom-count'),
  add: byId<HTMLButtonElement>('add-sound'),
  error: byId<HTMLParagraphElement>('error'),
  file: byId<HTMLInputElement>('file'),
  volume: byId<HTMLInputElement>('volume'),
  volumeValue: byId<HTMLOutputElement>('volume-value'),
  backgroundOnly: byId<HTMLInputElement>('background-only'),
  row: byId<HTMLTemplateElement>('sound-row'),
};

let settings: DoneBellSettings = normalizeSettings({});
let customs: CustomSound[] = [];
let busy = false;
let previewToken = 0;
let volumeTimer: ReturnType<typeof setTimeout> | undefined;

function showError(message?: string): void {
  ui.error.textContent = message ?? '';
  ui.error.hidden = !message;
}

async function update(patch: Partial<DoneBellSettings>): Promise<void> {
  settings = { ...settings, ...patch };
  if (patch.selectedSoundIds) renderSelection();
  try {
    await saveSettings(patch);
  } catch {
    showError('Couldn’t save settings.');
  }
}

// Whether `ids` still selects a sound shown in the list.
function selectsListedSound(ids: readonly SoundId[]): boolean {
  return ids.some(id => !isCustomSoundId(id) || customs.some(sound => sound.id === id));
}

function toggle(id: SoundId, input: HTMLInputElement): void {
  const current = settings.selectedSoundIds;
  if (input.checked) {
    if (!current.includes(id)) void update({ selectedSoundIds: [...current, id] });
    return;
  }
  const next = current.filter(other => other !== id);
  if (!selectsListedSound(next)) { input.checked = true; return; } // At least one sound stays selected.
  void update({ selectedSoundIds: next });
}

function createRow(id: SoundId, name: string, custom?: CustomSound): HTMLElement {
  const row = ui.row.content.firstElementChild!.cloneNode(true) as HTMLElement;
  row.dataset.id = id;
  const input = row.querySelector('input')!;
  input.value = id;
  input.checked = settings.selectedSoundIds.includes(id);
  input.addEventListener('change', () => toggle(id, input));
  const label = row.querySelector<HTMLElement>('.name')!;
  label.textContent = name;
  label.title = name;
  const play = row.querySelector<HTMLButtonElement>('.play')!;
  play.title = 'Preview';
  play.setAttribute('aria-label', `Preview ${name}`);
  play.addEventListener('click', () => void preview(id, play));
  if (custom) {
    label.title = `${name}\n${custom.fileName}`;
    const rename = row.querySelector<HTMLButtonElement>('.rename')!;
    const remove = row.querySelector<HTMLButtonElement>('.remove')!;
    rename.hidden = remove.hidden = false;
    rename.disabled = remove.disabled = busy;
    rename.title = 'Rename';
    rename.setAttribute('aria-label', `Rename ${name}`);
    rename.addEventListener('click', () => startRename(row, custom));
    remove.title = 'Remove';
    remove.setAttribute('aria-label', `Remove ${name}`);
    remove.addEventListener('click', () => void removeSound(custom));
  }
  return row;
}

function renderSelection(): void {
  const selected = new Set(settings.selectedSoundIds);
  const builtinCount = BUILT_IN_SOUNDS.filter(sound => selected.has(sound.id)).length;
  const customCount = customs.filter(sound => selected.has(sound.id)).length;
  ui.selectionCount.textContent = `${builtinCount + customCount} selected`;
  ui.builtinCount.textContent = `${builtinCount} / ${BUILT_IN_SOUNDS.length} selected`;
  ui.customCount.textContent = `${customCount} / ${customs.length} selected`;
}

function renderSounds(target?: { id: SoundId; focusRename?: boolean }): void {
  const builtinRows = BUILT_IN_SOUNDS.map(sound => createRow(sound.id, sound.name));
  const customRows = customs.map(sound => createRow(sound.id, sound.name, sound));
  ui.builtins.replaceChildren(...builtinRows);
  ui.customs.replaceChildren(...customRows);
  ui.customs.hidden = customRows.length === 0;
  renderSelection();
  const rows = [...builtinRows, ...customRows];
  const row = target && rows.find(candidate => candidate.dataset.id === target.id);
  if (!row) return;
  row.scrollIntoView({ block: 'nearest' });
  if (target.focusRename) row.querySelector<HTMLButtonElement>('.rename')?.focus();
}

function renderVolume(): void {
  const volume = Number(ui.volume.value);
  ui.volumeValue.textContent = `${volume}%`;
  ui.volume.style.setProperty('--volume', `${volume}%`);
  ui.volume.closest('.volume')!.classList.toggle('muted', volume === 0);
}

function setBusy(value: boolean): void {
  busy = value;
  ui.add.disabled = value;
  for (const button of ui.sounds.querySelectorAll<HTMLButtonElement>('.rename, .remove')) button.disabled = value;
}

// Previews go through the worker to the shared offscreen player. They are a
// distinct message type and never resemble or create a completion event.
async function preview(soundId: SoundId, button: HTMLButtonElement): Promise<void> {
  const token = ++previewToken;
  for (const playing of ui.sounds.querySelectorAll('.play.playing')) playing.classList.remove('playing');
  button.classList.add('playing');
  showError();
  const request: PreviewRequest = { type: 'PREVIEW_SOUND', soundId, volume: Number(ui.volume.value) };
  let ok = false;
  try {
    const result: unknown = await chrome.runtime.sendMessage(request);
    ok = isPreviewResult(result) && result.ok;
  } catch { /* Reported below. */ }
  if (token !== previewToken) return; // A newer preview replaced this one.
  button.classList.remove('playing');
  if (!ok) showError('Preview couldn’t play.');
}

// Inline editor: Enter saves, Escape cancels, clicking away saves a valid change.
function startRename(row: HTMLElement, sound: CustomSound): void {
  if (busy || row.querySelector('.rename-input')) return;
  showError();
  const children = [...row.children] as HTMLElement[];
  const wasHidden = children.map(child => child.hidden);
  for (const child of children) child.hidden = true;
  const editor = document.createElement('input');
  editor.type = 'text';
  editor.className = 'rename-input';
  editor.maxLength = MAX_NAME_LENGTH;
  editor.value = sound.name;
  editor.spellcheck = false;
  editor.autocomplete = 'off';
  editor.setAttribute('aria-label', `Rename ${sound.name}`);
  row.append(editor);
  editor.focus();
  editor.select();

  let finished = false;
  const close = (name: string | null, keyboard: boolean): void => {
    finished = true;
    editor.remove();
    children.forEach((child, index) => { child.hidden = wasHidden[index]; });
    if (name) {
      row.querySelector('.name')!.textContent = name;
      void saveName(sound, name, keyboard);
    } else if (keyboard) {
      row.querySelector<HTMLButtonElement>('.rename')?.focus();
    }
  };
  editor.addEventListener('keydown', event => {
    if (finished || event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      showError();
      close(null, true);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const name = sanitizeSoundName(editor.value);
      if (!name) { showError('Name can’t be empty.'); return; }
      showError();
      close(name === sound.name ? null : name, true);
    }
  });
  editor.addEventListener('blur', () => {
    if (finished) return;
    const name = sanitizeSoundName(editor.value);
    showError();
    close(name && name !== sound.name ? name : null, false);
  });
}

// Changes only the stored display name; the ID, selection and Blob are untouched.
async function saveName(sound: CustomSound, name: string, keyboard: boolean): Promise<void> {
  setBusy(true);
  try {
    if (await renameCustomSound(sound.id, name)) {
      sound.name = name;
    } else {
      customs = customs.filter(other => other.id !== sound.id);
      showError('This sound no longer exists.');
    }
  } catch {
    showError('Couldn’t rename the sound.');
  } finally {
    setBusy(false);
    renderSounds(keyboard ? { id: sound.id, focusRename: true } : undefined);
  }
}

async function removeSound(sound: CustomSound): Promise<void> {
  setBusy(true);
  showError();
  try {
    await deleteCustomSound(sound.id);
    customs = customs.filter(other => other.id !== sound.id);
    const current = settings.selectedSoundIds;
    if (current.includes(sound.id)) {
      const next = current.filter(id => id !== sound.id);
      await update({ selectedSoundIds: selectsListedSound(next) ? next : [...next, DEFAULT_SOUND_ID] });
    }
  } catch {
    showError('Couldn’t remove the sound.');
  } finally {
    setBusy(false);
    renderSounds();
  }
  ui.add.focus();
}

ui.enabled.addEventListener('change', () => void update({ enabled: ui.enabled.checked }));
ui.backgroundOnly.addEventListener('change', () => void update({ backgroundOnly: ui.backgroundOnly.checked }));

ui.volume.addEventListener('input', () => {
  renderVolume();
  clearTimeout(volumeTimer);
  volumeTimer = setTimeout(() => void update({ volume: Number(ui.volume.value) }), 150);
});
ui.volume.addEventListener('change', () => {
  clearTimeout(volumeTimer);
  void update({ volume: Number(ui.volume.value) });
});

ui.add.addEventListener('click', () => ui.file.click());

// Each file is validated and stored in its own transaction, so one bad file or
// a full disk never affects sounds already saved. Imports are added to the
// selection without deselecting anything.
ui.file.addEventListener('change', async () => {
  const files = [...(ui.file.files ?? [])];
  ui.file.value = '';
  if (files.length === 0) return;
  setBusy(true);
  showError();
  const failures: string[] = [];
  let lastId: CustomSoundId | undefined;
  for (const file of files) {
    try {
      const sound = await prepareCustomSound(file);
      await addCustomSound(sound);
      customs.push(sound);
      lastId = sound.id;
      await update({ selectedSoundIds: [...settings.selectedSoundIds, sound.id] });
    } catch (error) {
      const quota = error instanceof DOMException && error.name === 'QuotaExceededError';
      const message = error instanceof ImportError ? error.message
        : quota ? 'Not enough storage space.' : 'Couldn’t import this file.';
      failures.push(files.length > 1 ? `${sanitizeFileName(file.name)}: ${message}` : message);
      if (quota) break;
    }
  }
  setBusy(false);
  renderSounds(lastId ? { id: lastId } : undefined);
  if (failures.length > 0) {
    showError(failures.length === 1 ? failures[0] : `${failures.length} files couldn’t be imported. ${failures[0]}`);
  }
});

async function init(): Promise<void> {
  settings = await loadSettings();
  try {
    customs = await listCustomSounds();
    // Selected custom sounds that no longer exist are dropped; if nothing
    // remains, the Original Chime is selected.
    const current = settings.selectedSoundIds;
    const existing = current.filter(id => !isCustomSoundId(id) || customs.some(sound => sound.id === id));
    if (existing.length !== current.length) {
      await update({ selectedSoundIds: existing.length > 0 ? existing : [DEFAULT_SOUND_ID] });
    }
  } catch {
    customs = [];
  }
  // A public build may share preferences with a local build. Show only shipped
  // built-ins and their effective selection, without saving over local choices.
  settings.selectedSoundIds = availableSoundSelection(settings.selectedSoundIds);
  ui.enabled.checked = settings.enabled;
  ui.backgroundOnly.checked = settings.backgroundOnly;
  ui.volume.value = String(settings.volume);
  renderVolume();
  renderSounds();
}

void init();
