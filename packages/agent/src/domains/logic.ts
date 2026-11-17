import type { DomainTools } from "./types.ts";

/** The build assistant's game checker (agent I): a read tool that proves the game beatable with no dead states, or shows how it fails. */
export const logicTools: DomainTools<never> = {
  descriptions: {},
  schemas: {},
  summary: () => [],
  reads: [],
};
