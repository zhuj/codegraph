/** Local workspace settings stored beside the index, including symlinked data dirs. */
import * as fs from 'fs';
import * as path from 'path';
import { parseDocument } from 'yaml';
import { getCodeGraphDir } from './directory';

export const WORKSPACE_CONFIG_FILENAME = 'config.yaml';

export interface BackgroundConfig {
  enabled: boolean;
  intervalSeconds: number;
}

export interface WorkspaceConfig {
  directories?: string[];
  exclude?: string[];
  include?: string[];
  includeIgnored?: string[];
  deprioritize?: string[];
  extensions?: Record<string, string>;
  background?: Partial<BackgroundConfig>;
}

const DEFAULT_DIRECTORIES = Object.freeze(['.']) as unknown as string[];
const DEFAULT_BACKGROUND: BackgroundConfig = Object.freeze({ enabled: true, intervalSeconds: 600 });
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_INTERVAL_SECONDS = Math.floor(0x7fffffff / 1000);
const KEYS = new Set(['directories', 'exclude', 'include', 'includeIgnored', 'deprioritize', 'extensions', 'background']);
const cache = new Map<string, { stamp: string; config: WorkspaceConfig }>();

export class WorkspaceConfigError extends Error {
  constructor(file: string, message: string) {
    super(`Invalid workspace config ${file}: ${message}`);
    this.name = 'WorkspaceConfigError';
  }
}

export function getWorkspaceConfigPath(rootDir: string): string {
  return path.join(getCodeGraphDir(rootDir), WORKSPACE_CONFIG_FILENAME);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown, field: string, file: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim() || v.includes('\0'))) {
    throw new WorkspaceConfigError(file, `${field} must be an array of non-empty strings`);
  }
  return value.map((v: string) => v.trim());
}

function directories(value: unknown, file: string): string[] {
  const values = strings(value, 'directories', file).map((entry) => {
    const normalized = entry.replace(/\\/g, '/');
    if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(entry) || /^[A-Za-z]:/.test(entry) ||
        normalized.split('/').includes('..') || /[*?\[\]{}]/.test(normalized)) {
      throw new WorkspaceConfigError(file, `directories entry ${JSON.stringify(entry)} must be a relative directory path without ".." or glob patterns`);
    }
    return path.posix.normalize(normalized).replace(/\/$/, '') || '.';
  });
  // An overlapping root must not produce duplicate scan work. An empty list
  // intentionally selects nothing; it never falls back to the whole workspace.
  return [...new Set(values)].filter((dir, _index, all) =>
    !all.some((parent) => parent !== dir && (parent === '.' || dir.startsWith(parent + '/'))));
}

function parseConfig(file: string, raw: string): WorkspaceConfig {
  let parsed: unknown;
  try {
    const doc = parseDocument(raw, { uniqueKeys: true });
    if (doc.errors.length > 0) throw doc.errors[0];
    // Aliases are allowed but bounded, so a compact alias expansion cannot
    // turn a local config load into an unbounded allocation.
    parsed = doc.toJS({ maxAliasCount: 100 });
  } catch (error) {
    throw new WorkspaceConfigError(file, error instanceof Error ? error.message : String(error));
  }
  if (parsed == null) return {};
  if (!record(parsed)) throw new WorkspaceConfigError(file, 'the document must be a mapping');
  for (const key of Object.keys(parsed)) {
    if (!KEYS.has(key)) throw new WorkspaceConfigError(file, `unknown setting ${JSON.stringify(key)}`);
  }
  const result: WorkspaceConfig = {};
  if ('directories' in parsed) result.directories = directories(parsed.directories, file);
  for (const key of ['exclude', 'include', 'includeIgnored', 'deprioritize'] as const) {
    if (key in parsed) result[key] = strings(parsed[key], key, file);
  }
  if ('extensions' in parsed) {
    if (!record(parsed.extensions) || Object.values(parsed.extensions).some((v) => typeof v !== 'string')) {
      throw new WorkspaceConfigError(file, 'extensions must map file extensions to language names');
    }
    result.extensions = parsed.extensions as Record<string, string>;
  }
  if ('background' in parsed) {
    const value = parsed.background;
    if (!record(value)) throw new WorkspaceConfigError(file, 'background must be a mapping');
    for (const key of Object.keys(value)) {
      if (key !== 'enabled' && key !== 'intervalSeconds') {
        throw new WorkspaceConfigError(file, `unknown background setting ${JSON.stringify(key)}`);
      }
    }
    if ('enabled' in value && typeof value.enabled !== 'boolean') {
      throw new WorkspaceConfigError(file, 'background.enabled must be true or false');
    }
    if ('intervalSeconds' in value && (typeof value.intervalSeconds !== 'number' ||
        !Number.isFinite(value.intervalSeconds) || value.intervalSeconds < 0 ||
        (value.intervalSeconds > 0 && value.intervalSeconds < 0.001) || value.intervalSeconds > MAX_INTERVAL_SECONDS)) {
      throw new WorkspaceConfigError(file, `background.intervalSeconds must be 0 (disabled) or a finite number between 0.001 and ${MAX_INTERVAL_SECONDS}`);
    }
    result.background = value as Partial<BackgroundConfig>;
  }
  return result;
}

