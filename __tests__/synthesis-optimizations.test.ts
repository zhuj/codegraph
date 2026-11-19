import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SourceSlices } from '../src/resolution/source-slices';
import { SYNTH_PASSES } from '../src/resolution/callback-synthesizer';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { SynthesisStage, SYNTHESIZED_EDGE } from '../src/db/synthesis-stage';

describe('bounded source slices', () => {
  it.each(['', 'one', 'one\n', 'a\nb\nc', 'a\r\nb\r\n', '漢😀\r\nsecond\nlast'])
  ('exactly preserves old split/slice/join behavior for %j', source => {
    const cache = new SourceSlices();
    for (let start = -5; start < 8; start++) for (let end = -5; end < 8; end++) {
      const expected = !start || !end ? null : source.split('\n').slice(start - 1, end).join('\n');
      expect(cache.slice('source.ts', source, start, end)).toBe(expected);
    }
  });

  it('reuses offsets, invalidates edits and stays inside both memory limits', () => {
    const cache = new SourceSlices(2048, 2);
    expect(cache.slice('a.ts', 'one\ntwo', 2, 2)).toBe('two');
    expect(cache.slice('a.ts', 'one\nnew', 2, 2)).toBe('new');
    for (let i = 0; i < 100; i++) {
      expect(cache.slice(`${i}.ts`, 'a\r\nb\n', 1, 2)).toBe('a\r\nb');
      expect(cache.retainedFiles).toBeLessThanOrEqual(2);
      expect(cache.retainedBytes).toBeLessThanOrEqual(2048);
    }
    const huge = 'huge\n'.repeat(2000);
    expect(cache.slice('huge.ts', huge, 1, 2)).toBe('huge\nhuge');
    expect(cache.retainedBytes).toBeLessThanOrEqual(2048);
  });

  it('skips closure-language scans when their own predicate cannot match', () => {
    const pass = SYNTH_PASSES.find(p => p.name === 'closureCollEdges')!;
    expect(pass.gate((...langs) => langs.includes('typescript'))).toBe(false);
    expect(pass.gate((...langs) => langs.includes('swift'))).toBe(true);
    expect(pass.gate((...langs) => langs.includes('kotlin'))).toBe(true);
  });
});

describe('chunked atomic synthesis replacement', () => {
  let dir: string | undefined;
  let db: DatabaseConnection | undefined;
  let stage: SynthesisStage | undefined;
  afterEach(() => {
    stage?.close(); stage = undefined;
    db?.close(); db = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function fixture() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-synth-replace-'));
    db = DatabaseConnection.initialize(path.join(dir, 'index.db'));
    const queries = new QueryBuilder(db.getDb());
    queries.insertNodes(['a', 'b'].map(id => ({
      id, name: id, qualifiedName: id, kind: 'function', language: 'typescript',
      filePath: `${id}.ts`, startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, updatedAt: 0,
    })));
    const raw = db.getDb();
    raw.exec('BEGIN');
    const insert = raw.prepare("INSERT INTO edges(source,target,kind,line,metadata) VALUES ('a','b','calls',?,?)");
    for (let i = 0; i < 7000; i++) insert.run(i, i % 3 ? '{"synthesizedBy":"old"}' : 'malformed base');
    raw.exec('COMMIT');
    stage = new SynthesisStage(db.getPath());
    stage.queries.insertEdge({ source: 'a', target: 'b', kind: 'calls', line: 9000, metadata: { synthesizedBy: 'new' } });
    return raw;
  }

  it('replaces more than two chunks while preserving base rows', async () => {
    const raw = fixture();
    const before = raw.prepare("SELECT * FROM edges WHERE metadata = 'malformed base' ORDER BY id").all();
    await stage!.publish();
    expect(raw.prepare("SELECT * FROM edges WHERE metadata = 'malformed base' ORDER BY id").all()).toEqual(before);
    expect(raw.prepare(`SELECT line FROM edges WHERE ${SYNTHESIZED_EDGE}`).all()).toEqual([{ line: 9000 }]);
  });

  it('rolls back all chunk deletions if publication fails', async () => {
    const raw = fixture();
    const before = raw.prepare('SELECT * FROM edges ORDER BY id').all();
    raw.exec(`CREATE TRIGGER fail_synth BEFORE INSERT ON edges WHEN NEW.line = 9000 BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
    await expect(stage!.publish()).rejects.toThrow('test failure');
    expect(raw.prepare('SELECT * FROM edges ORDER BY id').all()).toEqual(before);
  });
});
