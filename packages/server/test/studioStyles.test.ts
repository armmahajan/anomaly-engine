import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A lost brace silently disables every rule after it (it happened twice in merges), so check the shape.
describe("studio styles.css", () => {
  it("has balanced braces and no merge markers", () => {
    const css = readFileSync(new URL("../../../apps/studio/src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    let depth = 0;
    for (const [i, line] of css.split("\n").entries()) {
      for (const ch of line) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
        expect(depth, `line ${i + 1}`).toBeGreaterThanOrEqual(0);
      }
      // A new top-level rule can only start at depth 0 (or 1 inside @media/@keyframes).
      if (/^[.#a-z@:][^{]*\{\s*$/i.test(line) && !line.startsWith(" ")) expect(depth, `rule opened inside another at line ${i + 1}: ${line}`).toBeLessThanOrEqual(1);
    }
    expect(depth).toBe(0);
    expect(css).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
  });
});
