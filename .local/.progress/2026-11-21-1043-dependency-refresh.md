---
id: PG-2026-11-21-1043-dependency-refresh
title: Audit and refresh dependencies
stub: dependency-refresh
created: 2026-11-21-1043
updated: 2026-11-21-1043
status: completed
priority: high
tags:
  - dependencies
  - security
related: []
---

# Audit and refresh dependencies

## Report

- Root/UI, site, dashboard, and worker npm lockfile audits reported zero vulnerabilities after remediation. Root/Vite and Astro site builds succeeded on Node 22.23.4; seven focused regression suites passed (177 tests). Site built 21 pages with non-fatal i18n/404 warnings. Telemetry `wrangler types` and `tsc --noEmit` passed in both projects, with the checked-in example environment for the dashboard.
- Root updated Vitest to 4.1.12, Vite to 7.3.8, Rollup to 4.68.8, and `ignore` to 7.0.16. Site migrated the Astro, Starlight, Markdown and Sharp stack together. Telemetry updated Wrangler and affected transitives. Bundled Node default moved to 24.22.3 (SQLite 3.54.1); `bash -n` passed, but platform bundles were not rebuilt.
- Upstream ignore-matching and SQLite improvements are not measured CodeGraph memory or performance gains. Kept `web-tree-sitter` unchanged because its WASM export and grammar link-format compatibility require a separate migration. No deployment or remote-repository benchmark was run.
