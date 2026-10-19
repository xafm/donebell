import type { ControlState, Snapshot } from './detector.ts';

// Composer-driven recognition, following the open-source Chat Dinger detector.
// Attribution and upstream MIT notice: THIRD_PARTY_NOTICES.md.
// Turkish labels are confirmed by the capture; English labels, composer
// attributes and icon paths are fallbacks. No message text or HTML is read.
const labels = {
  stop: ['Durdur', 'Stop', 'Stop generating', 'Stop streaming'],
  send: ['Gönder', 'Send', 'Send prompt', 'Send message'],
  voice: ['Sesli iletişimi başlat', 'Start voice', 'Start voice mode', 'Start voice conversation', 'Use voice mode'],
};
const lower = (values: readonly string[]) => new Set(values.map(value => value.toLowerCase()));
const stopLabels = lower(labels.stop);
const sendLabels = lower(labels.send);
const voiceLabels = lower(labels.voice);
const buttons = (values: readonly string[]) => values.map(label => `button[aria-label="${label}"]`);

// Exact 20×20 icon paths of the primary composer control (Chat Dinger capture,
// October 2026). They identify its state without a translated label.
const iconPaths: Record<'stop' | 'send' | 'voice', string> = {
  stop: 'M4.5 5.75C4.5 5.05964 5.05964 4.5 5.75 4.5H14.25C14.9404 4.5 15.5 5.05964 15.5 5.75V14.25C15.5 14.9404 14.9404 15.5 14.25 15.5H5.75C5.05964 15.5 4.5 14.9404 4.5 14.25V5.75Z',
  send: 'M9.33467 16.6663V4.93978L4.6374 9.63704L4.1667 9.16634L3.69599 8.69661L9.52998 2.86263L9.63447 2.77767C9.8925 2.60753 10.2433 2.63564 10.4704 2.86263L16.3034 8.69661L16.3884 8.80111C16.5588 9.05922 16.5306 9.40982 16.3034 9.63704C16.0762 9.86414 15.7255 9.89242 15.4675 9.722L15.363 9.63704L10.6647 4.9388V16.6663C10.6647 17.0336 10.367 17.3314 9.99971 17.3314C9.63259 17.3312 9.33467 17.0335 9.33467 16.6663ZM4.6374 9.63704C4.3777 9.89674 3.95569 9.89674 3.69599 9.63704C3.43657 9.37744 3.43668 8.95628 3.69599 8.69661L4.6374 9.63704Z',
  voice: 'M8.22266 2.45825C8.70579 2.45838 9.09766 2.85008 9.09766 3.33325V16.6663C9.09766 17.1494 8.70579 17.5411 8.22266 17.5413C7.73941 17.5413 7.34766 17.1495 7.34766 16.6663V3.33325C7.34766 2.85 7.73941 2.45825 8.22266 2.45825Z',
};

const editors = '#prompt-textarea, textarea[name="prompt-textarea"], [data-composer-markdown][contenteditable="true"], ' +
  'form textarea, form [contenteditable="true"], main textarea, main [contenteditable="true"][role="textbox"]';
const composerRoots = 'form, [data-composer-surface], [data-composer-footer-responsive]';
const primary = 'button.bg-composer-primary, button[data-composer-submit], #composer-submit-button, button.composer-submit-button-color';
const submit = 'button[data-composer-submit], #composer-submit-button, button[data-testid$="send-button"]';
const controls = [
  primary, 'button[data-stop-generating]', 'button[data-testid$="stop-button"]', 'button[data-testid$="send-button"]',
  'button[data-testid$="speech-button"]', '[data-start-voice]',
  ...buttons(labels.stop), ...buttons(labels.send), ...buttons(labels.voice),
].join(', ');
// Controls outside the composer must not come from responses, dialogs or media.
const foreign = 'dialog, [role="dialog"], audio, video, article, [data-message-author-role], ' +
  '[data-thread-find-target="conversation"], [role="region"][aria-label="Konuşma"], [role="region"][aria-label="Conversation"]';
// Supplementary activity: response status, streaming, Working, image progress.
// The detector only counts indicators that were absent while idle.
const busy = '[aria-busy="true"], [data-is-streaming="true"], [role="status"][aria-label="Working"], [role="progressbar"], ' +
  '[aria-label*="generating image" i], [aria-label*="creating image" i]';
const busyExcluded = 'dialog, [role="dialog"], nav, aside, [role="menu"], [role="tooltip"]';
const errors = '[data-testid="conversation-turn-error"], [data-testid="error-message"]';

export const observedAttributes = [
  'aria-label', 'aria-busy', 'aria-hidden', 'aria-disabled', 'disabled', 'hidden', 'role', 'class',
  'data-testid', 'data-state', 'data-is-streaming', 'data-stop-generating', 'data-start-voice', 'd',
];

function query(root: ParentNode, selector: string): Element[] {
  return [...root.querySelectorAll(selector)];
}

