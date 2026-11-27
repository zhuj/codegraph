---
id: indexing-performance-review
name: indexing-performance-review
title: CodeGraph indexing, rescanning and parsing performance review
description: Audit current working tree at ecf8763e plus existing uncommitted indexing changes. Trace CLI/library index and sync, discovery, source identity/hash, parse pipeline, SQLite/reference work, related docs and tests; preserve graph/FTS correctness, ordering, recovery, bounded resources and platform compatibility. Exclude generated/vendor/build output as sources, other product areas, production, destructive checks and implementation. Linux Node 22, source inspection and isolated local review probes only; other workloads/platforms not yet reviewed.
createdAt: 2026-11-27T21:43:35.630Z
updatedAt: 2026-11-27T21:56:53.191Z
retiredAt: null
tags: {}
metadata: {}
outcome: Audit current working tree at ecf8763e plus existing uncommitted indexing changes. Trace CLI/library index and sync, discovery, source identity/hash, parse pipeline, SQLite/reference work, related docs and tests; preserve graph/FTS correctness, ordering, recovery, bounded resources and platform compatibility. Exclude generated/vendor/build output as sources, other product areas, production, destructive checks and implementation. Linux Node 22, source inspection and isolated local review probes only; other workloads/platforms not yet reviewed.
acceptance:
  - Record scoped evidence and confidence, coverage and limits, alternatives, priority and an unapproved remediation plan.
status: completed
nextAction: Await separate implementation approval. Start with the IDX-01 verification policy and IDX-02 compatibility fence; fix IDX-03 independently if approved.
blockers: []
verification:
  state: passed
  note: Scoped review acceptance only; remediation, full suite and platform performance not verified.
  testResult: Four independent probe commands and git diff --check exited 0; initial cold-WASM setup failure diagnosed and reproduced separately.
  recordedAt: 2026-11-27T21:52:05.934Z
checkpoints:
  - id: 090efcb7-7497-4383-8a67-353ae931bd5e
    note: Saved the scoped review and unapproved remediation checklist with five confirmed findings, one hypothesis and two optional improvements.
    recordedAt: 2026-11-27T21:52:05.934Z
    verificationState: passed
    verification:
      state: passed
      note: Scoped review acceptance only; remediation, full suite and platform performance not verified.
      testResult: Four independent probe commands and git diff --check exited 0; initial cold-WASM setup failure diagnosed and reproduced separately.
      recordedAt: 2026-11-27T21:52:05.934Z
    evidence: "Isolated candidate Node 22 checks: preserved-mtime, cold WASM, clock-control/rollback, scoped inventory, fake recycle, SHA parity; source and earlier logs cited in body."
    testResult: Four independent probe commands and git diff --check exited 0; initial cold-WASM setup failure diagnosed and reproduced separately.
  - id: c249b92b-817c-4212-8095-7fd08a77e379
    note: Added the measured no-change synthesis finding and unapproved options after the baseline commit.
    recordedAt: 2026-11-27T21:56:53.191Z
    verificationState: passed
    evidence: Three Node 22 Linux scratch trials, exit 0, identical normalized graph and sampled search digests; measured callback-synthesis stage plus total wall.
relations:
  parent: null
  dependsOn: []
---
## Executive summary

The current indexing changes measurably reduce work for a compatible in-place reindex, but incremental sync can still miss a real edit before it ever computes a checksum. A second, narrower correctness issue is reuse of incompatible extraction after a wall-clock rollback. The clearest remaining work reductions are eliminating whole-file-list reads from a scoped sync and avoiding a parser worker restart after its last job. Keep the current checksum semantics: a one-shot SHA-256 call provided only a small hash-only improvement, and switching to raw bytes does not preserve all stored hashes.

## Scope and baseline

