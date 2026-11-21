#!/usr/bin/env bash
#
# Build a self-contained CodeGraph bundle: an official Bun runtime + the
# compiled app + its production deps. CodeGraph does not need a host runtime.
#
# Because dropping better-sqlite3 left zero native addons, the recipe is pure
# file-packaging (download the target's Bun, copy the app, archive) — so any
# platform's bundle can be built on any OS. A host Bun builds the app, npm
# installs from package-lock.json, and the target Bun is never run here.
#
# Usage:
#   scripts/build-bundle.sh <target> [bun-version]
#     target:        darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64
#                  | win32-x64 | win32-arm64
#     bun-version:   e.g. 1.4.4 (default below; pin for reproducible builds)
#
# Output:
#   unix:    release/codegraph-<target>.tar.gz   (launcher: bin/codegraph)
#   windows: release/codegraph-<target>.zip      (launchers: bin/codegraph + .cmd)
set -euo pipefail

TARGET="${1:?usage: build-bundle.sh <target> [bun-version]}"
# Keep the workflow's host Bun pin in sync with this bundled runtime default.
BUN_VERSION="${2:-1.4.4}"
BUN_VERSION="${BUN_VERSION#v}"
if ! [[ "$BUN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "[bundle] error: expected a Bun release version (e.g. 1.4.4), got ${BUN_VERSION}" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/release"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

OSFAM="${TARGET%-*}"   # darwin | linux | win32

echo "[bundle] target=${TARGET} bun=${BUN_VERSION}"

# 1. Download + extract the official Bun runtime for the target platform.
# Use x64 baseline builds to support CPUs without AVX2. Keep the published
# checksum check before unpacking any archive (issue #2780).
case "$TARGET" in
  darwin-arm64) BUN_DIST=bun-darwin-aarch64 ;;
  darwin-x64)   BUN_DIST=bun-darwin-x64-baseline ;;
  linux-arm64)  BUN_DIST=bun-linux-aarch64 ;;
  linux-x64)    BUN_DIST=bun-linux-x64-baseline ;;
  win32-arm64)  BUN_DIST=bun-windows-aarch64 ;;
  win32-x64)    BUN_DIST=bun-windows-x64-baseline ;;
  *) echo "[bundle] error: unsupported target ${TARGET}" >&2; exit 1 ;;
esac
BUN_ARCHIVE="${BUN_DIST}.zip"
BUN_RELEASE="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"
echo "[bundle] downloading ${BUN_RELEASE}/${BUN_ARCHIVE}"
curl -fsSL "${BUN_RELEASE}/${BUN_ARCHIVE}" -o "$WORK/$BUN_ARCHIVE"
curl -fsSL "${BUN_RELEASE}/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
EXPECTED_SHA="$(awk -v name="$BUN_ARCHIVE" '$2 == name { print $1 }' "$WORK/SHASUMS256.txt")"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA="$(sha256sum < "$WORK/$BUN_ARCHIVE" | cut -d' ' -f1)"
else
  ACTUAL_SHA="$(shasum -a 256 < "$WORK/$BUN_ARCHIVE" | cut -d' ' -f1)"   # macOS
