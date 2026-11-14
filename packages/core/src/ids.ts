/** Helpers for generating valid, unique snake_case ids. */

/** "Fast Crawler!" -> "fast_crawler". Falls back to `fallback` if nothing usable remains. */
export function slugify(text: string, fallback = "item"): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[0-9_]+/, "")
    .slice(0, 48);
  return slug || fallback;
}

/** `base`, or `base_2`, `base_3`, … whichever is not taken. */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
