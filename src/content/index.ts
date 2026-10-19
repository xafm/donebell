import { diagnostic } from './diagnostics.ts';
import { CompletionDetector } from './detector.ts';
import { errorSummary, isPlaybackResult, isSkipped, type CompletionEvent } from '../shared/messages.ts';
import { observedAttributes, readUI, findControl, isStopTarget } from './selectors.ts';

// A conversation URL. Home, `/c/new` and project pages are creation routes.
function conversationRoute(path: string): boolean {
  return /(?:^|\/)c\/[^/]+$/.test(path) && !/(?:^|\/)c\/new$/.test(path);
}

function startDetection(): () => void {
  const detector = new CompletionDetector();
  diagnostic('Detector initialized');
  const listeners = new AbortController();
  let route = location.pathname;
  let stopped = false;
  let pending = false;
  let recognized = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let promotion: { path: string; cycleId: string } | null = null;

  function clearSettling(): void {
    clearTimeout(settleTimer);
    settleTimer = undefined;
  }

  function invalidate(reason: string): void {
    // Without a cycle there is nothing to cancel. Latching here would swallow
    // a generation whose Stop appears after ChatGPT assigns the new chat URL.
    if (detector.active) detector.cancel(reason);
    clearSettling();
    promotion = null;
  }

  function routeChanged(): void {
    if (location.pathname === route) return;
    // A non-user chat URL assignment keeps only the cycle it was granted to.
    const sameGeneration = promotion?.path === location.pathname && detector.activeCycleId === promotion.cycleId;
    if (!sameGeneration) invalidate('conversation navigation');
    route = location.pathname;
    promotion = null;
  }

  async function deliver(cycleId: string): Promise<void> {
    diagnostic('Playback requested');
    const message: CompletionEvent = { type: 'RESPONSE_COMPLETED', cycleId };
    try {
      // One attempt. An ambiguous transport failure must not replay a sound that
      // might already have played. runtime.sendMessage wakes the worker normally.
      const result: unknown = await chrome.runtime.sendMessage(message);
      // No response means the worker rejected the event (see its console for the reason code).
      diagnostic('Playback result', !isPlaybackResult(result)
        ? (result === undefined ? 'worker-rejected' : 'invalid-response')
        : result.ok ? 'success' : isSkipped(result) ? `skipped-${result.reason}`
        : result.reason === 'audio' ? 'audio-failed' : 'offscreen-delivery-failed');
      // Intentional skips (disabled, Background Only) are not failures.
      if (!isPlaybackResult(result) || (!result.ok && !isSkipped(result))) console.warn('[DoneBell] Completion audio unavailable.');
    } catch (error) {
      diagnostic('Playback result', `delivery failed ${errorSummary(error)}`);
      console.warn('[DoneBell] Completion delivery failed.');
    }
  }

  function sample(): void {
    pending = false;
    if (stopped) return;
    try {
      routeChanged();
      const { snapshot, control } = readUI();
      if (!recognized && control && control.state !== 'unknown') {
        recognized = true;
        diagnostic('Composer recognized', control.method);
      }
      const cycleId = detector.sample(snapshot, performance.now());
      clearSettling();
      if (cycleId) void deliver(cycleId);
      if (detector.settling) {
        // Throttling can delay this recheck; it can never bypass UI validation.
        settleTimer = setTimeout(sample, detector.settlingDelay(performance.now()));
      }
    } catch {
      invalidate('UI inspection failure');
      console.warn('[DoneBell] Detection paused after a UI inspection failure.');
    }
  }

  function schedule(): void {
    if (pending || stopped) return;
    pending = true;
    queueMicrotask(sample); // Batch mutation records without a foreground-only animation frame.
  }

  // The composer can live outside `main`, so observe the document. Only control
  // attributes are watched; text mutations are ignored.
  const observer = new MutationObserver(schedule);

  function onInteraction(event: Event): void {
    if (!event.isTrusted) return;
    // Capture before ChatGPT removes the Stop control, including keyboard clicks.
    // Manual Stop always latches, even if the composer is idle immediately after.
    if (isStopTarget(event.target)) {
      detector.cancel('manual Stop');
      clearSettling();
      promotion = null;
      return;
    }
    if (event.type === 'click' && event.target instanceof Element) {
      const link = event.target.closest<HTMLAnchorElement>('a[href]');
      if (!link || (link.target && link.target !== '_self')) return;
      const url = new URL(link.href, location.href);
      if (url.origin === location.origin && url.pathname !== route) invalidate('conversation navigation');
    }
  }

  document.addEventListener('pointerdown', onInteraction, { capture: true, signal: listeners.signal });
  document.addEventListener('click', onInteraction, { capture: true, signal: listeners.signal });
  document.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') onInteraction(event);
  }, { capture: true, signal: listeners.signal });

  // Browser-owned Navigation API covers pushState/replaceState without patching
  // ChatGPT's history methods or entering its main JavaScript world.
  type NavigationEvent = Event & {
    destination: { url: string; sameDocument?: boolean };
    navigationType: string;
    userInitiated: boolean;
  };
  const navigation = (window as Window & { navigation?: EventTarget }).navigation;
  navigation?.addEventListener('navigate', event => {
    const nav = event as NavigationEvent;
    const destination = new URL(nav.destination.url);
    // A navigate event can precede the observer's queued sample.
    sample();
    if (destination.origin !== location.origin || nav.destination.sameDocument === false ||
        nav.navigationType === 'reload' || nav.navigationType === 'traverse') { invalidate('conversation navigation or reload'); return; }
    if (destination.pathname === route) return;
    const cycleId = detector.activeCycleId;
    // ChatGPT assigns a new chat its URL while the first reply is generating.
    if (!conversationRoute(route) && conversationRoute(destination.pathname) && !nav.userInitiated &&
        (nav.navigationType === 'replace' || nav.navigationType === 'push') &&
        cycleId && findControl()?.state === 'stop') {
      promotion = { path: destination.pathname, cycleId };
    } else invalidate('conversation navigation');
  }, { signal: listeners.signal });
  navigation?.addEventListener('currententrychange', () => { routeChanged(); schedule(); }, { signal: listeners.signal });
  window.addEventListener('popstate', () => { invalidate('history navigation'); routeChanged(); schedule(); }, { signal: listeners.signal });

  function shutdown(): void {
    stopped = true;
    invalidate('page exit');
    observer.disconnect();
    listeners.abort();
  }

  try {
    observer.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, attributeFilter: observedAttributes,
    });
    schedule();
  } catch {
    shutdown();
    console.warn('[DoneBell] Observer initialization failed.');
  }
  return shutdown;
}

let shutdown = startDetection();
window.addEventListener('pagehide', () => shutdown());
// A BFCache restoration gets a fresh observer and idle baseline; no page reload.
window.addEventListener('pageshow', event => {
  if (event.persisted) { shutdown(); shutdown = startDetection(); }
});
