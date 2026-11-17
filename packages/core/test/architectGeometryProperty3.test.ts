import { it } from "vitest";
import { runShard } from "./architectGeometryProperty.ts";

// 500 random room plans, a quarter per file (see architectGeometryProperty.ts).
it("random room plans, shard 3 of 4: proven, sized, deterministic, standable", () => runShard(3), 1_200_000);
