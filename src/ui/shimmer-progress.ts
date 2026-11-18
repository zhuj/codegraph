import { createProgressActivity, beginActivityPhase, stopProgressActivity, activityEpoch, type ProgressActivity } from '../progress-activity';
import { Worker } from 'worker_threads';
import * as path from 'path';
import { ansiColorsEnabled } from './color';
import { getGlyphs } from './glyphs';
import { ShimmerState, type ShimmerSnapshot } from './shimmer-state';
import { workerStarted, terminateOnceStarted } from '../worker-teardown';
import type { ShimmerMainMessage } from './types';

const PHASE_NAMES: Record<string, string> = {
  scanning: 'Scanning files',
  parsing: 'Parsing code',
  storing: 'Storing data',
  resolving: 'Resolving refs',
  linking: 'Linking dynamic dispatch',
};

export interface IndexProgress {
  phase: string;
  current: number;
  total: number;
}

export interface ShimmerProgress {
  activity?: ProgressActivity;
  onProgress: (progress: IndexProgress) => void;
  stop: () => Promise<void>;
}

export function createShimmerProgress(root: string = process.cwd()): ShimmerProgress {
  // Piped/redirected stdout: `\r`-rewriting animation frames are garbage in a
  // log file — emit one plain line per phase instead (#1281).
  if (process.stdout.isTTY !== true) {
    return createPlainProgress();
  }

  const activity = createProgressActivity(root);
  const useColor = ansiColorsEnabled();
  const G = getGlyphs();
  const DM = useColor ? '\x1b[2m' : '';
  const GRN = useColor ? '\x1b[32m' : '';
  const RST = useColor ? '\x1b[0m' : '';

  let lastPhase = '';
  let latest: ShimmerSnapshot | undefined;
  const completed: ShimmerSnapshot[] = [];
  const state = new ShimmerState();
  let stopping: Promise<void> | undefined;

  // Phase transitions only queue summaries. Flush once, after the animation
  // stops, so processing never triggers terminal output. Keep persistent text
  // on the main thread's Windows-aware stdout path (#398 / #168).
  const printCompletedPhases = (): void => {
    if (latest) completed.push(latest);
    latest = undefined;
    if (!completed.length) return;
    const lines = completed.map(({ phaseName, percent, count }) => {
      const detail = percent >= 0 ? ` ${G.dash} done`
        : count > 0 ? ` ${G.dash} ${count.toLocaleString()} found` : '';
      return `${DM}${G.rail}${RST}  ${GRN}${G.phaseDone}${RST} ${phaseName}${detail}\n`;
    });
    process.stdout.write(`\r\x1b[K${lines.join('')}`);
    completed.length = 0;
  };

  const workerPath = path.join(__dirname, 'shimmer-worker.js');
  const worker = new Worker(workerPath, {
    // colors:false keeps the animation (still an interactive TTY) but drops
    // the ANSI color codes, honoring NO_COLOR / --no-color (#1281).
    workerData: {
      startTime: Date.now(), colors: useColor, activity,
      progress: state.buffer, columns: process.stdout.columns || 100,
    },
  });
  const started = workerStarted(worker);

  const onResize = (): void => worker.postMessage({ type: 'resize', columns: process.stdout.columns || 100 });
  process.stdout.on('resize', onResize);
  return {
    activity,
    onProgress(progress: IndexProgress) {
      if (stopping) return;
      const phaseChanged = progress.phase !== lastPhase;
      if (phaseChanged) {
        if (latest) completed.push(latest);
        beginActivityPhase(activity);
      }
      const phaseName = PHASE_NAMES[progress.phase] || progress.phase;
      lastPhase = progress.phase;

      let percent = -1;
      let count = 0;
      if (progress.total > 0) {
        percent = Math.round((progress.current / progress.total) * 100);
      } else if (progress.current > 0) {
        count = progress.current;
      }
      latest = {
        epoch: activityEpoch(activity),
        phaseName,
        percent,
        count,
      };
      // Retain even the last update in a burst. Only the animation clock reads
      // this slot: no progress messages, timers, stdout writes or dropped tail.
      state.update(latest);
    },

    stop() {
      if (stopping) return stopping;
      stopProgressActivity(activity);
      process.stdout.off('resize', onResize);
      stopping = new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          worker.off('message', onMessage);
          void terminateOnceStarted(worker, started).then(() => {
            // The worker can no longer race these persistent completion lines.
            printCompletedPhases();
            resolve();
          });
        };

        const timeout = setTimeout(finish, 2000);

        const onMessage = (msg: ShimmerMainMessage): void => {
          if (msg.type === 'stopped') finish();
        };
        worker.on('message', onMessage);

        worker.postMessage({ type: 'stop' });
      });
      return stopping;
    },
  };
}

/**
 * Non-TTY fallback: one plain line per phase, no rewrites, no ANSI.
 * Completion details (counts, timings) are printed by the caller's result
 * summary, so phase starts are all that's worth logging here.
 */
function createPlainProgress(): ShimmerProgress {
  let lastPhase = '';

  return {
    onProgress(progress: IndexProgress) {
      if (progress.phase === lastPhase) return;
      lastPhase = progress.phase;
      const phaseName = PHASE_NAMES[progress.phase] || progress.phase;
      process.stdout.write(`${phaseName}...\n`);
    },

    stop() {
      return Promise.resolve();
    },
  };
}
