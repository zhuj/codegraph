import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { SynthesisStage } from '../src/db/synthesis-stage';
import { ReferenceResolver } from '../src/resolution';
import * as synthesis from '../src/resolution/callback-synthesizer';
import * as commentMask from '../src/resolution/strip-comments';
import type { Node } from '../src/types';

const dispatch = `const actions = { first: handleA, second: handleB };
export function invoke(key) {
  bus.emit('run');
  actions[key]();
}
bus.on('run', handleA);
`;
const handlers = `export function handleA() {}
export function handleB() {}
`;

function fn(name: string, filePath: string, startLine: number, endLine = startLine, id = name): Node {
  return { id, kind: 'function', name, qualifiedName: name, filePath, language: 'typescript',
    startLine, endLine, startColumn: 0, endColumn: 1, updatedAt: 0 };
}

describe('object-registry synthesis input reuse', () => {
  let root: string;
  let db: DatabaseConnection;
  let queries: QueryBuilder;

  const put = (file: string, source: string, nodes: Node[]): void => {
    writeFileSync(join(root, file), source);
    queries.deleteNodesByFile(file);
    queries.upsertFile({ path: file, language: 'typescript', contentHash: '', size: source.length,
      modifiedAt: 0, indexedAt: 0, nodeCount: nodes.length });
    queries.insertNodes(nodes);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cg-registry-synth-'));
    db = DatabaseConnection.initialize(join(root, 'index.db'));
    queries = new QueryBuilder(db.getDb());
    put('dispatch.ts', dispatch, [fn('invoke', 'dispatch.ts', 2, 5)]);
    put('handlers.ts', handlers, [fn('handleA', 'handlers.ts', 1), fn('handleB', 'handlers.ts', 2)]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const run = async (cache?: synthesis.RegistryInputCache) => {
    const stage = new SynthesisStage(db.getPath());
    try {
      const context = new ReferenceResolver(root, stage.queries).getResolutionContext();
      await synthesis.synthesizeCallbackEdges(stage.queries, context, undefined, null, undefined, undefined, cache);
      await stage.publish();
      return queries.getOutgoingEdges('invoke', ['calls']);
    } finally {
      stage.close();
    }
  };

  it('does not scan unchanged dispatch text again and preserves the first pass winner', async () => {
    const cache = new synthesis.RegistryInputCache();
    const mask = vi.spyOn(commentMask, 'stripCommentsForRegex');
    const timesMasked = () => mask.mock.calls.filter(([source]) => source === dispatch).length;
    const cold = await run();
    const coldMasks = timesMasked();
    expect(cold.map(e => [e.target, e.metadata?.synthesizedBy, e.provenance])).toEqual([
      ['handleA', 'event-emitter', 'heuristic'], ['handleB', 'object-registry', 'heuristic'],
    ]);
    await run(cache);
    mask.mockClear();

    expect(await run(cache)).toEqual(cold);
    expect(timesMasked()).toBe(coldMasks - 1);
  });

  it('reparses edited text, revealing a registry edge when the earlier winner disappears', async () => {
    const cache = new synthesis.RegistryInputCache();
    await run(cache);
    const edited = dispatch.replace("bus.emit('run');", '                ').replace('handleB', 'missing');
    put('dispatch.ts', edited, [fn('invoke', 'dispatch.ts', 2, 5)]);

    const warm = await run(cache);

    expect(warm).toEqual(await run());
    expect(warm.map(e => [e.target, e.metadata?.synthesizedBy, e.line])).toEqual([
      ['handleA', 'object-registry', 4],
    ]);
  });

  it('memoizes a negative scan but leaves an oversized source uncached', () => {
    const cache = new synthesis.RegistryInputCache();
    const noRegistry = 'export function invoke(key) { actions[key](); }\n';
    const oversized = `${dispatch}${'// abcdefghijklmnopqrst\n'.repeat(6000)}`;
    const mask = vi.spyOn(commentMask, 'stripCommentsForRegex');

    expect(cache.scan('miss.ts', noRegistry)).toEqual([]);
    expect(cache.scan('miss.ts', noRegistry)).toEqual([]);
    expect(mask.mock.calls.filter(([source]) => source === noRegistry)).toHaveLength(1);
    expect(cache.scan('large.ts', oversized)).toHaveLength(1);
    expect(cache.scan('large.ts', oversized)).toHaveLength(1);
    expect(mask.mock.calls.filter(([source]) => source === oversized)).toHaveLength(2);
  });

  it('resolves added and removed endpoints from the current graph without reparsing unchanged text', async () => {
    const cache = new synthesis.RegistryInputCache();
    await run(cache);
    queries.deleteFile('handlers.ts');
    rmSync(join(root, 'handlers.ts'));
    put('replacement.ts', 'export function handleB() {}\n', [fn('handleB', 'replacement.ts', 1, 1, 'replacement')]);
    const mask = vi.spyOn(commentMask, 'stripCommentsForRegex');

    const warm = await run(cache);

    const warmMasks = mask.mock.calls.filter(([source]) => source === dispatch).length;
    mask.mockClear();
    expect(warm).toEqual(await run());
    expect(mask.mock.calls.filter(([source]) => source === dispatch)).toHaveLength(warmMasks + 1);
    expect(warm.map(e => e.target)).toEqual(['replacement']);
  });

  it('falls back to a cold scan without a cache after reopening', async () => {
    const cold = await run(new synthesis.RegistryInputCache());
    const dbPath = db.getPath();
    db.close();
    db = DatabaseConnection.open(dbPath);
    queries = new QueryBuilder(db.getDb());
    const mask = vi.spyOn(commentMask, 'stripCommentsForRegex');

    expect(await run()).toEqual(cold);
    expect(mask.mock.calls.some(([source]) => source === dispatch)).toBe(true);
  });
});

describe('MediatR synthesis input gate', () => {
  it.each([
    ['.Send(arg', false],
    ['139...Send(arg', false],
    ['139x...Send(arg', true],
    ['mediator .\u00a0Publish\t(\r\nnew Msg', true],
    ['mediator.Send(new', true],
    ['mediator.Send(123', false],
    ['mediator.Send(', false],
    ['.Send(arg.Publish(value', true],
  ])('preserves the existence test on %j', (source, expected) => {
    expect(synthesis.hasSynthesisPattern('not-csharp.ts', source)).toBe(expected);
  });

  it('does not apply the receiver-start scanner to irrelevant tokens, even with a suffix marker', () => {
    const test = RegExp.prototype.test;
    const legacy = /([A-Za-z_][\w.]*)\s*\.\s*(Send|Publish)\s*\(\s*(new\s+[A-Z]\w*|[A-Za-z_]\w*)/g;
    const scanned: string[] = [];
    const probe = vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (this: RegExp, input: string) {
      if (this.source === legacy.source) scanned.push(input);
      return test.call(this, input);
    });
    try {
      const pad = 'x'.repeat(512);
      expect(synthesis.hasSynthesisPattern('padded.ts', `/* ${pad} */`)).toBe(false);
      expect(synthesis.hasSynthesisPattern('padded.ts', `/* ${pad} */ .Send(arg`)).toBe(false);
      expect(synthesis.hasSynthesisPattern('padded.ts', `/* ${pad} */ mediator.Publish(arg`)).toBe(true);
      expect(scanned).toEqual([]);
    } finally {
      probe.mockRestore();
    }
  });
});
