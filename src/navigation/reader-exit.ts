export const READER_EXIT_FLUSH_TIMEOUT_MS = 2_500;

export type ReaderProgressFlushOutcome =
  | { status: "saved" }
  | { status: "failed"; error: unknown }
  | { status: "timed-out"; timeoutMs: number };

export interface ReaderExitTimer {
  result: Promise<unknown>;
  cancel(): void;
}

export type ReaderExitTimerFactory = (milliseconds: number) => ReaderExitTimer;

/**
 * Native waits for its final save but never prevents Back after a save failure.
 * Bound PodJS waiting to 2.5s: just over 3x either native 800ms layout-snapshot
 * timeout, leaving bridge/DB headroom without turning Back into an unbounded wait.
 */
export async function waitForReaderProgressFlush(
  flush: () => Promise<void>,
  timerFactory: ReaderExitTimerFactory,
  timeoutMs = READER_EXIT_FLUSH_TIMEOUT_MS,
): Promise<ReaderProgressFlushOutcome> {
  let timer: ReaderExitTimer;
  try {
    timer = timerFactory(timeoutMs);
  } catch (error) {
    return { status: "failed", error };
  }
  const timedOut = timer.result.then<ReaderProgressFlushOutcome, ReaderProgressFlushOutcome>(
    () => ({ status: "timed-out", timeoutMs }),
    error => ({ status: "failed", error }),
  );
  let writing: Promise<void>;
  try {
    writing = flush();
  } catch (error) {
    timer.cancel();
    return { status: "failed", error };
  }
  try {
    return await Promise.race<ReaderProgressFlushOutcome>([
      writing.then<ReaderProgressFlushOutcome, ReaderProgressFlushOutcome>(() => ({ status: "saved" }), error => ({ status: "failed", error })),
      timedOut,
    ]);
  } finally {
    timer.cancel();
  }
}

/** Deduplicates a Back attempt while the bounded final-progress wait is active. */
export class ReaderExitGuard<T extends object> {
  private pending: T | undefined;

  constructor(
    private readonly timerFactory: ReaderExitTimerFactory,
    private readonly timeoutMs = READER_EXIT_FLUSH_TIMEOUT_MS,
  ) {}

  begin(target: T, flush: () => Promise<void>, complete: (outcome: ReaderProgressFlushOutcome) => void): void {
    if (this.pending === target) return;
    this.pending = target;
    void waitForReaderProgressFlush(flush, this.timerFactory, this.timeoutMs).then(complete).finally(() => {
      if (this.pending === target) this.pending = undefined;
    });
  }
}
