import type { z } from "zod";
import type { ProjectSpec } from "@anomaly/core";

/** A read-only tool of a domain: it looks at the project (with this turn's staged changes) and answers. */
export interface DomainReadTool {
  name: string;
  description: string;
  schema: z.ZodType;
  run: (project: ProjectSpec, args: unknown) => unknown;
}

/** One domain's share of the build assistant: tool text and schemas for its operations, and its part of the project summary. */
export interface DomainTools<Op extends string> {
  descriptions: Record<Op, string>;
  /** Parameter schemas the model sees (the operations validate fully). */
  schemas: Record<Op, z.ZodType>;
  /** Lines for the project summary. */
  summary: (project: ProjectSpec) => string[];
  /** Read-only tools (e.g. reading the design documents, checking the game). */
  reads?: DomainReadTool[];
}
