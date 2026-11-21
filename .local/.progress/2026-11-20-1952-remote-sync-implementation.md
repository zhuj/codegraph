---
id: PG-2026-11-20-1952-remote-sync-implementation
title: Implement large remote checkout indexing improvements
stub: remote-sync-implementation
created: 2026-11-20-1952
updated: 2026-11-20-2036
status: active
priority: high
tags:
  - indexing
  - performance
related:
  - PG-2026-11-20-1919-review
---

# Implement large remote checkout indexing improvements

User approved implementation after the [review](2026-11-20-1919-review.md). Keep explicit workspace intervals. Do not trust an unprovided remote change feed or promise power-loss durability. Prioritize source integrity, avoid redundant requests, and preserve equivalent graph results.

## Acceptance criteria

- [x] Verify inherited default and new templates use 600 seconds and explicit old values remain intact.
- [x] Verify observed source errors do not erase existing graph rows and genuine deletions still reconcile.
- [x] Verify paged stored file metadata and timestamp-only reuse against focused regressions.
- [x] Verify explicit interrupted-index resume in the combined integration run.
- [x] Verify bounded metadata concurrency after discovery.
- [ ] Implement durable directory inventory and discovery overlap under an agreed source freshness contract.

## Progress Log

### 2026-11-20 19:52 | First slice started

600-second config tests failed for the expected old default before implementation (exit 1, two failures). Updated workspace default, template, docs and tests; green checks running. The source integrity lane is delegated; inventory and resumability follow reconciliation. Target remote performance remains unmeasured.

### 2026-11-20 19:53 | Default verified

`./node_modules/.bin/vitest run --project engine __tests__/workspace-config.test.ts __tests__/workspace-discovery.test.ts` passed: 2 suites, 56 tests. Scope includes absent and partial YAML, rendered template, explicit legacy 30 and disabling by zero. Next: reconcile source-integrity lane and integrate inventory work.

### Source reconciliation lane verified in focused tests

Inspected the source and 13 new cases. Focused developer verification passed; parent combined verification is pending. The patch preserves rows on typed stat errors and observed fallback-walk errors, and checks in-run source identity before deletion. It does not guarantee discovery completeness or persistent mount identity across runs. The next lane replaces eager stored file loading with bounded keyset pages and evaluates guarded timestamp-only reuse. Durable directory discovery and resume remain separate acceptance items.

### Stored file metadata and timestamp-only reuse verified

Combined standard engine command passed: `./node_modules/.bin/vitest run --project engine __tests__/workspace-config.test.ts __tests__/workspace-discovery.test.ts __tests__/sync-filesystem-observation.test.ts __tests__/sync.test.ts __tests__/sync-rebuild-convergence.test.ts` (5 suites, 157 tests). A 521-row fixture uses 256/256/9-row pages and no eager inventory load; touched-but-identical files use one content read across two syncs. Full enumeration and changed/removal worklists remain. Explicit interrupted-index resume is delegated next; no exact persisted scan frontier yet.

### Resume implemented; bounded metadata concurrency started

Inspected resume diff and tests. Focused worker checks: 12 resume CLI, 2 explicit-path index and 1 recovery-marker test passed. The command reuses committed graph state; incompatible or incomplete verification is refused or remains resumable. It still enumerates source and reruns recovery passes. Added user docs and release notes. Next: bounded metadata operations after discovery, then combined validation. No trusted source feed has been established; pre-discovery stats cannot yet be used to declare freshness.

### 2026-11-20 20:36 | Combined verification

`./node_modules/.bin/vitest run --project engine __tests__/workspace-config.test.ts __tests__/workspace-discovery.test.ts __tests__/sync-filesystem-observation.test.ts __tests__/sync.test.ts __tests__/sync-rebuild-convergence.test.ts __tests__/cli-index-resume.test.ts __tests__/cli-index-explicit-path.test.ts` passed: 7 suites, 173 tests. `git diff --check` passed. Async stat regression proved the eight-operation batch bound, sorted application, and root revalidation. No measured 100k+ workload, real mount validation, durable directory inventory or scan checkpoint. Next decision: identify the source change contract before using persisted observations to skip source checks.

### Mutable checkout contract selected

User confirmed a live mutable checkout. Inventory observations are scheduling hints, not evidence that source files are current; retain authoritative full discovery and fail-closed deletion checks. Dispatched bounded directory persistence and a real consumer; avoid adding a write-only cache. `/usr/bin/node` is supported Node 22.23.4 and can run the next combined validation.

### Directory inventory prerequisite identified

Directory persistence was not added: the scanner currently has no ordered coverage events, and force-include discovery can omit still-existing files on errors. A persisted hint cannot distinguish that from a deliberate policy exclusion. Started failure-propagation prerequisite and supported Node 22 baseline. Next after guard: ordered scope-qualified directory outcomes before a durable scheduling consumer.

### Force-include coverage guarded

The typed discovery-failure hook now covers observed force-include errors in both Git and fallback discovery. Source-only focused run: RED 3 expected failures, GREEN 24 passed. The post-change combined engine run on Node 22.23.4 passed: 7 suites, 177 tests. Silent omissions and Git-to-fallback transitions are not certified. A directory scheduler needs ordered discovery outcomes with explicit coverage before durable observations can safely affect scheduling or removal; this work did not create or migrate a directory table.
