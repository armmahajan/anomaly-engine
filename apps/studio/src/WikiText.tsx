import { Fragment, type ReactNode } from "react";

/**
 * Markdown for wiki bodies, parsed line by line (the director writes a heading
 * straight above its paragraph, without a blank line between):
 * # headings, - / * / 1. lists (nested by indent), > quotes, --- rules,
 * ``` code blocks, paragraphs; inline **bold**, *emphasis*, `code`,
 * ~~strike~~, [text](https://…) and [[page_id]] / [[page_id|label]] links.
 */
export function WikiText({ text, titles, onNavigate }: { text: string; titles: Map<string, string>; onNavigate: (id: string) => void }) {
  const blocks = parseBlocks(text);
  // The page title is the h1: the body's top heading level (# or ##, as written) becomes h2.
  const top = Math.min(...blocks.map((b) => (b.type === "heading" ? b.level : 6)));
  const ctx: Ctx = { titles, onNavigate, shift: top - 1 };
  return <div className="wiki-text">{blocks.map((block, i) => renderBlock(block, i, ctx))}</div>;
}

interface Ctx {
  titles: Map<string, string>;
  onNavigate: (id: string) => void;
  /** Heading levels to drop so the top one renders as h2. */
  shift: number;
}

interface ListItem {
  text: string;
  children: List | null;
}
interface List {
  ordered: boolean;
  start: number;
  items: ListItem[];
}
export type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; list: List }
  | { type: "quote"; text: string }
  | { type: "code"; text: string }
  | { type: "rule" };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*```/;
const QUOTE = /^\s*>\s?(.*)$/;

/** The body's blocks, in order. Exported for tests. */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (FENCE.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!);
      i++; // the closing fence
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length, text: heading[2]! });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(QUOTE.exec(lines[i++]!)![1]!);
      blocks.push({ type: "quote", text: body.join(" ") });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items: { indent: number; ordered: boolean; start: number; text: string }[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const m = LIST_ITEM.exec(l);
        if (m) {
          const marker = m[2]!;
          items.push({ indent: m[1]!.replace(/\t/g, "    ").length, ordered: /\d/.test(marker), start: parseInt(marker, 10) || 1, text: m[3]! });
          i++;
        } else if (l.trim() && /^\s+/.test(l) && items.length > 0 && !HEADING.test(l)) {
          // An indented continuation line belongs to the item above.
          items[items.length - 1]!.text += ` ${l.trim()}`;
          i++;
        } else break;
      }
      blocks.push({ type: "list", list: nestList(items) });
      continue;
    }
    const body: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (!l.trim() || HEADING.test(l) || LIST_ITEM.test(l) || RULE.test(l) || FENCE.test(l) || QUOTE.test(l)) break;
      body.push(l.trim());
      i++;
    }
    blocks.push({ type: "paragraph", text: body.join(" ") });
  }
  return blocks;
}

/** Flat items with indents into nested lists: deeper items belong to the item above them. */
function nestList(flat: { indent: number; ordered: boolean; start: number; text: string }[]): List {
  const root: List = { ordered: flat[0]!.ordered, start: flat[0]!.start, items: [] };
  const stack: { indent: number; list: List }[] = [{ indent: flat[0]!.indent, list: root }];
  for (const item of flat) {
    while (stack.length > 1 && item.indent < stack[stack.length - 1]!.indent) stack.pop();
    let top = stack[stack.length - 1]!;
    if (item.indent > top.indent && top.list.items.length > 0) {
      const parent = top.list.items[top.list.items.length - 1]!;
      parent.children ??= { ordered: item.ordered, start: item.start, items: [] };
      top = { indent: item.indent, list: parent.children };
      stack.push(top);
    }
    top.list.items.push({ text: item.text, children: null });
  }
  return root;
}

function renderBlock(block: Block, key: number, ctx: Ctx): ReactNode {
  switch (block.type) {
    case "heading": {
      const Tag = (["h2", "h3", "h4", "h5", "h5", "h5"] as const)[block.level - 1 - ctx.shift]!;
      return <Tag key={key}>{renderInline(block.text, ctx)}</Tag>;
    }
    case "paragraph":
      return <p key={key}>{renderInline(block.text, ctx)}</p>;
    case "list":
      return renderList(block.list, key, ctx);
    case "quote":
      return <blockquote key={key}>{renderInline(block.text, ctx)}</blockquote>;
    case "code":
      return (
        <pre key={key}>
          <code>{block.text}</code>
        </pre>
      );
    case "rule":
      return <hr key={key} />;
  }
}

function renderList(list: List, key: number, ctx: Ctx): ReactNode {
  const items = list.items.map((item, j) => (
    <li key={j}>
      {renderInline(item.text, ctx)}
      {item.children && renderList(item.children, 0, ctx)}
    </li>
  ));
  return list.ordered ? (
    <ol key={key} start={list.start === 1 ? undefined : list.start}>
      {items}
    </ol>
  ) : (
    <ul key={key}>{items}</ul>
  );
}

const TOKEN =
  /\[\[([a-z][a-z0-9_]*)(?:\|([^\]\n]+))?\]\]|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*([^*\s](?:[^*]*?[^*\s])?)\*|(?<![\w])_([^_\s](?:[^_]*?[^_\s])?)_(?![\w])/g;

function renderInline(text: string, ctx: Ctx): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [, linkId, label, extText, extUrl, code, bold, bold2, strike, em, em2] = m;
    const key = m.index;
    if (linkId) {
      const title = ctx.titles.get(linkId);
      out.push(
        title === undefined ? (
          <span key={key} className="wiki-link missing" title={`No page "${linkId}" yet`}>
            {label ?? linkId}
          </span>
        ) : (
          <button key={key} type="button" className="wiki-link" onClick={() => ctx.onNavigate(linkId)}>
            {label ?? title}
          </button>
        ),
      );
    } else if (extText && extUrl) {
      out.push(
        <a key={key} className="wiki-link" href={extUrl} target="_blank" rel="noreferrer noopener">
          {renderInline(extText, ctx)}
        </a>,
      );
    } else if (code !== undefined) out.push(<code key={key}>{code}</code>);
    else if (bold ?? bold2) out.push(<strong key={key}>{renderInline((bold ?? bold2)!, ctx)}</strong>);
    else if (strike) out.push(<s key={key}>{renderInline(strike, ctx)}</s>);
    else out.push(<em key={key}>{renderInline((em ?? em2)!, ctx)}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <Fragment>{out}</Fragment>;
}