fi
if ! [[ "$EXPECTED_SHA" =~ ^[0-9a-f]{64}$ ]] || [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "[bundle] error: ${BUN_ARCHIVE} does not match Bun ${BUN_VERSION}'s published SHA-256 (listed: ${EXPECTED_SHA:-nothing}, downloaded: ${ACTUAL_SHA})" >&2
  exit 1
fi
echo "[bundle] verified ${BUN_ARCHIVE} against Bun's SHASUMS256.txt (sha256 ${ACTUAL_SHA})"
if command -v unzip >/dev/null 2>&1; then
  unzip -q "$WORK/$BUN_ARCHIVE" -d "$WORK"
else
  tar -xf "$WORK/$BUN_ARCHIVE" -C "$WORK"   # bsdtar can read zip
fi
BUN_BIN="$WORK/$BUN_DIST/bun"
if [ "$OSFAM" = "win32" ]; then
  BUN_BIN="${BUN_BIN}.exe"
fi
[ -f "$BUN_BIN" ] || { echo "[bundle] error: Bun binary not found ($BUN_BIN)" >&2; exit 1; }

# 2. Build the app (compiled JS + copied wasm/schema assets).
echo "[bundle] building app"
( cd "$ROOT" && bun --bun run build >/dev/null )

# 3. Stage: app + production-only deps (pure JS/wasm → portable across platforms).
STAGE="$WORK/codegraph-${TARGET}"
mkdir -p "$STAGE/lib" "$STAGE/bin"
cp -R "$ROOT/dist" "$STAGE/lib/dist"
# The browser viewer rides along inside dist/viewer (built by the build script
# above). Fail here rather than shipping a bundle whose `codegraph ui` serves
# a 404 — the copy is verified, not assumed.
bun "$ROOT/scripts/check-ui-build.mjs" --root "$STAGE/lib"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGE/lib/"
echo "[bundle] installing production dependencies"
# The staged package.json declares the `ui` workspace but the bundle carries
# no ui/ source — only its build output. That is fine: ui/ has dev
# dependencies only, so --omit=dev skips the workspace outright and no link
# is created. (If a future npm starts erroring on the absent folder, stage a
# stub ui/package.json before this line rather than editing the lock.)
( cd "$STAGE/lib" && npm ci --omit=dev --ignore-scripts >/dev/null 2>&1 )
rm -f "$STAGE/lib/package-lock.json"

# 3b. Native extraction kernel (optional). Included when a prebuilt .node for
#     the target exists — release/kernel/<target>/codegraph-kernel.node (the
#     release workflow's prebuild artifacts) or the locally staged
#     codegraph-kernel/prebuilds/<target>/ (scripts/build-kernel.sh). Absent →
#     the bundle simply runs the wasm extraction path; the kernel is a
#     per-language speedup, never a requirement (see
#     docs/design/rust-kernel-migration-plan.md).
KERNEL_NODE=""
for candidate in "$ROOT/release/kernel/${TARGET}/codegraph-kernel.node" \
                 "$ROOT/codegraph-kernel/prebuilds/${TARGET}/codegraph-kernel.node"; do
  if [ -f "$candidate" ]; then KERNEL_NODE="$candidate"; break; fi
done
if [ -n "$KERNEL_NODE" ]; then
  mkdir -p "$STAGE/lib/kernel"
  cp "$KERNEL_NODE" "$STAGE/lib/kernel/codegraph-kernel.node"
  echo "[bundle] native kernel included ($KERNEL_NODE)"
else
  echo "[bundle] no native kernel for ${TARGET} — bundle uses the wasm extraction path"
fi

# 4. Vendored Bun + launchers, without Node/V8 flags.
if [ "$OSFAM" = "win32" ]; then
  cp "$BUN_BIN" "$STAGE/bun.exe"
  printf '@"%%~dp0..\\bun.exe" "%%~dp0..\\lib\\dist\\bin\\codegraph.js" %%*\r\n' \
    > "$STAGE/bin/codegraph.cmd"
  # Git Bash (including Claude Code hooks) does not resolve .cmd via PATHEXT.
  cat > "$STAGE/bin/codegraph" <<'LAUNCH'
#!/bin/sh
DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Preserve an inherited CODEGRAPH_HOST_PPID; do not replace it with MSYS's
# $PPID, which is not a native Windows PID usable by the orphan watchdog.
exec "$DIR/bun.exe" "$DIR/lib/dist/bin/codegraph.js" "$@"
LAUNCH
  chmod +x "$STAGE/bin/codegraph"
else
  cp "$BUN_BIN" "$STAGE/bun"
  chmod +x "$STAGE/bun"
  cat > "$STAGE/bin/codegraph" <<'LAUNCH'
#!/bin/sh
# Resolve symlinks (e.g. the ~/.local/bin/codegraph link install.sh creates) so
# we find the real bundle dir, not the symlink's location.
SELF="$0"
while [ -L "$SELF" ]; do
  target="$(readlink "$SELF")"
  case "$target" in
    /*) SELF="$target" ;;
    *) SELF="$(dirname "$SELF")/$target" ;;
  esac
done
DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
# Thread the MCP host's pid to the server's orphan watchdog (issue #1185).
# $PPID is our parent — the host itself when it launched this script directly;
# an already-threaded value (the npm shim sets the true host pid) wins.
CODEGRAPH_HOST_PPID="${CODEGRAPH_HOST_PPID:-$PPID}"
export CODEGRAPH_HOST_PPID
exec "$DIR/bun" "$DIR/lib/dist/bin/codegraph.js" "$@"
LAUNCH
  chmod +x "$STAGE/bin/codegraph"
fi

# 5. Archive (.zip for Windows, .tar.gz otherwise).
mkdir -p "$OUT"
if [ "$OSFAM" = "win32" ]; then
  ARCHIVE="$OUT/codegraph-${TARGET}.zip"
  rm -f "$ARCHIVE"
  ( cd "$WORK" && zip -rqX "$ARCHIVE" "codegraph-${TARGET}" )
else
  ARCHIVE="$OUT/codegraph-${TARGET}.tar.gz"
  # --no-xattrs: don't embed macOS xattrs that make GNU tar warn on Linux.
  tar --no-xattrs -czf "$ARCHIVE" -C "$WORK" "codegraph-${TARGET}"
fi
echo "[bundle] wrote ${ARCHIVE} ($(du -h "$ARCHIVE" | cut -f1))"
