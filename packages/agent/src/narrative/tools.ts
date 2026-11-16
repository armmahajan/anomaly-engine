import { z } from "zod";
import { Id, WikiPage, WikiPageChanges, wikiGaps, wikiLinks, type ProjectSpec } from "@anomaly/core";
import { projectSummaryTool, stageOperation, toolset, type Draft, type ToolSpec } from "../tools.ts";
import { summarizeWiki } from "./summary.ts";
import { progressionTools } from "./progression.ts";

/**
 * The director's wiki tools (progression tools are in ./progression.ts).
 * Everything it writes is a draft; canon pages (the creator's) can only be
 * changed when the creator asked for it.
 */

/** Gaps on the page just written. Links to pages created later in the same turn are expected. */
const pageWarnings = (pageId: string) => (project: ProjectSpec) =>
  wikiGaps(project)
    .filter((g) => g.pageId === pageId)
    .map((g) => (g.code === "broken_link" ? `${g.message} Fine if you create that page later this turn.` : g.message));

const ConfirmedByCreator = z
  .boolean()
  .optional()
  .describe("Only for canon pages: true when the creator explicitly asked for this change in this conversation.");

const NewPage = WikiPage.omit({ status: true });
const CreateInput = z.strictObject({ page: NewPage });
const UpdateInput = z.strictObject({ pageId: Id, changes: WikiPageChanges.omit({ status: true }), confirmedByCreator: ConfirmedByCreator });
const DeleteInput = z.strictObject({ pageId: Id, confirmedByCreator: ConfirmedByCreator });
const PageRef = z.strictObject({ pageId: Id });

const invalid = (error: z.ZodError) => ({
  ok: false,
  error: { code: "invalid_input", message: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
});

/** Refuse to touch a canon page unless the creator asked for it. */
function canonGuard(draft: Draft, pageId: string, confirmed: boolean | undefined, action: string) {
  const page = draft.current.wiki.pages.find((p) => p.id === pageId);
  if (page?.status !== "canon" || confirmed) return null;
  return {
    ok: false,
    error: {
      code: "canon_protected",
      message: `"${page.title}" is canon: the creator wrote or approved it. Don't ${action} it on your own; ask the creator. Only if they asked for exactly this in this conversation, call again with confirmedByCreator: true.`,
    },
  };
}

const narrativeTools: ToolSpec[] = [
  {
    name: "getWikiOutline",
    description: "Every wiki page in one line (with status), the overview in full, the wiki's gaps and the game's cast. Includes changes staged this turn.",
    schema: z.strictObject({}),
    run: (draft) => ({ ok: true, outline: summarizeWiki(draft.current) }),
  },
  {
    name: "getWikiPage",
    description: "One wiki page in full (body, fields, status), plus the pages that link to it.",
    schema: PageRef,
    run: (draft, args) => {
      const parsed = PageRef.safeParse(args);
      if (!parsed.success) return invalid(parsed.error);
      const { pages } = draft.current.wiki;
      const page = pages.find((p) => p.id === parsed.data.pageId);
      if (!page) return { ok: false, error: { code: "not_found", message: `no page "${parsed.data.pageId}" (pages: ${pages.map((p) => p.id).join(", ") || "none"})` } };
      return { ok: true, page, linkedFrom: pages.filter((p) => wikiLinks(p.body).includes(page.id)).map((p) => p.id) };
    },
  },
  projectSummaryTool,
  {
    name: "createWikiPage",
    description: "Write a new wiki page. It is saved as a draft for the creator to review.",
    schema: CreateInput,
    run: (draft, args) => {
      const parsed = CreateInput.safeParse(args);
      if (!parsed.success) return invalid(parsed.error);
      const { page } = parsed.data;
      return stageOperation(draft, "createWikiPage", { page: { ...page, status: "draft" } }, pageWarnings(page.id));
    },
  },
  {
    name: "updateWikiPage",
    description: "Change a wiki page (only the fields given; `fields` and `body` replace the old ones). Drafts stay drafts. Canon pages need the creator's request.",
    schema: UpdateInput,
    run: (draft, args) => {
      const parsed = UpdateInput.safeParse(args);
      if (!parsed.success) return invalid(parsed.error);
      const { pageId, changes, confirmedByCreator } = parsed.data;
      return (
        canonGuard(draft, pageId, confirmedByCreator, "change") ??
        stageOperation(draft, "updateWikiPage", { pageId, changes }, pageWarnings(pageId))
      );
    },
  },
  {
    name: "deleteWikiPage",
    description: "Delete a wiki page. You may delete your own drafts; canon pages need the creator's request.",
    schema: DeleteInput,
    run: (draft, args) => {
      const parsed = DeleteInput.safeParse(args);
      if (!parsed.success) return invalid(parsed.error);
      const { pageId, confirmedByCreator } = parsed.data;
      return canonGuard(draft, pageId, confirmedByCreator, "delete") ?? stageOperation(draft, "deleteWikiPage", { pageId }, () => []);
    },
  },
];

export const NARRATIVE_TOOLS = toolset([...narrativeTools, ...progressionTools]);
