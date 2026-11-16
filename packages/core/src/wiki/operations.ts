import { z } from "zod";
import { Id } from "../common.ts";
import type { OperationError, OperationResult } from "../operations.ts";
import { ProjectSpec } from "../schema.ts";
import { PageStatus, WikiPage } from "./wiki.ts";

/**
 * Wiki operations: same contract as ../operations.ts (pure, untrusted input,
 * whole-project validation on success). Imports from ../operations.ts are
 * type-only to avoid a module cycle.
 */

type Fail = { ok: false; error: OperationError };

function fail(code: OperationError["code"], message: string, issues: OperationError["issues"] = []): Fail {
  return { ok: false, error: { code, message, issues } };
}

const issuesOf = (error: z.ZodError, prefix = "") =>
  error.issues.map((i) => ({ path: prefix + i.path.join("."), message: i.message }));

function commit(next: ProjectSpec): OperationResult {
  const parsed = ProjectSpec.safeParse({ ...next, revision: next.revision + 1 });
  if (!parsed.success) return fail("invalid_result", "operation would leave the project invalid", issuesOf(parsed.error));
  return { ok: true, project: parsed.data };
}

function findPage(project: ProjectSpec, pageId: string): { ok: true; index: number; page: WikiPage } | Fail {
  const index = project.wiki.pages.findIndex((p) => p.id === pageId);
  const page = project.wiki.pages[index];
  if (page) return { ok: true, index, page };
  const ids = project.wiki.pages.map((p) => p.id);
  return fail("not_found", `no wiki page "${pageId}"${ids.length ? ` (pages: ${ids.join(", ")})` : " (the wiki is empty)"}`);
}

const withPages = (project: ProjectSpec, pages: unknown[]) => ({ ...project, wiki: { ...project.wiki, pages } }) as ProjectSpec;

export const CreateWikiPageInput = z.strictObject({ page: z.unknown() });

export function createWikiPage(project: ProjectSpec, input: unknown): OperationResult {
  const parsedInput = CreateWikiPageInput.safeParse(input);
  if (!parsedInput.success) return fail("invalid_input", "createWikiPage input is malformed", issuesOf(parsedInput.error));
  const parsed = WikiPage.safeParse(parsedInput.data.page);
  if (!parsed.success) return fail("invalid_input", "wiki page is invalid", issuesOf(parsed.error, "page."));
  if (project.wiki.pages.some((p) => p.id === parsed.data.id)) {
    return fail("invalid_input", `a wiki page with id "${parsed.data.id}" already exists`);
  }
  return commit(withPages(project, [...project.wiki.pages, parsed.data]));
}

export const WikiPageChanges = z.strictObject({
  kind: Id.optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  body: z.string().optional().describe("Replaces the whole body."),
  fields: z.record(z.string(), z.string()).optional().describe("Replaces all fields (include the ones to keep)."),
  characterId: Id.nullable().optional().describe("Link to an in-game character; null unlinks."),
  status: PageStatus.optional(),
});

export const UpdateWikiPageInput = z.strictObject({ pageId: Id, changes: WikiPageChanges });

export function updateWikiPage(project: ProjectSpec, input: unknown): OperationResult {
  const parsed = UpdateWikiPageInput.safeParse(input);
  if (!parsed.success) return fail("invalid_input", "updateWikiPage input is malformed", issuesOf(parsed.error));
  const found = findPage(project, parsed.data.pageId);
  if (!found.ok) return found;
  const { characterId, ...changes } = parsed.data.changes;
  if (Object.keys(parsed.data.changes).length === 0) return fail("invalid_input", "nothing to change");
  const { characterId: currentCharacter, ...rest } = found.page;
  const linked = characterId === undefined ? currentCharacter : (characterId ?? undefined);
  const candidate = { ...rest, ...changes, ...(linked !== undefined && { characterId: linked }) };
  const page = WikiPage.safeParse(candidate);
  if (!page.success) return fail("invalid_input", `page "${found.page.id}" would be invalid`, issuesOf(page.error, "changes."));
  const pages = project.wiki.pages.slice();
  pages[found.index] = page.data;
  return commit(withPages(project, pages));
}

export const WikiPageRef = z.strictObject({ pageId: Id });

/** Approve a draft: it becomes canon. */
export function acceptWikiPage(project: ProjectSpec, input: unknown): OperationResult {
  const parsed = WikiPageRef.safeParse(input);
  if (!parsed.success) return fail("invalid_input", "acceptWikiPage input is malformed", issuesOf(parsed.error));
  const found = findPage(project, parsed.data.pageId);
  if (!found.ok) return found;
  if (found.page.status === "canon") return fail("invalid_input", `page "${found.page.id}" is already canon`);
  const pages = project.wiki.pages.slice();
  pages[found.index] = { ...found.page, status: "canon" };
  return commit(withPages(project, pages));
}

export function deleteWikiPage(project: ProjectSpec, input: unknown): OperationResult {
  const parsed = WikiPageRef.safeParse(input);
  if (!parsed.success) return fail("invalid_input", "deleteWikiPage input is malformed", issuesOf(parsed.error));
  const found = findPage(project, parsed.data.pageId);
  if (!found.ok) return found;
  return commit(withPages(project, project.wiki.pages.filter((p) => p.id !== found.page.id)));
}

export const wikiOperations = { createWikiPage, updateWikiPage, acceptWikiPage, deleteWikiPage };
export type WikiOperationName = keyof typeof wikiOperations;
export const WIKI_OPERATION_NAMES = Object.keys(wikiOperations) as WikiOperationName[];
