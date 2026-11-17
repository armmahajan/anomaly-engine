import type { DomainTools } from "./types.ts";

/** The build assistant's view of the design documents (agent J): read tools for wiki pages and the progression, and a design summary. */
export const designTools: DomainTools<never> = {
  descriptions: {},
  schemas: {},
  summary: () => [],
  reads: [],
};
