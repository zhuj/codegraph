import { createProgressActivity, beginActivityPhase, stopProgressActivity, activityEpoch, type ProgressActivity } from '../progress-activity';
import { Worker } from 'worker_threads';
import * as path from 'path';
import { ansiColorsEnabled } from './color';
import { getGlyphs } from './glyphs';

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
  let lastPhaseName = '';
  let lastPercent = -1;
  let lastCount = 0;

  // The persistent "phase done" lines — the ones that stay in scrollback —
  // are printed HERE, on the main thread, not by the worker. process.stdout
  // reaches a Windows console through the wide-char API, so these lines can
  // carry the same Unicode glyphs @clack/prompts draws around them (#398);
  // the worker's raw fs.writeSync path can't (codepage mojibake, #168) and is
  // now used only for the transient, self-erasing animation frames. The main
  // thread is guaranteed alive here: phase changes arrive via its own
  // progress callback.
  const printPhaseDone = (): void => {
    if (!lastPhaseName) return;
    let detail = '';
    if (lastPercent >= 0) detail = ` ${G.dash} done`;
    else if (lastCount > 0) detail = ` ${G.dash} ${lastCount.toLocaleString()} found`;
    // Leading \r + erase clears the worker's in-flight animation line; one
    // atomic write so a worker frame can't interleave mid-line.
    process.stdout.write(
      `\r\x1b[K${DM}${G.rail}${RST}  ${GRN}${G.phaseDone}${RST} ${lastPhaseName}${detail}\n`
    );
    lastPhaseName = '';
    lastPercent = -1;
    lastCount = 0;
  };

  const workerPath = path.join(__dirname, 'shimmer-worker.js');
  const worker = new Worker(workerPath, {
    // colors:false keeps the animation (still an interactive TTY) but drops
    // the ANSI color codes, honoring NO_COLOR / --no-color (#1281).
    workerData: { startTime: Date.now(), colors: useColor, activity, columns: process.stdout.columns || 100 },
  });

  const onResize = (): void => worker.postMessage({ type: 'resize', columns: process.stdout.columns || 100 });
  process.stdout.on('resize', onResize);
  let lastSent = '';
  let lastSentAt = 0;
  return {
    activity,
    onProgress(progress: IndexProgress) {
      const phaseChanged = progress.phase !== lastPhase;
      if (phaseChanged) beginActivityPhase(activity);
      const phaseName = PHASE_NAMES[progress.phase] || progress.phase;

      if (progress.phase !== lastPhase && lastPhase) {
        printPhaseDone();
      }
      lastPhase = progress.phase;
      lastPhaseName = phaseName;

      let percent = -1;
      let count = 0;
      if (progress.total > 0) {
        percent = Math.round((progress.current / progress.total) * 100);
      } else if (progress.current > 0) {
        count = progress.current;
      }
      lastPercent = percent;
      lastCount = count;

      // Path producers never post messages. Percent/count updates are coalesced
      // too; the animation renders independently at 20fps even when we are busy.
      const state = `${progress.phase}:${percent}:${count}`;
      const now = Date.now();
      if (!phaseChanged && (state === lastSent || now - lastSentAt < 50)) return;
      lastSent = state;
      lastSentAt = now;
      worker.postMessage({
        type: 'update',
        epoch: activityEpoch(activity),
        phase: progress.phase,
        phaseName,
        percent,
        count,
      });
    },

    stop() {
      stopProgressActivity(activity);
      process.stdout.off('resize', onResize);
      return new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          // Worker has cleared (or been terminated off) the animation line;
          // persist the final phase's done-line from the main thread.
          printPhaseDone();
          resolve();
        };

        const timeout = setTimeout(() => {
          worker.terminate().then(finish);
        }, 2000);

        worker.on('message', (msg: { type: string }) => {
          if (msg.type === 'stopped') {
            clearTimeout(timeout);
            worker.terminate().then(finish);
          }
        });

        worker.postMessage({ type: 'stop' });
      });
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
