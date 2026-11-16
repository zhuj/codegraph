import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';
import { hasFlowPragma } from '../grammars';
import type { Node as SyntaxNode } from 'web-tree-sitter';

/**
 * A TS/JS class field (`public_field_definition` / `field_definition`) is a
 * METHOD only when its value is callable — an arrow function, a function
 * expression, or a HOF call wrapping one (`onScroll = throttle(() => {…})`),
 * exactly mirroring what `resolveBody` below knows how to walk. Everything
 * else (`public fonts: Fonts;`, `count = 0`, `static defaults = {…}`) is a
 * PROPERTY. Previously every field extracted as method-kind (#808), which
 * misrepresented class shape and defeated kind-based filtering — the reason
 * #756's function-ref resolution had to restrict TS/JS bare identifiers to
 * function targets.
 */
export function classifyTsClassMember(node: SyntaxNode): 'method' | 'property' {
  if (node.type !== 'public_field_definition' && node.type !== 'field_definition') {
    return 'method'; // method_definition, getters/setters — untouched
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'arrow_function' || child.type === 'function_expression') {
      return 'method';
    }
    if (child.type === 'call_expression') {
      const args = getChildByField(child, 'arguments');
      if (args) {
        for (let j = 0; j < args.namedChildCount; j++) {
          const arg = args.namedChild(j);
          if (arg && (arg.type === 'arrow_function' || arg.type === 'function_expression')) {
            return 'method';
          }
        }
      }
    }
  }
  return 'property';
}

/**
 * Flow's own syntax, blanked to spaces (offsets survive) so a Flow file reads
 * as TSX: exact object types `{| a: T |}`, a maybe type's `?` (`x: ?string`,
 * `Array<?T>`), an inexact object's `...`, `import typeof`, `opaque type`. Only files with the `@flow`
 * pragma — the ones `detectLanguage` sends here from `.js`.
 */
