import { describe, expect, it } from 'vitest';
import { clearNameMatcherMemos, matchObjectPathCall } from '../src/resolution/name-matcher';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import type { Node } from '../src/types';

const holder: Node = {
  id: 'holder', kind: 'variable', name: 'utils', qualifiedName: 'app.js::App.utils',
  filePath: 'app.js', language: 'javascript', startLine: 1, endLine: 3, startColumn: 0, endColumn: 2,
};
const member: Node = {
  ...holder, id: 'format', kind: 'function', name: 'format', qualifiedName: 'app.js::App.utils::format',
  startLine: 2, endLine: 2, startColumn: 2, endColumn: 13,
};
const call: UnresolvedRef = {
  fromNodeId: 'caller', referenceName: 'App.utils.format', referenceKind: 'calls',
  filePath: 'app.js', language: 'javascript', line: 4, column: 0,
};

function holderFixture(nodes: Node[]) {
  const holderReads: string[] = [];
  const context: ResolutionContext = {
    getNodesByName: (name) => {
      holderReads.push(name);
      return nodes.filter((n) => n.name === name);
    },
    getNodesInFile: (file) => nodes.filter((n) => n.filePath === file),
    getNodesByQualifiedName: (name) => nodes.filter((n) => n.qualifiedName === name),
    getNodesByLowerName: (name) => nodes.filter((n) => n.name.toLowerCase() === name),
    getNodesByKind: (kind) => nodes.filter((n) => n.kind === kind),
    getProjectRoot: () => '.',
    getAllFiles: () => ['app.js'],
    fileExists: (file) => file === 'app.js',
    readFile: () => null,
    getImportMappings: () => [],
  };
  return { context, holderReads };
}

describe('object path holder lookup', () => {
  it('reads holders once per path across member lookups in the web language family', () => {
    const { context, holderReads } = holderFixture([holder, member]);

    expect(matchObjectPathCall({ ...call, referenceName: 'App.utils.missing' }, context)).toBeNull();
    expect(matchObjectPathCall({ ...call, language: 'typescript' }, context)?.targetNodeId).toBe(member.id);
    expect(matchObjectPathCall({ ...call, referenceName: 'Other.utils.format' }, context)).toBeNull();
    expect(matchObjectPathCall(call, context)?.targetNodeId).toBe(member.id);
    expect(holderReads).toEqual(['utils', 'utils']);
  });

  it('looks for newly added holders after clearing the matcher generation', () => {
    const nodes: Node[] = [];
    const { context, holderReads } = holderFixture(nodes);
    expect(matchObjectPathCall(call, context)).toBeNull();

    nodes.push(holder, member);
    clearNameMatcherMemos(context);

    expect(matchObjectPathCall(call, context)?.targetNodeId).toBe(member.id);
    expect(holderReads).toEqual(['utils', 'utils']);
  });
});
