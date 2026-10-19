import { diagnostic } from './diagnostics.ts';

// UI recognition stays outside this state machine. Busy indicators and errors
// are DOM object identities, never conversation/message IDs or text.
export type State = 'IDLE' | 'GENERATING' | 'SETTLING' | 'COMPLETED' | 'CANCELLED';
export type ControlState = 'stop' | 'idle' | 'fallback' | 'unknown';
export type Snapshot = {
  control: ControlState;
  primary: boolean;
  busy: readonly object[];
  errors: readonly object[];
};

export const SETTLING_MS = 1200;

export class CompletionDetector {
  state: State = 'IDLE';
  private cycleId: string | null = null;
  private stableSince = 0;
  private primaryStop = false;
  private idleBusy = new Set<object>();
  private held = new Set<object>();
  private previousErrors = new Set<object>();
  private noted = new Set<string>();

  // Cancellation stays latched until the composer is positively idle again, so a
  // lingering Stop or later mutation cannot rearm a manually stopped cycle.
  cancel(reason = 'interrupted generation'): void {
    if (this.state !== 'CANCELLED') diagnostic('Cancelled', reason);
    this.state = 'CANCELLED';
    this.cycleId = null;
  }

  reset(): void {
    this.state = 'IDLE';
    this.cycleId = null;
    this.primaryStop = false;
    this.held.clear();
    this.noted.clear();
  }

  get settling(): boolean { return this.state === 'SETTLING'; }
  get active(): boolean { return this.state === 'GENERATING' || this.settling; }
  get activeCycleId(): string | null { return this.active ? this.cycleId : null; }
  settlingDelay(now: number): number { return Math.max(1, SETTLING_MS - (now - this.stableSince)); }

  private note(stage: string, detail: string): void {
    if (!this.noted.has(detail)) { diagnostic(stage, detail); this.noted.add(detail); }
  }

  private generating(detail: string): void {
    if (this.state !== 'GENERATING') diagnostic('Generation active', detail);
    this.state = 'GENERATING';
  }

  sample(ui: Snapshot, now: number): string | null {
    const stop = ui.control === 'stop';
    // Only newly rendered recognized failures can belong to this cycle.
    const newError = ui.errors.some(error => !this.previousErrors.has(error));
    this.previousErrors = new Set(ui.errors);
    // Indicators present while idle are historical and cannot hold a cycle open.
    if (!this.active && !stop) this.idleBusy = new Set(ui.busy);
    const busy = ui.busy.some(element => !this.idleBusy.has(element));
    // Stop disappearance alone is insufficient. An unknown control is idle only
    // when the cycle's Stop was observed on the primary composer control.
    const idle = ui.control === 'idle' || (ui.control === 'fallback' && this.primaryStop);

    if (this.state === 'CANCELLED') {
      if (!stop && (ui.control === 'idle' || ui.control === 'fallback')) this.reset();
      return null;
    }

    // Typing, clearing or seeing Send never starts a cycle; only Stop does.
    if (this.state === 'IDLE') {
      if (!stop) return null;
      this.cycleId = crypto.randomUUID();
      diagnostic('Generation detected');
    }

    if (newError) {
      this.cancel('current-cycle error');
      return null;
    }

    if (stop) {
      if (ui.primary) this.primaryStop = true;
      // Indicators that held an idle composer open are not evidence for a later
      // generation phase. A stuck indicator cannot silence every later reply.
      for (const element of this.held) this.idleBusy.add(element);
      this.held.clear();
      this.generating(this.state === 'IDLE' ? 'composer Stop' : 'resumed');
      return null;
    }
    // Background thinking, tools or image progress can outlast the Stop control.
    if (busy) {
      if (idle) for (const element of ui.busy) if (!this.idleBusy.has(element)) this.held.add(element);
      this.generating('background activity');
      this.note('Waiting', 'background activity');
      return null;
    }
    if (!idle) {
      this.generating('composer state unknown');
      this.note('Waiting', 'composer state unknown');
      return null;
    }

    if (this.state !== 'SETTLING') {
      diagnostic('Idle candidate');
      diagnostic('Settling');
      this.state = 'SETTLING';
      this.stableSince = now;
      return null;
    }
    if (now - this.stableSince < SETTLING_MS) return null;

    this.state = 'COMPLETED';
    diagnostic('Completion confirmed');
    const completedId = this.cycleId;
    this.reset(); // Consumed before delivery; unrelated mutations cannot re-emit.
    return completedId;
  }
}