export function blankFlowSyntax(source: string, filePath?: string): string {
  if (!filePath || !/\.(?:jsx?|mjs|cjs)$/.test(filePath) || !hasFlowPragma(source)) return source;
  return source
    .replace(/\{\|/g, '{ ')
    .replace(/\|\}/g, ' }')
    .replace(/([:<,]\s*)\?(?=[\w$({[])/g, '$1 ')
    .replace(/\bimport\s+typeof\b/g, (m) => 'import' + ' '.repeat(m.length - 'import'.length))
    .replace(/\bopaque(?=\s+type\b)/g, '      ')
    // An inexact object type's bare `...` (`{a: T, ...}`) — never a value spread.
    .replace(/\.\.\.(?=\s*[},])/g, '   ');
}

/**
 * The bundled TS grammar rejects `export type * [as Name] from '…'`.
 * It otherwise recognizes that declaration, with just `type` inside ERROR.
 * Blank only that AST-proven modifier, preserving every source offset. Looking
 * at top-level export tokens avoids rewriting examples in comments, strings,
 * templates, regexes or JSX, and leaves malformed declarations unchanged.
 */
export function blankTypeOnlyStarExportModifiers(source: string, root: SyntaxNode): string {
  const positions: number[] = [];
  for (const statement of root.namedChildren) {
    if (statement.type !== 'export_statement' || !statement.hasError) continue;
    const tokens = statement.children.filter((child) => child.type !== 'comment');
    if (tokens.length !== 5 && !(tokens.length === 6 && tokens[5]!.type === ';')) continue;
    const [exportToken, modifier, star, from, module] = tokens;
    if (
      exportToken?.type !== 'export' || modifier?.type !== 'ERROR' ||
      modifier.childCount !== 1 || modifier.child(0)?.type !== 'type' ||
      source.slice(modifier.startIndex, modifier.endIndex) !== 'type' ||
      (star?.type !== '*' && star?.type !== 'namespace_export') ||
      star.hasError || star.isMissing || from?.type !== 'from' || from.isMissing ||
      module?.type !== 'string' || module.hasError || module.isMissing
    ) continue;
    positions.push(modifier.startIndex);
  }
  // Only the modifier bytes change; comments, module strings and positions survive.
  for (let i = positions.length - 1; i >= 0; i--) {
    const start = positions[i]!;
    source = source.slice(0, start) + '    ' + source.slice(start + 4);
  }
  return source;
}

export const typescriptExtractor: LanguageExtractor = {
  preParse: blankFlowSyntax,
  functionTypes: ['function_declaration', 'generator_function_declaration', 'arrow_function', 'function_expression', 'generator_function'],
  classTypes: ['class_declaration', 'abstract_class_declaration'],
  // `method_signature` is the interface/type-literal form of a method; without it
  // an interface's members never enter the graph, so a `.d.ts` platform API has
  // no declaration node for call sites to attach to (#1638). Java/C# don't need
  // an equivalent — their grammars reuse `method_declaration`.
  methodTypes: ['method_definition', 'public_field_definition', 'method_signature'],
  classifyMethodNode: classifyTsClassMember,
  // The interface counterpart of `public_field_definition`. It carries no value,
  // so it is always a property and never needs classifyMethodNode.
  propertyTypes: ['property_signature'],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['property_identifier', 'enum_assignment'],
  typeAliasTypes: ['type_alias_declaration'],
  importTypes: ['import_statement'],
  callTypes: ['call_expression'],
  variableTypes: ['lexical_declaration', 'variable_declaration'],
  nameField: 'name',
  bodyField: 'body',
  resolveBody: (node, bodyField) => {
    // public_field_definition (arrow function class fields) nest the body inside
    // an arrow_function or function_expression child:
    //   public_field_definition → arrow_function → body (statement_block)
    // Also handles wrapper patterns like: field = withBatchedUpdates((e) => { ... })
    //   public_field_definition → call_expression → arguments → arrow_function → body
    if (node.type === 'public_field_definition') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === 'arrow_function' || child.type === 'function_expression') {
          return getChildByField(child, bodyField);
        }
        // Check inside call_expression arguments (HOF wrappers like throttle, debounce)
        if (child.type === 'call_expression') {
          const args = getChildByField(child, 'arguments');
          if (args) {
            for (let j = 0; j < args.namedChildCount; j++) {
              const arg = args.namedChild(j);
              if (arg && (arg.type === 'arrow_function' || arg.type === 'function_expression')) {
                return getChildByField(arg, bodyField);
              }
            }
          }
        }
      }
    }
    return null;
  },
  paramsField: 'parameters',
  returnField: 'return_type',
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ': ' + getNodeText(returnType, source).replace(/^:\s*/, '');
    }
    return sig;
  },
  getVisibility: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'accessibility_modifier') {
        const text = child.text;
        if (text === 'public') return 'public';
        if (text === 'private') return 'private';
        if (text === 'protected') return 'protected';
      }
    }
    return undefined;
  },
  isExported: (node, _source) => {
    // Walk the parent chain to find an export_statement ancestor.
    // This correctly handles deeply nested nodes like arrow functions
    // inside variable declarations: `export const X = () => { ... }`
    // where the arrow_function is 3 levels deep under export_statement.
    let current = node.parent;
    while (current) {
      if (current.type === 'export_statement') return true;
      current = current.parent;
    }
    return false;
  },
  isAsync: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'async') return true;
    }
    return false;
  },
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'static') return true;
    }
    return false;
  },
  isConst: (node) => {
    // For lexical_declaration, check if it's 'const' or 'let'
    // For variable_declaration, it's always 'var'
    if (node.type === 'lexical_declaration') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'const') return true;
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const sourceField = node.childForFieldName('source');
    if (sourceField) {
      const moduleName = source.substring(sourceField.startIndex, sourceField.endIndex).replace(/['"]/g, '');
      if (moduleName) {
        return { moduleName, signature: source.substring(node.startIndex, node.endIndex).trim() };
      }
    }
    return null;
  },
};
