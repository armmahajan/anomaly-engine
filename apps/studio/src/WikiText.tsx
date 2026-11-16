import { Fragment, type ReactNode } from "react";

/**
 * Minimal Markdown for wiki bodies: # headings, - bullet lists, paragraphs,
 * **bold**, *emphasis* and [[page_id]] / [[page_id|label]] links.
 */
export function WikiText({ text, titles, onNavigate }: { text: string; titles: Map<string, string>; onNavigate: (id: string) => void }) {
  const inline = (line: string) => renderInline(line, titles, onNavigate);
  return (
    <div className="wiki-text">
      {text
        .split(/\n\s*\n/)
        .filter((block) => block.trim())
        .map((block, i) => {
          const lines = block.split("\n").filter((l) => l.trim());
          const heading = /^(#{1,3})\s+(.*)$/.exec(lines[0]!);
          if (heading && lines.length === 1) {
            const Tag = (["h2", "h3", "h4"] as const)[heading[1]!.length - 1]!;
            return <Tag key={i}>{inline(heading[2]!)}</Tag>;
          }
          if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
            return (
              <ul key={i}>
                {lines.map((l, j) => (
                  <li key={j}>{inline(l.replace(/^\s*[-*]\s+/, ""))}</li>
                ))}
              </ul>
            );
          }
          return <p key={i}>{inline(lines.join(" "))}</p>;
        })}
    </div>
  );
}

const TOKEN = /\[\[([a-z][a-z0-9_]*)(?:\|([^\]\n]+))?\]\]|\*\*([^*]+)\*\*|\*([^*]+)\*/g;

function renderInline(text: string, titles: Map<string, string>, onNavigate: (id: string) => void): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    out.push(text.slice(last, m.index));
    const [, linkId, label, bold, em] = m;
    if (linkId) {
      const title = titles.get(linkId);
      out.push(
        title === undefined ? (
          <span key={m.index} className="wiki-link missing" title={`No page "${linkId}" yet`}>
            {label ?? linkId}
          </span>
        ) : (
          <button key={m.index} type="button" className="wiki-link" onClick={() => onNavigate(linkId)}>
            {label ?? title}
          </button>
        ),
      );
    } else if (bold) out.push(<strong key={m.index}>{bold}</strong>);
    else out.push(<em key={m.index}>{em}</em>);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return <Fragment>{out}</Fragment>;
}
