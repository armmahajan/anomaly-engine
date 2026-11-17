import type { z } from "zod";
import type { ProjectSpec } from "@anomaly/core";

/** One domain's share of the build assistant: tool text and schemas for its operations, and its part of the project summary. */
export interface DomainTools<Op extends string> {
  descriptions: Record<Op, string>;
  /** Parameter schemas the model sees (the operations validate fully). */
  schemas: Record<Op, z.ZodType>;
  /** Lines for the project summary. */
  summary: (project: ProjectSpec) => string[];
}
