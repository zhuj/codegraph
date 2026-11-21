# Distribution: self-contained bundles

CodeGraph ships Bun alongside the app and uses its `node:sqlite` compatibility
layer for SQLite with WAL and FTS5. Users do not need Bun or Node.js installed to
run the standalone bundle. The optional Rust extraction kernel is shipped as a
prebuilt addon where available; otherwise extraction uses Tree-sitter WASM.

## What's in a bundle

Built by [`scripts/build-bundle.sh`](scripts/build-bundle.sh) — one archive per
platform, with a Bun binary for each target:

```
codegraph-<target>/
  bun | bun.exe            # official Bun runtime for <target>
  lib/
    dist/                  # compiled app (+ tree-sitter .wasm grammars, schema.sql)
    node_modules/          # production deps only (pure JS / wasm — portable)
  bin/
    codegraph | codegraph.cmd   # launcher → runs the bundled Bun with the app
```

Targets: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`,
`win32-arm64`. Unix targets produce `.tar.gz` (shell launcher); Windows produces
`.zip` (`bun.exe` + a `.cmd` launcher).

```bash
scripts/build-bundle.sh linux-x64            # -> release/codegraph-linux-x64.tar.gz
scripts/build-bundle.sh win32-x64            # -> release/codegraph-win32-x64.zip
```

The Bun runtime comes from the official Bun release selected by the script's
default `BUN_VERSION` (or its second argument). The download is refused
unless it matches the SHA-256 listed in that release's `SHASUMS256.txt`.

The packaging step does not run the target Bun binary or build the optional
kernel. The release matrix packages all targets on one Linux runner. Run-testing
a bundle requires the target platform or emulation.

## Install channels (all deliver the same bundle)

1. **`curl | sh`** ([`install.sh`](install.sh)) — no Node required; ideal for a
   fresh Linux VPS over SSH. Detects os/arch, pulls the archive from GitHub
   Releases, symlinks `codegraph` onto PATH. Re-run to upgrade; `--uninstall` to
   remove.
2. **npm** ([`scripts/npm-shim.js`](scripts/npm-shim.js)) — preserves
   `npm i -g @colbymchenry/codegraph`. The main package is a tiny shim; the
   bundles ship as per-platform `optionalDependencies`
   (`@colbymchenry/codegraph-<target>` with `os`/`cpu`), so npm installs only the
   matching one. The shim — run by the user's Node — execs the bundle, so the
    real work runs on the bundled Bun. On Windows it invokes `bun.exe` directly
    rather than spawning the `.cmd` launcher, which modern Node does not accept.
    The shim can also run older Node-based bundles.
3. **Windows** ([`install.ps1`](install.ps1)) — `irm … | iex`; same flow as
    install.sh (detect arch, pull the `.zip` from Releases, add to PATH).
4. **Homebrew / Scoop** — TODO (tap + cask pointing at the Release archives).

## Release pipeline

For the first update from a standalone Node-based Windows bundle, rerun the
current PowerShell installer. The old `codegraph upgrade` executable expects
`node.exe` in the incoming archive and cannot install a Bun-only archive.

[`.github/workflows/release.yml`](.github/workflows/release.yml) — manually
triggered. Reads the version from `package.json`, builds every platform bundle on
one runner, creates the GitHub Release (notes from `CHANGELOG.md`), and publishes
the npm shim + per-platform packages. Requires the `NPM_TOKEN` repo secret.

Still TODO:
- **Code signing** — the main gap for "download & run": macOS Gatekeeper needs a
  Developer ID + notarization; Windows needs Authenticode. Homebrew softens the
  macOS case (handles quarantine).
- Re-wire `npm uninstall` cleanup (the agent-config `preuninstall`) through the
  shim — the generated main package doesn't carry it.
