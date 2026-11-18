/** Messages from main thread to worker */
export type ShimmerWorkerMessage =
  | { type: 'resize'; columns: number }
  | { type: 'stop' };

/** Messages from worker to main thread */
export type ShimmerMainMessage =
  | { type: 'ready' }
  | { type: 'stopped' };
