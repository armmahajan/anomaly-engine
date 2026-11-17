import type { DomainTools } from "./types.ts";

/** The build assistant's tools for agent D: props and items (one entry per core operation of that domain). */
export const propTools: DomainTools<never> = {
  descriptions: {},
  schemas: {},
  summary: () => [],
};