- Current first-party working tree based on ecf8763e (Speed up Go dynamic dispatch linking), including the previously landed-in-working-tree, uncommitted indexing optimizations and tests. This is not a review of the released npm package or just the diff. No implementation approved here.
- Expected behavior: changed-source graph converges where inputs are observable; compatible reuse must not preserve stale graph or FTS rows; preserves stable ordering, bounded memory/I/O, write locking, interruption recovery, and safe native/WASM fallback. Performance claims use live or prior comparable evidence, not complexity alone.
- Entry points: CLI index / index --resume (src/bin/codegraph.ts:897–998), public CodeGraph.indexAll / sync / indexFiles, watcher-driven scoped/full reconciliation. Pipeline: discovery and bounded readers → metadata and content fingerprint → parse/workers → SQLite graph and search → resolution/synthesis. Engine Vitest suites mirror these paths; UI is a separate Vitest project.
- Reviewed project AGENTS.md and relevant README and historical benchmark docs. .local/docs and .local/spec are absent; no native project specs or memory records found in their configured directories. Prior .local/.progress/2026-11-20-1919-review.md is historical and terminal; the separate remote implementation record was not changed. Its earlier duplicate-stat/whole-inventory account does not describe current full reconciliation in one respect: file inventory is now paged and a single tracked reconcile probe serves removal and change classification. The current scoped inventory issue below is separate. README correctly calls CLI index a fresh rebuild, not a compatible in-place repair. The warm unit test for indexFiles does not prove the compiled cold WASM path. The current same-size/mtime reconciliation comment overstates the observable changes, as IDX-01 shows.
- Linux Node 22.23.5; isolated fixtures or read-only probes only. Excluded generated output/vendor/build artifacts as source (used the previously built scratch binary only for probes), UI/installer, individual grammar quality, production/remote access, security audit of unrelated interfaces, deployment, full suite, installs, source fixes, commits and pushes.

### Coverage

| Area | State | Evidence or gap |
| --- | --- | --- |
| Scan, hashing, source identity and cache reuse | Reviewed | Traced scoped/full discovery, paged SQLite reconciliation, metadata and content gates, size stamps, public diagnostic and live fixtures; no NFS/macOS/Windows timing. |
| Fresh, compatible in-place, sparse, resume and cancellation | Reviewed for entry points and invalidation | CLI/library source, prior parity logs, clock replay; not a new interrupted-build or crash matrix. |
| Parsing, native/WASM and workers | Partially reviewed | Warm/cold fallback and recycle probed, read-ahead and worker order reviewed; individual grammars, platform teardown and workload timings not revalidated. |
| SQLite, resolution, FTS and synthesis | Partially reviewed | Keyset/read/write mechanics, WAL/FTS compatibility and prior graph parity; not all SQL or synthesis passes. |
| Tests, documentation, incomplete work, conventions and compatibility | Partially reviewed | Current relevant tests and docs; no additional accepted feature gap or relevant intentional stub identified in sampled paths. Not a repository-wide TODO, dependency, config or migration census. |
| Trust boundaries and operations | Partially reviewed | Bounded read, publication, file-lock and failure handling in scope. No security verdict, production calls, installer or deployment review. |

## High

### IDX-01 · Metadata can suppress the content check (confirmed; high confidence)

src/extraction/index.ts:4342–4363, 4439–4463; stored src/db/queries.ts:424–435. A changed candidate should not retain old symbols merely because it has the same length and millisecond mtime. On a 27-byte TypeScript file, replacing first with other and restoring the original mtime made scoped and full sync report zero modifications with the original digest and symbol. getChangedFiles reported the edit, and indexAll corrected it. The superseding filesystem evidence is never read by sync in this case; changing SHA implementations cannot help. High: silent wrong graph from a plausible timestamp-preserving copy/restore/export; reach depends on filesystem and writer, no frequency measured.

| Option | Approach | Pros | Cons and risks | Effort/complexity | Expected benefit |
| --- | --- | --- | --- | --- | --- |
| A (recommended) | Hash exact scoped change hints even when stat fields tie; add a conservative strict verification route for full sync and use richer persisted identity hints where supported. | Fixes the common watcher/explicit-path case without rereading the whole tree on every sync. | Strict full verification costs I/O; schema/update semantics for ctime, inode/device and timestamp precision need platform tests. Never treat any of them as content proof. | Medium; larger if schema evolves | Correctness for hinted/coarse changes; retain cheap ordinary no-op sync. |
| B | Hash every in-scope file on every full sync, and selected paths in scoped sync. | Strong detection independent of timestamp restoration. | Out-of-proportion remote I/O, especially under daemon timer; keep bounded/uncertain observations and oversize policy. | Small–medium | Direct exact verification at no-op cost. |
| C | Keep the stat-only fast exit and document preserved-time limitation with an explicit rebuild fallback. | No cost or schema change. | Silent stale graph remains; acceptable only as temporary mitigation; revisit with confirmed workload incidence. | Small | Users can diagnose and recover, not prevention. |

## Medium

### IDX-02 · Bulk compatibility depends on wall-clock ordering (confirmed; high confidence)

