// Small deterministic DOM/event simulation for the production content script.
// It models only standard tree/attribute operations; no conversation text is used.
import type { TestContext } from 'node:test';

class Target {
  private listeners = new Map<string, Set<(event: Event) => void>>();
  addEventListener(type: string, listener: (event: Event) => void, options?: { signal?: AbortSignal }): void {
    const listeners = this.listeners.get(type) ?? new Set();
    this.listeners.set(type, listeners);
    listeners.add(listener);
    options?.signal?.addEventListener('abort', () => listeners.delete(listener));
  }
  emit(type: string, properties: object = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ type, isTrusted: true, ...properties } as Event);
    }
  }
}

export class FixtureElement extends Target {
  parent: FixtureElement | null = null;
  children: FixtureElement[] = [];
  disabled = false;
  display = 'block';
  visibility = 'visible';
  readonly tag: string;
  readonly attributes: Record<string, string>;
  constructor(tag: string, attributes: Record<string, string> = {}) {
    super();
    this.tag = tag;
    this.attributes = attributes;
  }
  get parentElement(): FixtureElement | null { return this.parent; }
  get isConnected(): boolean { return this.tag === 'body' || !!this.parent?.isConnected; }
  get href(): string { return this.attributes.href ?? ''; }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  removeAttribute(name: string): void { delete this.attributes[name]; }
  append(...elements: FixtureElement[]): void {
    for (const element of elements) {
      element.remove();
      element.parent = this;
      this.children.push(element);
    }
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  contains(element: FixtureElement): boolean {
    return element === this || this.children.some(child => child.contains(element));
  }
  matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const value = part.trim();
      const tag = value.match(/^[a-z]+/)?.[0];
      const attributes = [...value.matchAll(/\[([\w-]+)(?:([~^]?=)"([^"]*)")?\]/g)];
      const remainder = value.replace(/^[a-z]+/, '').replace(/\[[^\]]+\]/g, '');
      if (remainder || (!tag && !attributes.length)) throw new Error(`Unsupported fixture selector: ${part}`);
      return (!tag || this.tag === tag) && attributes.every(([, attribute, operator, expected]) =>
        operator === '~=' ? this.getAttribute(attribute)?.split(/\s+/).includes(expected) :
          operator === '^=' ? this.getAttribute(attribute)?.startsWith(expected) :
          operator === '=' ? this.getAttribute(attribute) === expected : this.getAttribute(attribute) !== null);
    });
  }
  closest(selector: string): FixtureElement | null {
    return this.matches(selector) ? this : this.parent?.closest(selector) ?? null;
  }
  querySelectorAll(selector: string): FixtureElement[] {
    return this.children.flatMap(child => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string): FixtureElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  getClientRects(): object[] {
    for (let node: FixtureElement | null = this; node; node = node.parent) {
      if (node.display === 'none') return [];
    }
    return this.isConnected ? [{}] : [];
  }
  compareDocumentPosition(other: FixtureElement): number {
    let root: FixtureElement = this;
    while (root.parent) root = root.parent;
    const order = (node: FixtureElement): FixtureElement[] => [node, ...node.children.flatMap(order)];
    const nodes = order(root);
    return nodes.indexOf(other) > nodes.indexOf(this) ? 4 : 2;
  }
}

export const element = (tag: string, attributes: Record<string, string> = {}) => new FixtureElement(tag, attributes);
export const action = (name: 'copy' | 'feedback' | 'retry') => element('button', {
  'data-testid': { copy: 'copy-turn-action-button', feedback: 'good-response-turn-action-button', retry: 'retry-button' }[name],
});

type RecordInput = { target: FixtureElement; type?: MutationRecordType; addedNodes?: FixtureElement[]; attributeName?: string };

export function contentFixture(t: TestContext, path = '/') {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  function replace(name: string, value: unknown): void {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const body = element('body');
  const main = element('main');
  body.append(main);
  const document = Object.assign(new Target(), { body, querySelector: (selector: string) => body.querySelector(selector) });
  const navigation = new Target();
  const window = Object.assign(new Target(), { navigation });
  const location = { pathname: path, origin: 'https://chatgpt.com', href: `https://chatgpt.com${path}` };
  const observers: Observer[] = [];
  class Observer {
    root: FixtureElement | null = null;
    options: MutationObserverInit = {};
    readonly callback: MutationCallback;
    constructor(callback: MutationCallback) { this.callback = callback; observers.push(this); }
    observe(root: FixtureElement, options: MutationObserverInit): void { this.root = root; this.options = options; }
    disconnect(): void { this.root = null; }
  }
  let now = 0;
  let timerId = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const messages: { cycleId: string; type: string }[] = [];
  const cycleIds: string[] = [];
  const randomUUID = crypto.randomUUID.bind(crypto);
  replace('crypto', { randomUUID: () => {
    const id = randomUUID();
    cycleIds.push(id);
    return id;
  } });
  replace('Element', FixtureElement);
  replace('Node', { DOCUMENT_POSITION_FOLLOWING: 4 });
  replace('document', document);
  replace('window', window);
  replace('location', location);
  replace('MutationObserver', Observer);
  replace('getComputedStyle', (node: FixtureElement) => ({ display: node.display, visibility: node.visibility }));
  replace('performance', { now: () => now });
  replace('setTimeout', (callback: () => void, delay: number) => {
    timers.set(++timerId, { callback, due: now + delay });
    return timerId;
  });
  replace('clearTimeout', (id: number) => timers.delete(id));
  replace('chrome', { runtime: { sendMessage: async (message: { cycleId: string; type: string }) => {
    messages.push(message);
    return { ok: true };
  } } });
  t.after(() => {
    window.emit('pagehide');
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  async function flush(records: RecordInput[], shellFirst = false): Promise<void> {
    for (const observer of shellFirst ? [...observers].reverse() : observers) {
      const relevant = records.filter(record => observer.root?.contains(record.target) &&
        (record.type !== 'attributes' || observer.options.attributes) &&
        (record.type !== 'characterData' || observer.options.characterData));
      if (relevant.length) observer.callback(relevant.map(record => ({
        type: 'childList', addedNodes: [], ...record,
      })) as unknown as MutationRecord[], observer as unknown as MutationObserver);
    }
    await Promise.resolve();
  }
  async function advance(ms: number): Promise<void> {
    now += ms;
    for (const [id, timer] of timers) {
      if (timer.due <= now) { timers.delete(id); timer.callback(); }
    }
    await Promise.resolve();
  }
  async function navigate(destination: string, options: {
    navigationType?: string; userInitiated?: boolean; sameDocument?: boolean; entryChange?: boolean;
  } = {}): Promise<void> {
    navigation.emit('navigate', {
      destination: { url: `https://chatgpt.com${destination}`, sameDocument: options.sameDocument ?? true },
      navigationType: options.navigationType ?? 'replace', userInitiated: options.userInitiated ?? false,
    });
    location.pathname = destination;
    location.href = `https://chatgpt.com${destination}`;
    if (options.entryChange !== false) navigation.emit('currententrychange');
    await Promise.resolve();
  }
  return { body, main, document, window, navigation, location, messages, cycleIds, observers, timers, flush, advance, navigate };
}
