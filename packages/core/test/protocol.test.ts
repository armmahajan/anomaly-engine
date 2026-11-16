import { describe, expect, it } from "vitest";
import { decodeRuntimeMessage, encodeStudioMessage, PROTOCOL_VERSION, RUNTIME_SOURCE } from "../src/index.ts";

const wrap = (message: unknown) => JSON.stringify({ source: RUNTIME_SOURCE, message });

describe("decodeRuntimeMessage", () => {
  it("decodes a valid runtime message", () => {
    const ready = { type: "ready", protocolVersion: 6, primitives: { actions: ["wait"], conditions: ["after"] } };
    expect(decodeRuntimeMessage(wrap(ready))).toEqual({ kind: "message", message: ready });
  });

  it("ignores messages that are not from the runtime", () => {
    expect(decodeRuntimeMessage({ type: "ready" }).kind).toBe("foreign");
    expect(decodeRuntimeMessage("not json").kind).toBe("foreign");
    expect(decodeRuntimeMessage(JSON.stringify({ source: "some-extension", message: {} })).kind).toBe("foreign");
  });

  it("flags malformed runtime messages", () => {
    expect(decodeRuntimeMessage(wrap({ type: "loaded" })).kind).toBe("invalid");
    expect(decodeRuntimeMessage(wrap({ type: "teleport" })).kind).toBe("invalid");
  });
});

describe("encodeStudioMessage", () => {
  it("wraps messages in a versioned envelope", () => {
    expect(JSON.parse(encodeStudioMessage({ type: "play", seed: 7 }))).toEqual({
      source: "anomaly-studio",
      protocolVersion: PROTOCOL_VERSION,
      message: { type: "play", seed: 7 },
    });
  });
});