src/index.ts:997–1005 and src/extraction/index.ts:2774–2787, 3190–3201. Reuse must prove extraction with compatible inputs, not merely a timestamp. On a Next/Expo app-manifest round trip, a normal later indexFiles write was re-extracted and restored the route. Applying a -60 s Date.now offset only during that write made it sort before the bulk fence; successful indexAll after restoring both the clock and manifest did not restore GET /api/check. Medium: silent result, but requires both a backward step and an intervening write under different inputs. Existing normal-clock regression test covers the control, not this case.

| Option | Approach | Pros | Cons and risks | Effort/complexity | Expected benefit |
| --- | --- | --- | --- | --- | --- |
| A (recommended) | Store explicit compatible extraction provenance or a DB-backed write generation; migrate old/unknown rows through a conservative reparse. | Durable, independent of clock and restart; precise reuse. | Schema or dedicated provenance storage; review all writer paths, partial writes and upgrades. | Medium–large | Correct reuse with predictable compatibility. |
| B | Invalidate the compatibility stamp after non-bulk writes that cannot safely prove provenance, even if timestamps appear normal. | Small fail-safe, no time math. | Conservative fallback can erase the sparse reindex win after ordinary writes; measure its scope. | Small–medium | Immediate correctness, potentially slower in-place reindex. |

### IDX-03 · Cold public indexFiles can miss WASM grammar initialization (confirmed; high confidence)

src/index.ts:1049–1068, src/extraction/index.ts:3439–3449 and 3635–3646, src/extraction/grammars.ts:347, 524. Targeted reparse is expected to use the fallback when native routing is off. Compiled process with CODEGRAPH_KERNEL=0: a bulk index succeeded; subsequent public indexFiles after reopen returned parser_error, no replacement. Explicitly loading just TypeScript in-process then made the same write succeed. Warm source tests passed before this audit, not a contradiction of the cold compiled result. Medium: valid fallback loses targeted reparse; no evidence that CLI index or sync fail in this way.

| Option | Approach | Pros | Cons and risks | Effort/complexity | Expected benefit |
| --- | --- | --- | --- | --- | --- |
| A (recommended) | Reuse targeted grammar preparation for indexFiles, using effective language and the native routing check; support discovered exceptions lazily. | Fixes cold calls without loading every grammar. | Handle overrides/content-disambiguated languages, stale scopes and current error contracts. | Small–medium | Works without an out-of-band preload; avoids loading unrelated grammars. |
| B | Make the public per-file parse seam lazily prepare the effective WASM grammar before extracting. | Consistent across callers and mixed inputs. | Broader hot-path change; must avoid making already-ready files await redundant work or displacing pooling. | Medium | Cold correctness more generally; bounded startup. |

### IDX-04 · A one-path sync still materializes repository-wide path lists (confirmed cost shape; high confidence, large-project timing unknown)

src/index.ts:1077–1080, 1346–1350, 1819–1842; src/resolution/index.ts:1073–1078; src/db/queries.ts:4641–4646. Scoped extraction is intended to limit per-event work. In a non-Python 24-file checkout, one unchanged scoped candidate reported one checked and zero modified, but getAllFilePaths returned all 24 paths four times: two Python pre/post snapshots and two resolver context calls. This is row materialization on the query boundary, not evidence of four physical disk scans. Medium: common watcher route and cost grows with inventory, but no demonstrated large-project latency yet. Full sync still needs trustworthy discovery and removal reconciliation.

| Option | Approach | Pros | Cons and risks | Effort/complexity | Expected benefit |
| --- | --- | --- | --- | --- | --- |
| A (recommended) | Start with Python pre/post work: use precise deltas or SQL path filtering without changing suffix/override semantics; profile the remaining two resolver calls independently. | Removes broadest needless JS row loads on ordinary scoped events. | Preserve root/config changes, previously skipped parses, removals, init exports, case and extension overrides. | Medium | Lower work/heap for small edits at large N; unknown wall-clock effect. |
| B | Keep revision-scoped file inventories in the resolver and invalidate on all file/metadata changes; use ordered, paged reconciliation on uncertain observations. | May amortize resolver scans across daemon syncs. | Memory, freshness and invalidation ownership; don't trust missed watcher events. | Large | Further decrease stable scoped work if profiling warrants it. |

### IDX-05 · Routine recycling starts an unused parser at the tail (confirmed redundant work; high confidence, real cost unmeasured)

