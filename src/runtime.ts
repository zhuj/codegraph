const MIN_BUN_VERSION = [1, 4, 4] as const;

/** Node and the bundled launcher keep their own compatibility rules. */
export function unsupportedBunReason(version = process.versions.bun): string | undefined {
  if (version === undefined) return;

  const stableVersion = /^(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(version);
  if (stableVersion) {
    let difference = 0;
    for (const [i, minimum] of MIN_BUN_VERSION.entries()) {
      difference = Number(stableVersion[i + 1]) - minimum;
      if (difference !== 0) break;
    }
    if (difference >= 0) return;
  }

  return `Unsupported Bun ${version}: CodeGraph requires a stable Bun ${MIN_BUN_VERSION.join('.')} or newer.`;
}
