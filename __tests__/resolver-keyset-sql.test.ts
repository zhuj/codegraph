import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QueryBuilder } from '../src/db/queries';
import { createDatabase, type SqliteDatabase } from '../src/db/sqlite-adapter';

describe('resolver keyset reference reader', () => {
  let db: SqliteDatabase;
  let queries: QueryBuilder;

  beforeEach(() => {
    ({ db } = createDatabase(':memory:'));
    queries = new QueryBuilder(db);
    db.exec(readFileSync(join(__dirname, '../src/db/schema.sql'), 'utf8'));
    db.exec(`
      INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
        start_line, end_line, start_column, end_column, updated_at)
      VALUES ('child', 'class', 'Child', 'Child', 'src/child.ts', 'typescript', 1, 12, 0, 2, 0);
      INSERT INTO unresolved_refs (id, from_node_id, reference_name, reference_kind,
        line, col, candidates, file_path, language, status)
      VALUES
        (2, 'child', 'method', 'calls', 8, 3, '["Base.method"]', 'src/child.ts', 'typescript', 'pending'),
        (3, 'child', 'Missing', 'extends', 1, 20, NULL, 'src/child.ts', 'typescript', 'failed'),
        (5, 'child', 'module:./base', 'imports', 1, 0, NULL, 'src/child.ts', 'typescript', 'pending'),
        (6, 'child', 'method', 'calls', 9, 3, 'not-json', 'src/child.ts', 'typescript', 'pending'),
        (9, 'child', 'Base', 'extends', 3, 14, NULL, 'src/child.ts', 'typescript', 'pending'),
        (10, 'child', 'Interface', 'implements', 3, 26, NULL, 'src/child.ts', 'typescript', 'pending');
    `);
  });

  afterEach(() => db.close());

  it.each([true, false])('projects only the fields the resolver consumes (array capability: %s)', (arrayCapability) => {
    if (!arrayCapability) {
      // Emulate the capability boundary of older Node while retaining real SQLite reads.
      const prepare = db.prepare.bind(db);
      db.prepare = (sql) => ({ ...prepare(sql), rowsAsArrays: () => undefined });
    }
    // The retry-only column would fail if the reader materialized it. The
    // real SQLite query must avoid reading it, not just omit it from JS output.
    db.exec(`CREATE TEMP VIEW unresolved_refs AS
      SELECT id, from_node_id, reference_name, reference_kind, line, col,
             candidates, file_path, language, status, abs(-9223372036854775808) AS name_tail
      FROM main.unresolved_refs`);

    expect(queries.getUnresolvedReferencesBatchAfter(0, 1, false)).toStrictEqual([{
      rowId: 2,
      fromNodeId: 'child',
      referenceName: 'method',
      referenceKind: 'calls',
      line: 8,
      column: 3,
      candidates: ['Base.method'],
      filePath: 'src/child.ts',
      language: 'typescript',
    }]);
  });

  it('paginates the disjoint phases by row ID and keeps parked rows retryable after cleanup', () => {
    const ids = (rows: { rowId?: number }[]) => rows.map(({ rowId }) => rowId);
    expect(ids(queries.getUnresolvedReferencesBatchAfter(0, 2, true))).toEqual([5, 9]);
    expect(ids(queries.getUnresolvedReferencesBatchAfter(9, 2, true))).toEqual([10]);
    expect(ids(queries.getUnresolvedReferencesBatchAfter(0, 6))).toEqual([2, 5, 6, 9, 10]);

    queries.markReferencesFailedByRowIds([{ rowId: 9, referenceName: 'Base', referenceKind: 'extends' }]);
    queries.deleteReferencesByRowIds([2, 5, 10]);

    expect(queries.getUnresolvedReferencesBatchAfter(0, 2, true)).toEqual([]);
    const dependents = queries.getUnresolvedReferencesBatchAfter(0, 2, false);
    expect(ids(dependents)).toEqual([6]);
    expect(dependents[0]?.candidates).toBeUndefined();
    expect(ids(queries.getRetryableFailedReferences(['Base']))).toEqual([9]);
  });
});
