/** Terminal-safe, cell-width-bounded [dir-path], sampled once per frame. */
export function formatProgressPath(directory: string, availableColumns: number, stringWidth: (text: string) => number): string {
  // Never let a filename inject escapes, carriage returns, newlines or bidi controls.
  const safe = directory.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '?');
  const room = Math.max(0, Math.floor(availableColumns) - 3); // leading space + brackets
  if (room < 1) return '';
  if (stringWidth(safe) <= room) return ` [${safe}]`;
  if (room < 4) return ` [${'.'.repeat(room)}]`;
  let suffix = '';
  let width = 0;
  for (const char of Array.from(safe).reverse()) {
    const next = stringWidth(char);
    if (width + next > room - 3) break;
    suffix = char + suffix;
    width += next;
  }
  return ` [...${suffix}]`;
}
