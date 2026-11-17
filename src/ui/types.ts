/** Messages from main thread to worker */
export type ShimmerWorkerMessage =
  | { type: 'update'; epoch?: number; phase: string; phaseName: string; percent: number; count: number }
  | { type: 'resize'; columns: number }
  | { type: 'stop' };

/** Messages from worker to main thread */
export type ShimmerMainMessage =
  | { type: 'stopped' };
