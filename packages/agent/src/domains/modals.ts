import type { DomainTools } from "./types.ts";

/** The build assistant's tools for agent E: modals and the map (one entry per core operation of that domain). */
export const modalTools: DomainTools<never> = {
  descriptions: {},
  schemas: {},
  summary: () => [],
};
