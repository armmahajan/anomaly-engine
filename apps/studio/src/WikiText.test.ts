import { describe, expect, it } from "vitest";
import { parseBlocks } from "./WikiText.tsx";

describe("wiki markdown blocks", () => {
  it("splits a heading from the paragraph right under it, and a list from its heading", () => {
    const blocks = parseBlocks("## Pitch\nTars wakes in a city.\nIt loops.\n\n## Themes\n- Identity\n- Recovery");
    expect(blocks).toEqual([
      { type: "heading", level: 2, text: "Pitch" },
      { type: "paragraph", text: "Tars wakes in a city. It loops." },
      { type: "heading", level: 2, text: "Themes" },
      { type: "list", list: { ordered: false, start: 1, items: [{ text: "Identity", children: null }, { text: "Recovery", children: null }] } },
    ]);
  });

  it("nests indented items, keeps ordered lists' start, and reads quotes, rules and code", () => {
    const blocks = parseBlocks("3. three\n4. four\n   - sub\n     more of sub\n\n> said\n> once\n\n---\n```\nx = 1\n```");
    expect(blocks[0]).toEqual({
      type: "list",
      list: {
        ordered: true,
        start: 3,
        items: [
          { text: "three", children: null },
          { text: "four", children: { ordered: false, start: 1, items: [{ text: "sub more of sub", children: null }] } },
        ],
      },
    });
    expect(blocks.slice(1)).toEqual([{ type: "quote", text: "said once" }, { type: "rule" }, { type: "code", text: "x = 1" }]);
  });

  it("ends a list at a paragraph line that isn't indented", () => {
    expect(parseBlocks("- a\nAfter.").map((b) => b.type)).toEqual(["list", "paragraph"]);
  });
});
