/**
 * Latest gauge state, sampled by the animation worker on its own clock.
 * The indexing callback is the only writer. Publishing never schedules work,
 * sends a message, or touches stdout; a burst simply replaces the same slot.
 */
const LABEL_UNITS = 512;
const HEADER_BYTES = 16;
const NUMBERS_BYTES = 16;
const VERSION = 0, EPOCH = 1, LENGTH = 2;

export interface ShimmerSnapshot {
  phaseName: string;
  percent: number;
  count: number;
  epoch: number;
}

export class ShimmerState {
  readonly buffer: SharedArrayBuffer;
  private readonly header: Int32Array;
  private readonly numbers: Float64Array;
  private readonly label: Uint16Array;
  private lastPhaseName = '';

  constructor(buffer = new SharedArrayBuffer(HEADER_BYTES + NUMBERS_BYTES + LABEL_UNITS * 2)) {
    this.buffer = buffer;
    this.header = new Int32Array(buffer, 0, HEADER_BYTES / 4);
    this.numbers = new Float64Array(buffer, HEADER_BYTES, 2);
    this.label = new Uint16Array(buffer, HEADER_BYTES + NUMBERS_BYTES, LABEL_UNITS);
  }

  update(snapshot: ShimmerSnapshot): void {
    Atomics.add(this.header, VERSION, 1); // odd while this single writer publishes
    if (snapshot.phaseName !== this.lastPhaseName) {
      let label = snapshot.phaseName.slice(0, LABEL_UNITS);
      if (/[\uD800-\uDBFF]$/.test(label)) label = label.slice(0, -1);
      for (let i = 0; i < label.length; i++) this.label[i] = label.charCodeAt(i);
      Atomics.store(this.header, LENGTH, label.length);
      this.lastPhaseName = snapshot.phaseName;
    }
    this.numbers[0] = snapshot.percent;
    this.numbers[1] = snapshot.count;
    Atomics.store(this.header, EPOCH, snapshot.epoch);
    Atomics.add(this.header, VERSION, 1);
  }

  /** One bounded read attempt. A concurrent write is retried next tick, never spun on. */
  sample(): ShimmerSnapshot | null {
    const version = Atomics.load(this.header, VERSION);
    if (version & 1) return null;
    const length = Atomics.load(this.header, LENGTH);
    if (length <= 0 || length > LABEL_UNITS) return null;
    const snapshot = {
      phaseName: String.fromCharCode(...this.label.subarray(0, length)),
      percent: this.numbers[0]!,
      count: this.numbers[1]!,
      epoch: Atomics.load(this.header, EPOCH),
    };
    return version === Atomics.load(this.header, VERSION) ? snapshot : null;
  }
}
