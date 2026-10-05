import { expect, test } from "bun:test";
import { READER_EXIT_FLUSH_TIMEOUT_MS, ReaderExitGuard, type ReaderProgressFlushOutcome } from "../src/navigation/reader-exit.ts";
import { ReadingProgressWriteQueue } from "../src/reader/progress-write-queue.ts";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, failed) => { resolve = ok; reject = failed; });
  return { promise, resolve, reject };
};
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test("progress flush waits through the final serialized bridge write", async () => {
  const queue = new ReadingProgressWriteQueue(), firstGate = deferred(), events: string[] = [];
  const first = queue.enqueue(async () => { events.push("first:start"); await firstGate.promise; events.push("first:end"); });
  const second = queue.enqueue(async () => { events.push("second"); });
  const flush = queue.flush();
  expect(flush).toBe(second);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(events).toEqual(["first:start"]);
  firstGate.resolve();
  await Promise.all([first, flush]);
  expect(events).toEqual(["first:start", "first:end", "second"]);
});

test("a failed write does not prevent a later final progress write", async () => {
  const queue = new ReadingProgressWriteQueue(), events: string[] = [];
  const failed = queue.enqueue(async () => { events.push("failed"); throw new Error("disk"); });
  const final = queue.enqueue(async () => { events.push("final"); });
  await expect(failed).rejects.toThrow("disk");
  await expect(final).resolves.toBeUndefined();
  await expect(queue.flush()).resolves.toBeUndefined();
  expect(events).toEqual(["failed", "final"]);
});

test("normal reader exit is deduplicated and waits for the write to finish", async () => {
  const write = deferred(), timeout = deferred(), target = {}, outcomes: ReaderProgressFlushOutcome[] = [];
  let flushes = 0, timers = 0, cancelled = 0;
  const guard = new ReaderExitGuard<object>(milliseconds => {
    expect(milliseconds).toBe(READER_EXIT_FLUSH_TIMEOUT_MS);
    timers++;
    return { result: timeout.promise, cancel: () => { cancelled++; } };
  });
  const begin = () => guard.begin(target, () => { flushes++; return write.promise; }, outcome => outcomes.push(outcome));
  begin(); begin();
  expect(flushes).toBe(1);
  expect(timers).toBe(1);
  expect(outcomes).toEqual([]);
  write.resolve();
  await write.promise;
  await settle();
  expect(outcomes).toEqual([{ status: "saved" }]);
  expect(cancelled).toBe(1);
});

test("reader exit completes navigation after a failed flush", async () => {
  const write = deferred(), timeout = deferred(), outcomes: ReaderProgressFlushOutcome[] = [];
  const guard = new ReaderExitGuard<object>(() => ({ result: timeout.promise, cancel() {} }));
  guard.begin({}, () => write.promise, outcome => outcomes.push(outcome));
  write.reject(new Error("save failed"));
  await write.promise.catch(() => {});
  await settle();
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]?.status).toBe("failed");
  expect((outcomes[0] as { status: "failed"; error: Error }).error.message).toBe("save failed");
});

test("reader exit completes navigation when the bounded flush wait times out", async () => {
  const write = deferred(), timeout = deferred(), outcomes: ReaderProgressFlushOutcome[] = [];
  const guard = new ReaderExitGuard<object>(milliseconds => ({ result: timeout.promise, cancel() {} }), 2_000);
  guard.begin({}, () => write.promise, outcome => outcomes.push(outcome));
  expect(outcomes).toEqual([]);
  timeout.resolve();
  await timeout.promise;
  await settle();
  expect(outcomes).toEqual([{ status: "timed-out", timeoutMs: 2_000 }]);
});
