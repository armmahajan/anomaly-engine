import { describe, expect, it } from "vitest";
import { createDefaultProject } from "@anomaly/core";
import { Draft, executeTool, summarizeProject, toolDefinitions } from "../src/index.ts";
import { propTools } from "../src/domains/props.ts";

const run = (draft: Draft, name: string, args: unknown) => executeTool(draft, name, JSON.stringify(args)) as Record<string, any>;

describe("prop and item tools", () => {
  it("stay compact", () => {
    const names = Object.keys(propTools.schemas);
    const mine = toolDefinitions().filter((d) => names.includes(d.function.name));
    expect(mine).toHaveLength(6);
    expect(JSON.stringify(mine).length).toBeLessThan(2_500);
  });

  it("build a pickup and a barrier, summarize them and warn about mistakes", () => {
    const draft = new Draft(createDefaultProject());
    expect(run(draft, "createItem", { name: "Key" })).toMatchObject({ ok: true });
    expect(
      run(draft, "addProp", { roomId: "arena", name: "Key", x: 300, y: 640, width: 16, height: 32, visible: { type: "flag", flag: "got_key", is: false }, handlers: [{ on: { type: "touch" }, do: [{ type: "giveItem", item: "key" }, { type: "setFlag", flag: "got_key" }] }] }),
    ).toMatchObject({ ok: true });
    const blocked = run(draft, "addProp", { roomId: "arena", id: "barrier", x: 150, y: 600, width: 32, height: 72, solid: true });
    expect(blocked.warnings).toEqual(expect.arrayContaining([expect.stringContaining('prop "barrier" in room "arena" is solid and covers the world\'s start')]));
    expect(run(draft, "deleteItem", { itemId: "key" }).error.message).toContain("prop arena/key handler 0");
    const summary = summarizeProject(draft.current);
    expect(summary).toContain('- prop arena/key "Key" (300, 640) 16x32; visible {"type":"flag","flag":"got_key","is":false}');
    expect(summary).toContain('  [0] on touch do giveItem(item "key", count 1), setFlag(flag "got_key", value true)');
    expect(summary).toContain("- prop arena/barrier (150, 600) 32x72; solid true");
    expect(summary).toContain('Items: key "Key".');
  });
});
