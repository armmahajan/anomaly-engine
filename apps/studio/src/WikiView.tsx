import { useEffect, useRef, useState } from "react";
import {
  kindLabel,
  slugify,
  SUGGESTED_KINDS,
  suggestedFields,
  uniqueId,
  wikiGaps,
  wikiKinds,
  wikiLinks,
  type ChangeResult,
  type ProjectSpec,
  type WikiPage,
} from "@anomaly/core";
import type { Session } from "./session.ts";
import { WikiText } from "./WikiText.tsx";
import { ConfirmButton, ListFilter, ListSection, matches } from "./content/ListSection.tsx";

type PageDraft = Pick<WikiPage, "kind" | "title" | "summary" | "body" | "fields"> & { characterId?: string };

/** What the wiki tab shows: a page (or the overview), and whether it is being edited or a new page written. */
export type WikiNav = { pageId: string | null; editing: null | "page" | { template: Partial<PageDraft> } };

interface SidebarProps {
  project: ProjectSpec;
  session: Session;
  nav: WikiNav;
  setNav: (nav: WikiNav) => void;
  locked: boolean;
}

export function WikiSidebar({ project, session, nav, setNav, locked }: SidebarProps) {
  const [reviewOnly, setReviewOnly] = useState(false);
  const [query, setQuery] = useState("");
  const { pages } = project.wiki;
  const drafts = reviewOrder(project);
  const shown = pages.filter((p) => (!reviewOnly || p.status === "draft") && matches(query, p.title, p.summary, p.id, kindLabel(p.kind)));
  const gaps = wikiGaps(project);
  const characterName = (id?: string) => project.characters.find((c) => c.id === id)?.name ?? id ?? "";
  const acceptAll = async () => {
    const result = await session.applyBatch(drafts.map((p) => ({ name: "acceptWikiPage", input: { pageId: p.id } })));
    if (!result.ok) session.reportProblem(result.error.message);
  };

  return (
    <section className="wiki-sidebar">
      <div className="side-head">
        <h2>Wiki</h2>
        <button type="button" disabled={locked} onClick={() => setNav({ pageId: null, editing: { template: { kind: "character" } } })}>
          + Page
        </button>
      </div>
      {drafts.length > 0 && (
        <div className="review-bar" data-testid="wiki-review-bar">
          <p>
            <strong>{drafts.length}</strong> draft{drafts.length === 1 ? "" : "s"} by the director to review
          </p>
          <div className="review-actions">
            <button type="button" onClick={() => setNav({ pageId: drafts[0]!.id, editing: null })}>
              Review next →
            </button>
            <button type="button" aria-pressed={reviewOnly} className={reviewOnly ? "toggled" : ""} onClick={() => setReviewOnly(!reviewOnly)}>
              Needs review ({drafts.length})
            </button>
            <ConfirmButton
              label="Accept all…"
              question={`Make all ${drafts.length} drafts canon? (Undo reverts it.)`}
              confirmLabel={`Accept ${drafts.length}`}
              disabled={locked}
              onConfirm={() => void acceptAll()}
            />
          </div>
        </div>
      )}
      {pages.length === 0 ? (
        <p className="hint">The wiki is empty. Describe your game to the director, or add a page.</p>
      ) : (
        <ListFilter value={query} onChange={setQuery} placeholder={`Filter ${pages.length} pages`} label="Filter pages" />
      )}
      {pages.length > 0 && shown.length === 0 && <p className="hint">No page matches.</p>}
      {wikiKinds({ pages: shown }).map((kind) => {
        const inKind = shown.filter((p) => p.kind === kind);
        return (
          <ListSection
            key={kind}
            title={kindLabel(kind)}
            count={inKind.length}
            forceOpen={query !== "" || inKind.some((p) => p.id === nav.pageId)}
          >
            <ul className="character-list">
              {inKind.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    data-testid={`wiki-page-${p.id}`}
                    className={p.id === nav.pageId ? "selected" : ""}
                    onClick={() => setNav({ pageId: p.id, editing: null })}
                  >
                    {p.title}
                    {p.status === "draft" && <span className="kind draft-tag">draft</span>}
                  </button>
                </li>
              ))}
            </ul>
          </ListSection>
        );
      })}
      {gaps.length > 0 && (
        <div className="wiki-gaps" data-testid="wiki-gaps">
          <ListSection title="Gaps" count={gaps.length}>
            <ul>
              {gaps.map((gap, i) => (
                <li key={i}>
                  {gap.message}
                  {gap.code === "unwritten_character" && (
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() =>
                        setNav({
                          pageId: null,
                          editing: { template: { kind: "character", title: characterName(gap.characterId), characterId: gap.characterId } },
                        })
                      }
                    >
                      Write page
                    </button>
                  )}
                  {gap.pageId && (
                    <button type="button" onClick={() => setNav({ pageId: gap.pageId!, editing: null })}>
                      Open
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </ListSection>
        </div>
      )}
    </section>
  );
}

/** Drafts in the order the sidebar lists them (by kind, then as written): the review queue. */
function reviewOrder(project: ProjectSpec): WikiPage[] {
  const { pages } = project.wiki;
  return wikiKinds(project.wiki).flatMap((kind) => pages.filter((p) => p.kind === kind && p.status === "draft"));
}

interface MainProps {
  project: ProjectSpec;
  session: Session;
  nav: WikiNav;
  setNav: (nav: WikiNav) => void;
  locked: boolean;
  onOpenCharacter: (characterId: string) => void;
}

export function WikiMain({ project, session, nav, setNav, locked, onOpenCharacter }: MainProps) {
  // Another page (or the editor) starts at its top, not where the last one was scrolled to.
  const top = useRef<HTMLSpanElement>(null);
  const editing = nav.editing === null ? "read" : nav.editing === "page" ? "edit" : "new";
  useEffect(() => {
    top.current?.closest(".wiki-pane")?.scrollTo({ top: 0 });
  }, [nav.pageId, editing]);
  const anchor = <span ref={top} hidden />;
  const { pages } = project.wiki;
  const page = pages.find((p) => p.id === nav.pageId) ?? (nav.pageId === null ? pages.find((p) => p.kind === "overview") : undefined);
  const titles = new Map(pages.map((p) => [p.id, p.title]));
  const report = (result: ChangeResult) => {
    if (!result.ok) session.reportProblem(result.error.message);
    return result.ok;
  };

  if (nav.editing !== null && (nav.editing !== "page" || page)) {
    const isNew = nav.editing !== "page";
    const initial: PageDraft = isNew
      ? { kind: "lore", title: "", summary: "", body: "", fields: {}, ...(nav.editing as { template: Partial<PageDraft> }).template }
      : page!;
    const save = async (values: PageDraft, characterChanged: boolean) => {
      if (isNew) {
        const id = uniqueId(slugify(values.title, "page"), pages.map((p) => p.id));
        const page = { ...values, id, status: "canon" };
        if (report(await session.applyOperation("createWikiPage", { page }))) setNav({ pageId: id, editing: null });
      } else {
        // The link is sent only when the creator changed it here: the studio may have linked the page meanwhile.
        const { characterId, ...rest } = values;
        const changes = { ...rest, ...(characterChanged && { characterId: characterId || null }), status: "canon" };
        if (report(await session.applyOperation("updateWikiPage", { pageId: page!.id, changes }))) setNav({ pageId: page!.id, editing: null });
      }
    };
    return (
      <>
        {anchor}
        <PageEditor
        key={isNew ? "new" : page!.id}
        initial={initial}
        project={project}
        locked={locked}
        heading={isNew ? "New page" : `Editing “${page!.title}”`}
        onSave={(values, characterChanged) => void save(values, characterChanged)}
        onCancel={() => setNav({ pageId: page?.id ?? null, editing: null })}
        />
      </>
    );
  }

  if (!page) {
    return (
      <div className="wiki-main wiki-empty">
        {anchor}
        <h1>Your game's wiki</h1>
        <p className="hint">
          The wiki is the game's bible: its story, characters, places and lore. Tell the director your creative direction and it
          drafts the rest for you to accept, edit or discard. Everything you write yourself is canon.
        </p>
      </div>
    );
  }

  const linkedFrom = pages.filter((p) => wikiLinks(p.body).includes(page.id));
  const character = project.characters.find((c) => c.id === page.characterId);
  const queue = reviewOrder(project);
  const nextDraft = queue.find((p) => p.id !== page.id);
  const hasFacts = Object.keys(page.fields).length > 0 || page.characterId;
  return (
    <article className="wiki-main" data-testid="wiki-article">
      {anchor}
      <div className="wiki-meta">
        <span className="tag">{kindLabel(page.kind)}</span>
        {page.status === "canon" && <span className="tag canon">Canon</span>}
        {page.status === "canon" && nextDraft && (
          <button type="button" className="wiki-next" onClick={() => setNav({ pageId: nextDraft.id, editing: null })}>
            Next draft to review →
          </button>
        )}
        <button type="button" className="wiki-edit" disabled={locked} onClick={() => setNav({ pageId: page.id, editing: "page" })}>
          Edit
        </button>
      </div>
      {page.status === "draft" && (
        <div className="wiki-review" data-testid="wiki-review">
          <div className="wiki-review-text">
            <span className="tag draft">Draft by the director</span>
            <span className="hint">
              Accept it as canon, edit it (saving makes it canon), or discard it.
              {queue.length > 1 && ` ${queue.findIndex((p) => p.id === page.id) + 1} of ${queue.length} drafts.`}
            </span>
          </div>
          <div className="wiki-review-actions">
            <button
              type="button"
              className="primary"
              disabled={locked}
              onClick={() => void session.applyOperation("acceptWikiPage", { pageId: page.id }).then(report)}
            >
              Accept
            </button>
            <button
              type="button"
              disabled={locked}
              title="Delete this draft (Undo restores it)"
              onClick={async () => {
                if (report(await session.applyOperation("deleteWikiPage", { pageId: page.id }))) setNav({ pageId: nextDraft?.id ?? null, editing: null });
              }}
            >
              Discard
            </button>
            {nextDraft && (
              <button type="button" className="wiki-skip" onClick={() => setNav({ pageId: nextDraft.id, editing: null })}>
                Skip →
              </button>
            )}
          </div>
        </div>
      )}
      <h1>{page.title}</h1>
      {page.summary && <p className="wiki-summary">{page.summary}</p>}
      <div className={`wiki-body${hasFacts ? " with-facts" : ""}`}>
        {hasFacts && (
          <dl className="wiki-fields">
            {Object.entries(page.fields).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
            {page.characterId && (
              <div>
                <dt>in the game</dt>
                <dd>
                  {character ? (
                    <button type="button" className="wiki-link" onClick={() => onOpenCharacter(character.id)}>
                      {character.name} →
                    </button>
                  ) : (
                    <span className="wiki-link missing">{page.characterId} (deleted)</span>
                  )}
                </dd>
              </div>
            )}
          </dl>
        )}
        <WikiText text={page.body} titles={titles} onNavigate={(id) => setNav({ pageId: id, editing: null })} />
      </div>
      {linkedFrom.length > 0 && (
        <p className="wiki-backlinks">
          Linked from:{" "}
          {linkedFrom.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ", "}
              <button type="button" className="wiki-link" onClick={() => setNav({ pageId: p.id, editing: null })}>
                {p.title}
              </button>
            </span>
          ))}
        </p>
      )}
    </article>
  );
}

