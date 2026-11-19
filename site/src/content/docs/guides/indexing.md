---
title: Indexing a Project
description: Full index, incremental sync, and the file watcher.
---

## Initialize and index

```bash
cd your-project
codegraph init      # creates .codegraph/ and builds the full graph — one step
```

`codegraph init` discovers the nearest `.codegraph/` workspace up to your home directory, or creates one in the current directory if none exists, then builds its graph. It creates an editable `config.yaml` without replacing an existing one. To initialize a separate nested project, pass its path explicitly: `codegraph init .`.

## Full vs. incremental

```bash
codegraph index           # full index of the configured workspace directories
codegraph index --force   # also permit an otherwise unsafe broad root
codegraph sync            # incremental — only changed files
```

`sync` is fast because it only reparses what changed — it's what the file watcher runs for you on every edit (see [Stay fresh automatically](#stay-fresh-automatically)). You rarely need to run it by hand.

## Stay fresh automatically

**You don't need to run `codegraph sync` by hand during an agent session.** When your agent (Claude Code, Cursor, Codex, opencode, Hermes, Gemini, Antigravity, Kiro, GitHub Copilot) launches `codegraph serve --mcp`, three layers cooperate to keep the index in step with your code — and to never give the agent a quiet wrong answer in the small window between an edit and the next sync.

### 1. File watcher and periodic automatic sync

When background indexing is enabled, `serve --mcp` starts a native file watcher over the configured directories. File changes are coalesced into automatic syncs, with periodic rescans to recover missing native events. `.codegraph/config.yaml` controls the rate:

```yaml
background:
  enabled: true
  intervalSeconds: 30
```

Set `enabled: false` or `intervalSeconds: 0` to disable automatic indexing. Manual `sync` and `index` always run immediately. Existing projects with no YAML background stanza keep the legacy event debounce, configurable through `CODEGRAPH_WATCH_DEBOUNCE_MS` (100–60000ms), and gain periodic rescans. See [Configuration](/codegraph/getting-started/configuration/) for directory selection, exclusions, and live config reload.

### 2. Per-file staleness banner — covers the debounce window

Between a write and the next configured sync, a file can be newer on disk than in the index. If a tool response references a pending file, it adds a staleness banner:

```
⚠️ Some files referenced below were edited since the last index sync —
their codegraph entries may be stale:
  - src/Widget.ts (edited 800ms ago, pending sync)
For accurate content of those specific files, Read them directly.
The rest of this response is fresh.

## Code Context
…
```

Agents can read the named files for current content while waiting for sync; the freshness warning remains separate from the configured background rate.

Pending files **not** referenced by the response surface as a small footer instead (`(Note: N file(s) elsewhere in this project are pending index sync but were not referenced above: …)`). Either way, the signal is explicit.

### 3. Connect-time catch-up — covers gaps when the MCP server wasn't running

When background indexing is enabled, connection-time catch-up reconciles files changed while the server was stopped. Disabling background indexing also disables this automatic catch-up. Request-time freshness checks still identify stale answers, and manual sync remains available immediately.

### Verify what the watcher sees

`codegraph_status` exposes the pending set first-class — useful for an agent asking "is the index caught up?" in one call:

```
codegraph_status →
  ## CodeGraph Status
  …
  ### Pending sync:
  - src/Widget.ts (edited 1200ms ago)
```

If `### Pending sync:` isn't in the response, nothing is in flight.

### When manual `codegraph sync` makes sense

Almost never. The edge cases:

- **Background indexing is disabled.** Use manual sync with `background.enabled: false`, `intervalSeconds: 0`, or `CODEGRAPH_NO_WATCH=1`. `CODEGRAPH_NO_DAEMON=1` selects direct MCP mode and does not by itself disable watching.
- **Pre-flight before a CI run.** If you're scripting against the index outside an agent session, a single `codegraph sync` at the start of the script guarantees the index reflects the current working tree.

Otherwise: just use it. The watcher + banner + connect-sync covers the AI-assisted workflow end-to-end. If you're seeing files genuinely missed after the debounce window has passed, that's a bug — please file an issue with a reproduction.

> See the v0.9.5 release notes for the [staleness banner (#403)](https://github.com/colbymchenry/codegraph/releases/tag/v0.9.5) and the connect-time catch-up (#414); both shipped together.

## Check status

```bash
codegraph status
```

Reports node/edge/file counts, the active SQLite backend, and the journal mode. In an agent session, the MCP-side `codegraph_status` additionally surfaces the `### Pending sync:` block described above.

## What gets indexed

Supported source files within `directories`, minus explicit `exclude` patterns, dependency/build directories excluded by default (`node_modules`, `vendor`, `dist`, …), anything your `.gitignore` excludes, and files over 1 MB. See [Configuration](/codegraph/getting-started/configuration/).
