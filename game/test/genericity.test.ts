import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Game mechanics are generic primitives composed by data: no code path may be
// about a role (a boss, a bench, a lever, a key door). Roles live in content
// (fixtures, test data, the director's design documents), never in the
// runtime or the gameplay domains.

const ROOT = join(import.meta.dirname, "../..");
const SCOPES = [
  "game/scripts",
  "game/primitives",
  "packages/core/src/behavior.ts",
  "packages/core/src/events",
  "packages/core/src/props",
  "packages/core/src/modals",
  "packages/core/src/combat",
  "packages/core/src/world",
  "apps/studio/src/HandlerEditor.tsx",
  "apps/studio/src/GameView.tsx",
  "apps/studio/src/PropsSection.tsx",
  "apps/studio/src/PropsOverlay.tsx",
  "apps/studio/src/ItemsPanel.tsx",
  "apps/studio/src/ModalsPanel.tsx",
  "apps/studio/src/MapSettings.tsx",
  "apps/studio/src/SpawnDetails.tsx",
];
const ROLE_WORDS = /\b(boss|bosses|miniboss|bench|benches|lever|levers|keydoor|key_door|locked_door)\b/i;
/** Content, not code. */
const CONTENT = /fixture/i;

function files(path: string): string[] {
  const full = join(ROOT, path);
  if (!statSync(full, { throwIfNoEntry: false })) return [];
  if (statSync(full).isFile()) return [path];
  return readdirSync(full).flatMap((name) => files(join(path, name)));
}

describe("generic primitives", () => {
  it("no runtime or gameplay-domain code names a role", () => {
    const hits = SCOPES.flatMap(files)
      .filter((f) => /\.(ts|tsx|gd)$/.test(f) && !CONTENT.test(f))
      .flatMap((f) =>
        readFileSync(join(ROOT, f), "utf8")
          .split("\n")
          .flatMap((line, i) => (ROLE_WORDS.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : [])),
      );
    expect(hits).toEqual([]);
  });
});
