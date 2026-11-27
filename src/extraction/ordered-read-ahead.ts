type ReadOutcome<T> = { value: T } | { error: unknown };

/** Overlap reads with the consumer, without reordering paths or growing the read queue. */
export async function* readAheadInOrder<T>(
  files: readonly string[],
  read: (file: string) => Promise<T>,
  { maxReads, signal }: { maxReads: number; signal?: AbortSignal }
): AsyncGenerator<T> {
  const pending: Array<Promise<ReadOutcome<T>>> = [];
  const remaining = files[Symbol.iterator]();
  const start = async (file: string): Promise<ReadOutcome<T>> => {
    // A later read can reject before it reaches the head of the queue.
    try { return { value: await read(file) }; }
    catch (error) { return { error }; }
  };
  const refill = () => {
    while (pending.length < maxReads && !signal?.aborted) {
      const next = remaining.next();
      if (next.done) break;
      pending.push(start(next.value));
    }
  };

  try {
    refill();
    while (!signal?.aborted) {
      const current = pending.shift();
      if (!current) return;
      const result = await current;
      if (signal?.aborted) return;
      if ('error' in result) throw result.error;
      // Refill before the consumer dispatches the parse or waits on SQLite.
      refill();
      yield result.value;
    }
  } finally {
    // Never leave source reads running once the index operation releases its lock.
    await Promise.all(pending);
  }
}
