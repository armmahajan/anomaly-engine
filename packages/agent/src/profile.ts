import type { AgentId, ProjectSpec } from "@anomaly/core";
import { buildSystemPrompt } from "./prompt.ts";
import { BUILD_TOOLS, type Toolset } from "./tools.ts";
import { buildNarrativePrompt } from "./narrative/prompt.ts";
import { NARRATIVE_TOOLS } from "./narrative/tools.ts";
import { buildArchitectPrompt } from "./architect/prompt.ts";
import { ARCHITECT_TOOLS } from "./architect/tools.ts";

/** One of the studio's agents: its instructions (rebuilt every turn from the project) and its tools. */
export interface AgentProfile {
  id: AgentId;
  systemPrompt: (project: ProjectSpec) => string;
  tools: Toolset;
}

export const buildAgent: AgentProfile = { id: "build", systemPrompt: buildSystemPrompt, tools: BUILD_TOOLS };
export const narrativeAgent: AgentProfile = { id: "narrative", systemPrompt: buildNarrativePrompt, tools: NARRATIVE_TOOLS };

export const architectAgent: AgentProfile = { id: "architect", systemPrompt: buildArchitectPrompt, tools: ARCHITECT_TOOLS };

export const AGENTS: Record<AgentId, AgentProfile> = { build: buildAgent, narrative: narrativeAgent, architect: architectAgent };
