/** Bounded, per-context line offsets; avoid splitting a whole file per method. */
export class SourceSlices {
  private readonly entries = new Map<string, { source: string; starts: number[]; bytes: number }>();
  private bytes = 0;
  constructor(private readonly maxBytes = 8 * 1024 * 1024, private readonly maxEntries = 128) {}

  private lines(file: string, source: string): number[] {
    const cached = this.entries.get(file);
    if (cached?.source === source) {
      this.entries.delete(file);
      this.entries.set(file, cached);
      return cached.starts;
    }
    if (cached) { this.bytes -= cached.bytes; this.entries.delete(file); }
    const starts = [0];
    for (let offset = source.indexOf('\n'); offset !== -1; offset = source.indexOf('\n', offset + 1)) starts.push(offset + 1);
    // Budget source retention and JS-number offsets conservatively.
    const bytes = source.length * 2 + starts.length * 16 + file.length * 2 + 128;
    if (bytes <= this.maxBytes && this.maxEntries > 0) {
      while (this.entries.size && (this.bytes + bytes > this.maxBytes || this.entries.size >= this.maxEntries)) {
        const key = this.entries.keys().next().value!;
        this.bytes -= this.entries.get(key)!.bytes;
        this.entries.delete(key);
      }
      this.entries.set(file, { source, starts, bytes });
      this.bytes += bytes;
    }
    return starts;
  }

  /** Same newline/CRLF and range semantics as split('\n').slice(...).join('\n'). */
  slice(file: string, source: string, startLine?: number, endLine?: number): string | null {
    if (!startLine || !endLine) return null;
    const starts = this.lines(file, source);
    const clamp = (n: number): number => n < 0 ? Math.max(starts.length + Math.trunc(n), 0) : Math.min(Math.trunc(n), starts.length);
    const from = clamp(startLine - 1), to = clamp(endLine);
    if (from >= to) return '';
    return source.slice(starts[from]!, to === starts.length ? source.length : starts[to]! - 1);
  }

  /** Exposed for deterministic memory-bound regression tests, not timing heuristics. */
  get retainedBytes(): number { return this.bytes; }
  get retainedFiles(): number { return this.entries.size; }
}