src/extraction/parse-pool.ts:315–319, 435–440, 456–466, 534–546. Normal growth considers remaining work; routine recycling immediately replaces a worker. Compiled pool + deterministic injected fake: one expected parse at recycle threshold produced one parse, two workers and two grammar-load messages. Teardown may await grammar startup. Medium: affects normal tail latency and memory on threshold crossings, not every run, and real startup bound is unmeasured.

| Option | Approach | Pros | Cons and risks | Effort/complexity | Expected benefit |
| --- | --- | --- | --- | --- | --- |
| A (recommended) | Retire at threshold but let demand decide when to start the replacement; keep crash/timeout/fresh-retry rules and ensure queued work always starts a worker. | Avoids proven speculative load; preserves cap and heap retirement. | Late arriving work can see cold startup; validate Windows safe teardown and inaccurate estimates. | Small–medium | Fewer unused workers; shorter tail where the grammar load matters. |
| B | Keep eager replacement except when remaining count and queue are both empty. | Narrow no-work optimization; less expected latency for later work. | Estimated counts can understate queued/later work; misses many unnecessary partial-pool replacements. | Small | Isolates proven final-job case. |

### IDX-06 · Normal CLI index has no compatible-reuse mode (optional, not a defect; high confidence in behavior)

src/bin/codegraph.ts:899, 956–998; README.md:545–547, 1051; src/index.ts:735–804. CLI deliberately starts fresh; SDK indexAll can reuse. Prior integrated benchmark (484-file input corpus, Linux) found median 3.70→2.22 s for no-change and 3.74→2.30 s after one edit with in-place reuse. Fresh samples were inconsistent; these figures do not estimate an actual CLI speedup. Medium: optional workflow improvement with evidence of possible benefit, not a gap against accepted behavior. Depends on IDX-01/02 policy and graph/recovery correctness.

| Option | Approach | Pros | Cons and risks | Effort/complexity | Expected benefit |
| --- | --- | --- | --- | --- | --- |
| A (recommended if demand is demonstrated) | Add a distinct explicit compatibility-checked reuse mode; keep normal index fresh, --resume for interrupted work and sync for ordinary edits. | Exposes a user-directed checksum-verified reindex without changing known CLI semantics. | New UX/flag contract, lock/recovery, old version and FTS behavior; requires separate approval. | Medium–large | Avoid unnecessary parsing/FTS for unchanged files on eligible operations. |
| B (now) | Improve guidance for rebuild vs sync vs SDK in-place index and defer new flag. | No compatibility change. | CLI users needing verification cannot select reuse; revisit when CLI workflows commonly pay repeated rebuild costs. | Small | Avoid unintended rebuilds for callers who only need sync. |

## Low

### IDX-07 · Hash API tuning is small, and byte swapping changes semantics (optional; high confidence in probe only)

src/extraction/index.ts:209–211, 4443–4463, 4789–4812; src/file-limits.ts:21–32; src/mcp/tools.ts:2894–2899. SHA-256 currently hashes decoded text or an oversize size stamp. A five-pair Node 22 hash-only probe (451 real strings, 9.63 MB per sweep, 200 sweeps per arm) yielded median 7828 ms createHash vs 7605 ms one-shot hash (~2.9% of the hash loop, not a pipeline gain). The APIs agreed for all sampled decoded inputs, including an invalid UTF-8 replacement case and the size stamp. SHA-256 over the original invalid UTF-8 bytes was different. Low: small measured CPU effect, no I/O savings, and shared consumers must agree.

| Option | Approach | Pros | Cons and risks | Effort/complexity | Expected benefit |
| --- | --- | --- | --- | --- | --- |
| A (recommended now) | Preserve stored SHA-256, avoid unnecessary reads/decodes first; profile bytes hashed by stage. | No migration; moves the larger observed work first. | Leaves small hash-call overhead; revisit only if profiles show material hash CPU. | Small | Protects compatibility and avoids pointless cache churn. |
| B | Optionally use compatible one-shot SHA-256 on the same text with a capability fallback and a shared checksum helper. | Current hex values preserved when input is identical. | Only measured in a microbenchmark; test older supported runtimes and CLI/MCP agreement. | Small | Small hash-stage savings if reproduced. |

### IDX-08 · Failed-reference writes may benefit from batching (hypothesis; high confidence in call count, low in speedup)