interface EditorProps {
  initial: PageDraft;
  project: ProjectSpec;
  locked: boolean;
  heading: string;
  onSave: (values: PageDraft, characterChanged: boolean) => void;
  onCancel: () => void;
}

function PageEditor({ initial, project, locked, heading, onSave, onCancel }: EditorProps) {
  const [title, setTitle] = useState(initial.title);
  const [kind, setKind] = useState(initial.kind);
  const [summary, setSummary] = useState(initial.summary);
  const [body, setBody] = useState(initial.body);
  const [characterId, setCharacterId] = useState(initial.characterId ?? "");
  const [originalCharacterId] = useState(initial.characterId ?? "");
  const [fields, setFields] = useState<[string, string][]>(() => {
    const rows = Object.entries(initial.fields);
    const missing = suggestedFields(initial.kind).filter((k) => !(k in initial.fields));
    return [...rows, ...missing.map((k): [string, string] => [k, ""])];
  });
  const kinds = [...new Set([...SUGGESTED_KINDS.map((k) => k.kind as string), ...wikiKinds(project.wiki)])];
  const validKind = /^[a-z][a-z0-9_]*$/.test(kind);
  const setField = (i: number, at: 0 | 1, value: string) => setFields(fields.map((row, j) => (j === i ? (at === 0 ? [value, row[1]] : [row[0], value]) : row)));

  const submit = () =>
    onSave({
      title: title.trim(),
      kind,
      summary: summary.trim(),
      body,
      fields: Object.fromEntries(fields.filter(([k, v]) => k.trim() && v.trim()).map(([k, v]) => [k.trim(), v.trim()])),
      ...(characterId && { characterId }),
    }, characterId !== originalCharacterId);

  return (
    <form
      className="wiki-main wiki-editor"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h1>{heading}</h1>
      <div className="field">
        <label htmlFor="wiki-title">Title</label>
        <input id="wiki-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div className="wiki-row">
        <div className="field">
          <label htmlFor="wiki-kind">Kind</label>
          <input
            id="wiki-kind"
            list="wiki-kinds"
            value={kind}
            aria-invalid={!validKind}
            onChange={(e) => setKind(e.target.value.toLowerCase().replace(/\s+/g, "_"))}
          />
          <datalist id="wiki-kinds">
            {kinds.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label htmlFor="wiki-character">In-game character</label>
          <select id="wiki-character" value={characterId} onChange={(e) => setCharacterId(e.target.value)}>
            <option value="">none</option>
            {project.characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="wiki-summary">Summary</label>
        <input id="wiki-summary" value={summary} maxLength={300} onChange={(e) => setSummary(e.target.value)} />
      </div>
      <div className="field">
        <label>Fields</label>
        {fields.map(([k, v], i) => (
          <div className="wiki-field-row" key={i}>
            <input aria-label={`field ${i + 1} name`} value={k} placeholder="name" onChange={(e) => setField(i, 0, e.target.value)} />
            <input aria-label={k ? `${k} value` : `field ${i + 1} value`} value={v} placeholder="value" onChange={(e) => setField(i, 1, e.target.value)} />
            <button type="button" className="icon-button" aria-label={`remove field ${k || i + 1}`} onClick={() => setFields(fields.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setFields([...fields, ["", ""]])}>
          + Field
        </button>
      </div>
      <div className="field">
        <label htmlFor="wiki-body">Body</label>
        <textarea id="wiki-body" rows={16} value={body} onChange={(e) => setBody(e.target.value)} />
        <p className="hint">Markdown: # heading, - list, 1. numbered, &gt; quote, **bold**, *emphasis*, `code`. Link pages with [[page_id]] or [[page_id|text]].</p>
      </div>
      <div className="list-actions">
        <button type="submit" disabled={locked || !title.trim() || !validKind}>
          Save as canon
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
