/**
 * A filter box for a long side-panel list. Escape clears it, ↓ moves into the
 * list (see listKeys.ts). Pair it with `matchesQuery` and ListSection's `forceOpen`:
 *
 *   const [query, setQuery] = useState("");
 *   const shown = rooms.filter((r) => matchesQuery(query, r.name, r.id));
 *   <ListFilter value={query} onChange={setQuery} label="Filter rooms" shown={shown.length} total={rooms.length} />
 */
export function ListFilter({
  value,
  onChange,
  label,
  placeholder,
  shown,
  total,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name, e.g. "Filter rooms". */
  label: string;
  placeholder?: string;
  /** With `total`: "3 of 45" while filtering. */
  shown?: number;
  total?: number;
}) {
  const filtering = value.trim() !== "";
  return (
    <div className={`list-filter${filtering ? " filtering" : ""}`}>
      <input
        type="search"
        data-list-filter=""
        aria-label={label}
        placeholder={placeholder ?? `${label}…`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange("");
          }
        }}
      />
      {filtering && shown !== undefined && (
        <span className="list-filter-count" aria-live="polite">
          {total !== undefined ? `${shown} of ${total}` : shown}
        </span>
      )}
      {filtering && (
        <button type="button" className="list-filter-clear" aria-label="Clear the filter" title="Clear (Esc)" onClick={() => onChange("")}>
          ×
        </button>
      )}
    </div>
  );
}

/** Whether every word of `query` appears in the texts (case-insensitive); an empty query matches everything. */
export function matchesQuery(query: string, ...texts: (string | null | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = texts.filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => haystack.includes(w));
}