// No viewport intersection or tab visibility check: background tabs still qualify.
function rendered(element: Element): boolean {
  if (!element.isConnected || element.closest('[hidden], [aria-hidden="true"]')) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

function isPrimary(button: Element): boolean {
  return button.matches(primary) && !!button.closest(composerRoots);
}

function iconShown(button: Element, attribute: string): boolean {
  const span = button.querySelector(`[${attribute}]`);
  return !!span && !span.hasAttribute('hidden');
}

function primaryIcon(button: Element): keyof typeof iconPaths | null {
  if (!isPrimary(button)) return null;
  const paths = query(button, 'svg[viewBox="0 0 20 20"] path').map(path => path.getAttribute('d'));
  return (Object.keys(iconPaths) as (keyof typeof iconPaths)[]).find(kind => paths.includes(iconPaths[kind])) ?? null;
}

// Every Stop signal is checked before any idle signal.
function controlState(button: Element): { state: ControlState; method: string } {
  const testId = (button.getAttribute('data-testid') ?? '').toLowerCase();
  const label = (button.getAttribute('aria-label') ?? '').trim().toLowerCase();
  // The lightweight composer keeps one control for Send and Stop and names both states.
  const sendLabel = (button.getAttribute('data-send-label') ?? '').trim().toLowerCase();
  const stopLabel = (button.getAttribute('data-stop-label') ?? '').trim().toLowerCase();
  const labelsDiffer = !!sendLabel && !!stopLabel && sendLabel !== stopLabel;
  const icon = primaryIcon(button);
  if (button.hasAttribute('data-stop-generating') || testId.endsWith('stop-button')) return { state: 'stop', method: 'stop control' };
  if (labelsDiffer && label === stopLabel) return { state: 'stop', method: 'stop label attribute' };
  if (iconShown(button, 'data-composer-stop-icon')) return { state: 'stop', method: 'stop icon span' };
  if (icon === 'stop') return { state: 'stop', method: 'stop icon' };
  if (stopLabels.has(label)) return { state: 'stop', method: 'stop label' };
  if (icon === 'voice') return { state: 'idle', method: 'voice icon' };
  if (testId.endsWith('speech-button') || button.hasAttribute('data-start-voice') || voiceLabels.has(label)) {
    return { state: 'idle', method: 'voice control' };
  }
  if (labelsDiffer && label === sendLabel) return { state: 'idle', method: 'send label attribute' };
  if (iconShown(button, 'data-composer-send-icon')) return { state: 'idle', method: 'send icon span' };
  if (icon === 'send') return { state: 'idle', method: 'send icon' };
  if (testId.endsWith('send-button') || sendLabels.has(label)) return { state: 'idle', method: 'send control' };
  // An unrecognized primary composer control without a loading state. The
  // detector accepts it only after a Stop on the primary control this cycle.
  if (isPrimary(button) && !iconShown(button, 'data-composer-loading-icon') && button.getAttribute('aria-busy') !== 'true') {
    return { state: 'fallback', method: 'primary fallback' };
  }
  return { state: 'unknown', method: 'unknown control' };
}

function findComposer(): Element | null {
  const roots = query(document, editors).filter(rendered)
    .map(editor => editor.closest(composerRoots) ?? editor.parentElement)
    .filter((root): root is Element => !!root);
  // Canvas can show a second editor first; prefer the one holding a visible control.
  return roots.find(root => query(root, controls).some(rendered)) ?? roots[0] ?? null;
}

export type Control = { button: Element; state: ControlState; method: string; primary: boolean; composer: Element | null };

export function findControl(): Control | null {
  const composer = findComposer();
  let found = composer ? query(composer, controls) : [];
  if (!found.some(rendered)) {
    found = [...new Set([...found, ...query(document, controls).filter(button => rendered(button) && !button.closest(foreign))])];
  }
  const states = new Map(found.map(button => [button, controlState(button)]));
  // A hidden Send control inside the composer can become Stop without a new element.
  const candidates = found.filter(button => rendered(button) ||
    (!!composer?.contains(button) && button.matches(submit) && states.get(button)!.state === 'idle'));
  const button = candidates.find(button => rendered(button) && states.get(button)!.state === 'stop') ??
    candidates.find(button => states.get(button)!.state === 'idle') ??
    candidates.find(button => states.get(button)!.state === 'fallback');
  return button ? { button, ...states.get(button)!, primary: isPrimary(button), composer } : null;
}

export function readUI(): { snapshot: Snapshot; control: Control | null } {
  const control = findControl();
  const scope = document.querySelector('main') ?? document;
  return {
    control,
    snapshot: {
      control: control?.state ?? 'unknown',
      primary: !!control?.primary,
      busy: query(scope, busy).filter(element => !element.closest(busyExcluded) &&
        !control?.composer?.contains(element) && rendered(element)),
      errors: query(document, errors).filter(rendered),
    },
  };
}

export function isStopTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const button = target.closest('button');
  const control = button ? findControl() : null;
  return !!control && control.button === button && control.state === 'stop' &&
    !(button as HTMLButtonElement).disabled && button!.getAttribute('aria-disabled') !== 'true';
}
