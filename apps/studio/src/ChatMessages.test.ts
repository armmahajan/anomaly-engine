import { describe, expect, it } from "vitest";
import { tableCells } from "./ChatMessages.tsx";

describe("chat replies' Markdown tables", () => {
  it("split a table row into its cells; other lines aren't rows", () => {
    expect(tableCells("| Attack | Reach |")).toEqual(["Attack", "Reach"]);
    expect(tableCells("|---|:---:|")).toEqual(["---", ":---:"]);
    expect(tableCells("  | a | b")).toEqual(["a", "b"]);
    expect(tableCells("a | b")).toBeNull();
    expect(tableCells("|")).toBeNull();
  });
});