src/db/queries.ts:4917–4929; src/resolution/index.ts:3089; docs/design/rust-kernel-migration-plan.md:894–903. Projection sped up reads separately. Parking a failed ref still calls stmt.run once per attempted row inside a transaction; historical marks-in-stage total was 5.3–6.5 s and does not isolate boundary versus B-tree cost. Low: fresh, failure-heavy projects only, optimization not warranted without a modern profile. The separate prerequisite sparse scan is real, but prior full-WAL-lifecycle candidate already lost (partial index 9.05 s vs baseline 8.09 s on 1M synthetic rows); do not add that DDL based on query-only VM-step evidence.

| Option | Approach | Pros | Cons and risks | Effort/complexity | Expected benefit |
| --- | --- | --- | --- | --- | --- |
| A (recommended as a spike) | Profile mark-heavy workload; compare cached prepare/per-row runs with bounded set-based, row-ID keyed writes at the same transaction boundaries. | Isolates whether reducing calls matters before changing code. | Preserve duplicates/affected row counts, name-tail and retry semantics, order of edge persistence, SQLite compatibility and WAL overhead. | Medium | Possible fewer crossings; no estimated speedup. |
| B | Keep existing transaction and revisit when marks show up materially in current end-to-end profiles. | Lowest risk; B-tree writes remain either way. | Does not reduce call overhead; revisit on measured failure-heavy bottleneck. | None now | Avoids speculative complexity. |

## Pending action checklist

- [ ] IDX-01: define the targeted-verification policy in extraction sync; add equal-size/preserved mtime, sub-ms, atomic replacement, missed-event, remote/legacy fallback and oversize regressions. Require graph/FTS convergence and measure full/scoped no-op I/O. Medium estimate; no dependency.
- [ ] IDX-02: choose explicit provenance or fail-closed interim fencing across src/index.ts, extraction and DB owners. Require normal and rolled-back controls, reopen, old rows, interruption/retry and sparse-hit measurements. Medium–large; settle before expanding reuse.
- [ ] IDX-03: fix cold targeted parsing with native disabled; require compiled subprocess, prior bulk then reopen, mixed effective languages, missing grammar reporting, no eager unrelated grammar loads, existing write-lock coverage. Small–medium; can run in parallel with scoped identity design.
- [ ] IDX-04: eliminate measurable redundant list reads; first prove O(affected paths) work on unrelated scoped changes and retain Python roots, file moves and graph parity. Medium; profile large scoped/full workloads first.
- [ ] IDX-05: retain heap recycling but avoid unused worker; assert spawn/parses/load counts, late demand, retry and teardown. Compare real tail latency and peak RSS on a mixed workload. Small–medium; independent of IDX-04.
- [ ] IDX-06: document modes first; request approval before introducing an explicit CLI reuse contract. Benchmark binary behavior; keep ordinary rebuild and resume tests passing. Medium–large, blocked on IDX-01/02 policy and product choice.
- [ ] IDX-07: defer until profiling shows checksum CPU is material; require old/new digest parity for legacy, UTF-8/invalid UTF-8 and oversize, Node version fallback, and paired whole-index runs before adoption. Small; after IDX-01/04.
- [ ] IDX-08: profile real failure-heavy repos and compare ordered normalized graph, retry outcomes, marks time, WAL/peak RSS and total wall time. Medium; no DDL or WAL-policy changes without independent evidence.

## Validation and limitations

- New checks used inline assertion scripts piped to /usr/bin/node --liftoff-only --disable-warning=ExperimentalWarning with AUDIT_BUILD pointing to .tmp/index-read-ahead.7rmf1b/candidate/dist, all test databases disposable and outside the project index. cmp verified relevant working sources against that candidate's build inputs. Equal-mtime/diagnostic/reindex probe exit 0, clocks plus cold WASM with CODEGRAPH_KERNEL=0 exit 0, fake-worker + 24-file inventory and its caller-attribution probe exit 0. An initial combined clock attempt exited 1 on cold WASM setup, inspected separately; initialized grammar for both clock arms in the successful replay.
- Checksum probe: /usr/bin/node over the existing scratch corpus, comparing createHash('sha256').update(text).digest('hex') with crypto.hash('sha256', text, 'hex'); five alternating pairs, 451 strings, 200 iterations per arm, equivalence assertions and invalid UTF-8 raw disagreement. Exit 0. Hash-only synthetic loop, not an I/O or end-to-end claim.
- git diff --check exit 0. Prior evidence (not re-executed): .tmp/index-read-ahead.7rmf1b/{integrated-vitest.log,final-focused.log,integrated-bench.log} reports 202 and 33 passing focused checks (overlapping) and normalized files/nodes/edges/refs plus sampled FTS parity. .tmp/resolver-sql.fkBuPk benchmark was a prior targeted comparison, not a new proof of total index benefit. Independent reviewer supplied source evidence only; findings were checked against source, with parent probes where noted.
- Not run: full suite, current end-to-end A/B, representative huge remote checkout, Windows/macOS, production, browser, OpenCode, upgrades or interrupted rebuild matrix. Review is complete at the scoped depth, not a clean bill of health. No new specification or accepted performance budget was found.

