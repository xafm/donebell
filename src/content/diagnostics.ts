// Replaced at bundle time. No page-controlled switch or persistent log storage.
declare const __DONEBELL_DEBUG__: boolean;
export function diagnostic(stage: string, detail?: string): void {
  if (typeof __DONEBELL_DEBUG__ !== 'undefined' && __DONEBELL_DEBUG__) {
    console.debug(`[DoneBell] ${stage}${detail ? `: ${detail}` : ''}`);
  }
}