/** Missing YAML is compatible with legacy projects; invalid YAML fails closed. */
export function loadWorkspaceConfig(rootDir: string): WorkspaceConfig | null {
  const file = getWorkspaceConfigPath(rootDir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cache.delete(file);
      return null;
    }
    throw new WorkspaceConfigError(file, error instanceof Error ? error.message : String(error));
  }
  if (!stat.isFile()) throw new WorkspaceConfigError(file, 'expected a regular YAML file');
  if (stat.size > MAX_CONFIG_BYTES) throw new WorkspaceConfigError(file, 'file exceeds the 1 MiB size limit');
  const stamp = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  const entry = cache.get(file);
  if (entry?.stamp === stamp) return entry.config;
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { throw new WorkspaceConfigError(file, error instanceof Error ? error.message : String(error)); }
  const config = parseConfig(file, raw);
  cache.set(file, { stamp, config });
  return config;
}

export function loadScanDirectories(rootDir: string): string[] {
  return loadWorkspaceConfig(rootDir)?.directories ?? DEFAULT_DIRECTORIES;
}

export function hasExplicitScanDirectories(rootDir: string): boolean {
  return loadWorkspaceConfig(rootDir)?.directories !== undefined;
}

export function hasBackgroundConfig(rootDir: string): boolean {
  return loadWorkspaceConfig(rootDir)?.background !== undefined;
}

export function loadBackgroundConfig(rootDir: string): BackgroundConfig {
  const config = loadWorkspaceConfig(rootDir)?.background;
  if (!config) return DEFAULT_BACKGROUND;
  const intervalSeconds = config.intervalSeconds ?? DEFAULT_BACKGROUND.intervalSeconds;
  return { enabled: (config.enabled ?? true) && intervalSeconds !== 0, intervalSeconds };
}

/** Directory paths may be ancestors of selected roots so walkers can reach them. */
export function matchesScanDirectories(relativePath: string, selected: readonly string[], isDirectory = false): boolean {
  const rel = relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (selected.includes('.')) return true;
  return selected.some((dir) => (isDirectory && rel === dir) || rel.startsWith(dir + '/') ||
    (isDirectory && (rel === '' || dir.startsWith(rel + '/'))));
}

export function clearWorkspaceConfigCache(): void {
  cache.clear();
}

/** Create the editable defaults once; never replace an existing user config. */
export function ensureWorkspaceConfig(rootDir: string): boolean {
  const file = getWorkspaceConfigPath(rootDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const contents = `# Paths are relative to the workspace containing this data directory.
# A symlinked .codegraph does not change that base directory.
directories:
  - .

# Optional gitignore-style exclusions (built-in exclusions already apply).
# Uncomment to replace the legacy codegraph.json exclude list:
# exclude:
#   - node_modules
#   - vendor/generated

# Applies only to automatic scans and syncs; manual index/sync runs immediately.
# Set enabled: false or intervalSeconds: 0 to disable background work.
background:
  enabled: true
  intervalSeconds: ${DEFAULT_BACKGROUND.intervalSeconds}
`;
  try { fs.writeFileSync(file, contents, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  clearWorkspaceConfigCache();
  return true;
}