## Progress log

- Oriented on current baseline and historical local progress; structured backend advertised, file-progress and file-memory adapters disabled. This work item is the single owner of this new audit, not a migration of the earlier PG record.
- Corroborated stale graph, cold WASM, scoped inventory and recycle findings; compared options and left every remediation item pending. No memory entry: branch-specific findings and unapproved proposals live here; existing checksum input semantics are already documented in source, and no new durable decision was accepted.

## Follow-up review

### IDX-09 · Verified no-change reindex still rebuilds callback synthesis (Medium; confirmed executed work and measured cost)

On committed baseline 857d828b, src/extraction/index.ts:3191–3204 counts reused files as indexed; src/index.ts:831–842 and 882–917 then run resolver reinitialization, synthesis and follow-up passes regardless of extraction writes. In three in-place no-op trials on a Linux Node 22 scratch corpus (452 discovered, 451 indexed), total wall time was 1.984–2.102 s; callback synthesis alone was 1.309–1.401 s (about two-thirds), with zero parse responses, zero net node/edge changes, and identical normalized files/nodes/edges/unresolved refs and three FTS queries. The 226–239 ms parse-loop wall includes reading 9.63 MB; summed overlapping I/O timings are not wall time. Runtime probe used CODEGRAPH_SYNTH_TIMINGS=1 set in-process and the prior scratch build whose relevant input files matched current source. One corpus, no before/after implementation or large remote evidence.

| Option | Approach | Pros | Cons and risks | Effort/complexity | Expected benefit |
| --- | --- | --- | --- | --- | --- |
| A (recommended) | Gate synthesis on separately proven clean graph and matching synthesis inputs, including external configuration and resolver state. Keep full fallback. | Directly targets measured cost. | Must account for removed files, dirty refs, parked refs whose binding inputs moved, deferred/incomplete state, overrides, resolver-only changes and revs. Net counts and matching file hashes alone are not proof. | Medium–large | Avoid repeat synthesis on proven no-ops; observed ~1.35 s phase on one fixture, not a projected speedup. |
| B | Reuse verified lexical inputs more broadly, but resolve and rewrite as today. | More conservative; can be staged per pass. | Parsing is not the only cost; memory and cache invalidation, unmeasured benefit. | Medium | Lower rescans with unchanged content, still redo linking. |

- [ ] IDX-09: establish a distinct synthesis-input compatibility token and explicit no-write extraction signal before introducing a skip; retain recovery and resolver-only invalidation paths. Require no-op, sparse edit with equal net counts, resolver-only config change, removal, pending recovery, reopen, ordered graph/FTS parity, and paired wall/RSS measurements. Coordinate with IDX-02 provenance before expanding reuse.

## Report

Scoped Linux review of current indexing, discovery, parsing and SQLite paths, plus relevant interfaces, tests and docs. No critical finding identified in scope. Unique findings: High 1 confirmed; Medium 4 confirmed and 1 optional; Low 1 hypothesis and 1 optional. IDX-01 is first: same-size updates with preserved mtime bypass SHA-256 and both sync modes left stale symbols in the probe. Next, make compatibility independent of wall time (IDX-02), restore cold targeted WASM parsing (IDX-03), then reduce whole-inventory and parser restart work (IDX-04/05). Keep SHA-256 and current input semantics; do not rush a CLI feature or SQL/schema optimization without workload evidence and approval. Full/platform/remote validation remains open; no product file, index or memory entry was changed in this review.

Follow-up on 857d828b: IDX-09 is one additional confirmed Medium finding, bringing Medium to five confirmed and one optional. Callback synthesis dominates the verified identical-graph in-place reindex on the sampled corpus. Consider it before checksum tuning, after compatibility correctness.
