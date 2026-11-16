import type { z } from "zod";

/** Pull a JSON object out of a model reply (tolerates code fences and chatter around it). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("reply contains no JSON object");
  return JSON.parse(candidate.slice(start, end + 1));
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; problems: string };

/** Parse and validate; `problems` is short enough to send back to the model for a repair. */
export function parseReply<T extends z.ZodType>(schema: T, text: string): Parsed<z.infer<T>> {
  let json: unknown;
  try {
    json = extractJson(text);
  } catch (error) {
    return { ok: false, problems: `not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues.slice(0, 12).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  const more = result.error.issues.length > 12 ? ` (+${result.error.issues.length - 12} more)` : "";
  return { ok: false, problems: issues.join("; ") + more };
}
