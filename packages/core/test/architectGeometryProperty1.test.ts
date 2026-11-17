import { it } from "vitest";
import { runShard } from "./architectGeometryProperty.ts";

// 500 random room plans, a quarter per file (see architectGeometryProperty.ts).
it("random room plans, shard 1 of 4: proven, sized, deterministic, standable", () => runShard(1), 1_200_000);
