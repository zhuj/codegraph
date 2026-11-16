import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { getParser, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { blankTypeOnlyStarExportModifiers } from '../src/extraction/languages/typescript';
import { extractReExports } from '../src/resolution/import-resolver';

const COLLAPSE_WARNING = 'parse produced no symbols (tree has errors)';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['typescript', 'tsx', 'javascript']);
});

beforeEach(() => {
  // Exercise the canonical fallback even when a native kernel is installed.
  vi.stubEnv('CODEGRAPH_KERNEL', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function normalize(source: string, language: 'typescript' | 'tsx' = 'typescript'): string {
  const tree = getParser(language)!.parse(source)!;
  try { return blankTypeOnlyStarExportModifiers(source, tree.rootNode); }
  finally { tree.delete(); }
}

describe('TypeScript type-only star exports', () => {
  it.each(['index.ts', 'index.tsx', 'index.mts', 'index.cts'])(
    'extracts %s without a false parse warning or invented declarations', (file) => {
      const result = extractFromSource(file, [
        'export type * from "./types";',
        'export type * as Contracts from "./contracts";',
        'export { read, write as save } from "./runtime";',
        'export type { Options } from "./options";',
      ].join('\n'));
      expect(result.errors).toEqual([]);
      expect(result.nodes.map((node) => node.kind)).toEqual(['file']);
      expect(result.unresolvedReferences.map((ref) => [ref.referenceName, ref.line, ref.column])).toEqual([
        ['read', 3, 9], ['write', 3, 15], ['Options', 4, 14],
      ]);
    },
  );

  it('replaces only the actual modifier while preserving comments, CRLF and Unicode offsets', () => {
    const source = [
      '// é😀 export type * from "./comment";',
      'export /* before */ type /* after */ * from "./types";',
      'export type* as Contracts from "./contracts";',
      'export { read as load } from "./runtime";',
    ].join('\r\n');
    const expected = source
      .replace('*/ type /*', '*/      /*')
      .replace('export type*', 'export     *');
    const normalized = normalize(source);
    expect(normalized).toBe(expected);
    expect(normalized.length).toBe(source.length);
    expect(normalize(normalized)).toBe(normalized);
    const result = extractFromSource('index.ts', source);
    expect(result.errors).toEqual([]);
    expect(result.unresolvedReferences).toEqual([
      expect.objectContaining({ referenceName: 'read', line: 4, column: 9 }),
    ]);
  });

  it('leaves strings, comments, nested templates, regexes and JSX text unchanged', () => {
    const inert = [
      '// export type * from "./line-comment";',
      '/* export type * as Hidden from "./block-comment"; */',
      'const quoted = "export type * from \'./string\';";',
      'const template = `export type * from "./template"; ${`nested ${"export type * from \'./nested\';"}`}`;',
      'const regex = /export type \\* from "example"/;',
      'const view = <div>export type * from "./jsx";</div>;',
    ].join('\n');
    const source = `${inert}\nexport type * from "./actual";`;
    expect(normalize(source, 'tsx')).toBe(`${inert}\nexport      * from "./actual";`);
    expect(extractFromSource('index.tsx', source).errors).toEqual([]);
  });

  it('preserves declaration signatures and positions after a recovered export', () => {
    const source = 'export type * from "./types";\r\nexport function read(value: string): number { return value.length; }\r\n';
    const result = extractFromSource('index.ts', source);
    expect(result.errors).toEqual([]);
    expect(result.nodes.find((node) => node.kind === 'function')).toMatchObject({
      name: 'read', startLine: 2, startColumn: 7, signature: '(value: string): number',
    });
  });

  it.each([
    'export type * from ;',
    'export type * as from "./types";',
    'export type * from "./types"; }',
    'export { Missing from "./types";',
  ])('retains genuine parse warnings for %s', (source) => {
    const result = extractFromSource('index.ts', source);
    expect(result.errors).toContainEqual(expect.objectContaining({
      severity: 'warning', code: 'parse_error', message: expect.stringContaining(COLLAPSE_WARNING),
    }));
  });

  it('does not normalize type-only export syntax in JavaScript', () => {
    const result = extractFromSource('index.js', 'export type * from "./types";');
    expect(result.errors).toContainEqual(expect.objectContaining({
      code: 'parse_error', message: expect.stringContaining(COLLAPSE_WARNING),
    }));
  });

  it.each(['typescript', 'tsx'] as const)('retains wildcard and namespace forwarding for %s', (language) => {
    expect(extractReExports([
      'export type * from "./types";',
      'export type* as Contracts from "./contracts";',
      'export * from "./values";',
      '// export type * from "./commented";',
    ].join('\n'), language)).toEqual([
      { kind: 'wildcard', source: './types' },
      { kind: 'namespace', exportedName: 'Contracts', source: './contracts' },
      { kind: 'wildcard', source: './values' },
    ]);
    expect(extractReExports('export type * from "./types";', 'javascript')).toEqual([]);
  });

  it('treats comments as separators without joining fragments into export keywords', () => {
    const source = 'export/**/type/**/\u002afrom "./types";';
    expect(extractFromSource('index.ts', source).errors).toEqual([]);
    expect(extractReExports(source, 'typescript')).toEqual([{ kind: 'wildcard', source: './types' }]);
    expect(extractReExports('ex/**/port type * from "./fake";', 'typescript')).toEqual([]);
    expect(extractReExports('export ty/**/pe * from "./fake";', 'typescript')).toEqual([]);
    expect(extractReExports('exporttype * from "./fake";', 'typescript')).toEqual([]);
  });

  it.each(['default', 'wasm'])('resolves a type import through star and renamed barrels (%s)', async (backend) => {
    if (backend === 'default') vi.stubEnv('CODEGRAPH_KERNEL', '1');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-type-star-'));
    let cg: CodeGraph | undefined;
    try {
      const files: Record<string, string> = {
        'types.ts': 'export interface Original { value: string }\n',
        'named.ts': 'export { Original as Forwarded } from "./types";\n',
        'index.ts': 'export type * from "./named";\nexport { read as load } from "./runtime";\n',
        'runtime.ts': 'export function read() { return 1; }\n',
        'consumer.ts': 'import type { Forwarded as Alias } from "./index";\nexport interface Consumer { value: Alias }\n',
      };
      for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(root, file), source);
      cg = CodeGraph.initSync(root);
      const indexed = await cg.indexAll();
      expect(indexed.errors).toEqual([]);
      cg.resolveReferences();
      const original = cg.getNodesInFile('types.ts').find((node) => node.name === 'Original')!;
      expect(original).toBeDefined();
      expect(cg.getIncomingEdges(original.id)).toContainEqual(expect.objectContaining({
        kind: 'imports', source: 'file:consumer.ts',
      }));
      expect(cg.getFileDependents('runtime.ts')).toContain('index.ts');
      expect(fs.readFileSync(path.join(root, 'index.ts'), 'utf8')).toBe(files['index.ts']);
    } finally {
      cg?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
