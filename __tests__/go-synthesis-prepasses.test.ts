import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { ReferenceResolver } from '../src/resolution';
import { synthesizeCallbackEdges } from '../src/resolution/callback-synthesizer';
import type { Edge, Node } from '../src/types';

function node(id: string, kind: Node['kind'], options: Partial<Node> = {}): Node {
  return { id, kind, name: id, qualifiedName: id, language: 'go', filePath: 'pkg/types.go',
    startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, updatedAt: 0, ...options };
}

function contains(source: string, target: string): Edge {
  return { source, target, kind: 'contains' };
}

describe('Go synthesis prepasses', () => {
  let root: string;
  let db: DatabaseConnection;
  let queries: QueryBuilder;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cg-go-prepasses-'));
    db = DatabaseConnection.initialize(join(root, 'index.db'));
    queries = new QueryBuilder(db.getDb());
    queries.upsertFile({ path: 'pkg/types.go', language: 'go', contentHash: '', size: 0,
      modifiedAt: 0, indexedAt: 0, nodeCount: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const synthesize = () => synthesizeCallbackEdges(queries, new ReferenceResolver(root, queries).getResolutionContext());

  it('bounds method-set probes by the rare required method when the first required method is common', async () => {
    const common = 'CommonPrepassMethod';
    const rare = 'RarePrepassMethod';
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const addType = (type: Node, ...methods: string[]): void => {
      nodes.push(type);
      for (const [i, name] of methods.entries()) {
        const id = `${type.id}-${i}`;
        nodes.push(node(id, 'method', { name, qualifiedName: `${type.id}::${name}` }));
        edges.push(contains(type.id, id));
      }
    };
    addType(node('Contract', 'interface'), common, rare);
    addType(node('MissingContract', 'interface'), common, 'AbsentPrepassMethod');
    for (let i = 0; i < 256; i++) addType(node(`Decoy${i}`, 'struct'), common, 'OtherPrepassMethod');
    addType(node('Match', 'struct'), common, rare);
    addType(node('RareOnly', 'struct'), rare);
    queries.insertNodes(nodes);
    queries.insertEdges(edges);

    const has = Set.prototype.has;
    let probes = 0;
    vi.spyOn(Set.prototype, 'has').mockImplementation(function (this: Set<unknown>, key: unknown) {
      if (key === common) probes++;
      return has.call(this, key);
    });

    await synthesize();

    expect(queries.getIncomingEdgesTo(['Contract', 'MissingContract'], ['implements'])
      .map(({ source, target }) => [source, target])).toEqual([['Match', 'Contract']]);
    expect(probes).toBeLessThan(16);
  });

  it('still matches an opaque-only interface to the same unresolved embedding', async () => {
    queries.insertNodes([node('Contract', 'interface'), node('Match', 'struct'), node('Other', 'struct')]);
    queries.insertUnresolvedRefsBatch(['Contract', 'Match', 'Other'].map(fromNodeId => ({
      fromNodeId, referenceName: fromNodeId === 'Other' ? 'DifferentBase' : 'MissingBase',
      referenceKind: 'extends', language: 'go', filePath: 'pkg/types.go', line: 1, column: 0,
    })));

    await synthesize();

    expect(queries.getIncomingEdges('Contract', ['implements']).map(edge => edge.source)).toEqual(['Match']);
  });

  it('batches parent lookups and attaches orphans in stream order through the final partial batch', async () => {
    const owner = node('Receiver', 'struct');
    const duplicate = node('OtherReceiver', 'struct', { name: owner.name, filePath: 'pkg/z.go' });
    const outOfPackage = node('ForeignReceiver', 'struct', { name: owner.name, filePath: 'aaa/types.go' });
    const priorParent = node('ExistingType', 'class', { language: 'typescript', filePath: 'pkg/existing.ts' });
    const file = node('MethodFile', 'file', { filePath: 'pkg/methods.go' });
    const foreignMethod = node('ForeignMethod', 'method', {
      qualifiedName: 'Receiver::ForeignMethod', filePath: 'aaa/methods.go',
    });
    const methods = Array.from({ length: 503 }, (_, i) => node(`Method${i}`, 'method', {
      qualifiedName: `Receiver::Method${i}`, filePath: file.filePath, startLine: i + 1, endLine: i + 1,
    }));
    queries.insertNodes([outOfPackage, owner, duplicate, priorParent, file, foreignMethod, ...methods]);
    queries.insertEdges(methods.flatMap((method, i) => i === 0 || i === 502
      ? [contains(file.id, method.id)]
      : [contains(file.id, method.id), contains(priorParent.id, method.id)]));
    const single = vi.spyOn(queries, 'getIncomingEdges');
    const batch = vi.spyOn(queries, 'getIncomingEdgesTo');
    const byName = vi.spyOn(queries, 'getNodesByName');
    const insert = vi.spyOn(queries, 'insertEdges');

    await synthesize();

    const added = insert.mock.calls.flatMap(([edges]) => edges)
      .filter(edge => edge.metadata?.synthesizedBy === 'go-method-contains');
    expect(added).toEqual([
      { source: outOfPackage.id, target: foreignMethod.id, line: 1 },
      { source: owner.id, target: 'Method0', line: 1 },
      { source: owner.id, target: 'Method502', line: 503 },
    ].map(edge => ({
      ...edge, kind: 'contains', metadata: { synthesizedBy: 'go-method-contains' },
    })));
    expect(single.mock.calls.filter(([, kinds]) => kinds?.includes('contains'))).toHaveLength(0);
    const parentBatches = batch.mock.calls.filter(([, kinds]) => kinds?.includes('contains'));
    expect(parentBatches.length).toBeGreaterThan(1);
    expect(parentBatches.length).toBeLessThanOrEqual(8);
    expect(parentBatches.every(([ids]) => ids.length <= 500)).toBe(true);
    expect(byName.mock.calls.filter(([name]) => name === owner.name)).toHaveLength(2);
  });
});
