export const norm = (text: string): string => text.normalize("NFC").replace(/[\s\p{P}\p{S}]/gu, "");

/** Require every complete fragment in source order; extra speech is diagnostic, not an omission. */
export function orderedMatch(text: string, head: readonly string[], options: readonly string[] = []): {
  readonly missing: string | null;
  readonly positions: readonly number[];
  readonly repetitions: readonly { readonly fragment: string; readonly extraOccurrences: number }[];
} {
  const normalized = norm(text);
  const positions: number[] = [];
  const repetitions = [...head, ...options.map((label, i) => `${i + 1}번 ${label}`)].flatMap((fragment) => {
    const needle = norm(fragment);
    const count = needle ? normalized.split(needle).length - 1 : 0;
    return count > 1 ? [{ fragment, extraOccurrences: count - 1 }] : [];
  });
  let cursor = 0;
  for (const fragment of head) {
    const needle = norm(fragment);
    const position = normalized.indexOf(needle, cursor);
    if (position < 0) return { missing: fragment, positions, repetitions };
    positions.push(position);
    cursor = position + needle.length;
  }
  for (const [i, label] of options.entries()) {
    // No arbitrary distance limit between a number and its label. A repeated phrase
    // may intervene, but a later option cannot supply an omitted label.
    const marker = `${i + 1}번`;
    const needle = norm(label);
    let found = -1;
    for (let p = normalized.indexOf(marker, cursor); p >= 0; p = normalized.indexOf(marker, p + marker.length)) {
      const after = p + marker.length;
      const nextMarker = normalized.slice(after).search(/\d+번/u);
      const end = nextMarker < 0 ? normalized.length : after + nextMarker;
      const q = normalized.indexOf(needle, after);
      if (q >= 0 && q + needle.length <= end) {
        found = q;
        break;
      }
    }
    if (found < 0) return { missing: `${marker} ${label}`, positions, repetitions };
    positions.push(found);
    cursor = found + needle.length;
  }
  return { missing: null, positions, repetitions };
}
