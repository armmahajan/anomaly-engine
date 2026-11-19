import type { Clip } from "./clip.ts";
import type { Rig } from "./rig.ts";

/**
 * A small hand-made rig + clips: a worked example for the AI's prompts and a
 * fixture for tests. A 44x36 beetle (the starter Charger's box): domed
 * shell, pale head, curved horn, glowing eye, three visible legs. Only its format matters to prompts.
 */
export function exampleRig(): Rig {
  const dark = "#2a2a33";
  const pale = "#e8e3d3";
  const leg = (id: string, bone: string, points: [number, number][], z: number) => ({
    id,
    bone,
    z,
    shape: { type: "stroke" as const, points, width: 3.5, widthEnd: 1.5, smooth: 1 },
    fill: dark,
    ink: 0.6,
    glow: false,
    opacity: 1,
  });
  return {
    bones: [
      { id: "root", parent: null, pivot: [0, 0] },
      { id: "body", parent: "root", pivot: [0, -14] },
      { id: "head", parent: "body", pivot: [12, -18] },
      { id: "horn", parent: "head", pivot: [20, -24] },
      { id: "leg_front", parent: "body", pivot: [10, -10] },
      { id: "leg_mid", parent: "body", pivot: [0, -10] },
      { id: "leg_back", parent: "body", pivot: [-10, -10] },
    ],
    parts: [
      leg("leg_mid_far", "leg_mid", [[2, -10], [5, -4], [4, 0]], -2),
      leg("leg_back", "leg_back", [[-10, -10], [-15, -5], [-13, 0]], -1),
      {
        id: "shell",
        bone: "body",
        z: 0,
        shape: {
          type: "blob",
          points: [[-22, -12], [-21, -24], [-10, -34], [4, -33], [14, -25], [13, -12], [-4, -8]],
          smooth: 1,
          sharp: [0],
        },
        fill: "#4a5470",
        shade: { color: dark, angle: 100 },
        ink: 1,
        glow: false,
        opacity: 1,
      },
      {
        id: "shell_seam",
        bone: "body",
        z: 1,
        shape: { type: "stroke", points: [[-5, -33], [-3, -21], [-7, -10]], width: 1.8, widthEnd: 0.6, smooth: 1 },
        fill: dark,
        ink: 0,
        glow: false,
        opacity: 0.8,
      },
      {
        id: "head",
        bone: "head",
        z: 2,
        shape: { type: "blob", points: [[9, -24], [18, -27], [25, -19], [21, -10], [11, -11]], smooth: 1, sharp: [] },
        fill: pale,
        shade: { color: "#b8c4c8", angle: 110 },
        ink: 1,
        glow: false,
        opacity: 1,
      },
      {
        id: "horn",
        bone: "horn",
        z: 3,
        shape: { type: "blob", points: [[16, -25], [21, -33], [30, -41], [25, -30], [22, -23]], smooth: 0.8, sharp: [2] },
        fill: pale,
        ink: 1,
        glow: false,
        opacity: 1,
      },
      {
        id: "eye",
        bone: "head",
        z: 4,
        shape: { type: "ellipse", center: [18, -18], rx: 2.6, ry: 3.2, rotation: 0 },
        fill: "#ffd27a",
        ink: 0.5,
        glow: true,
        opacity: 1,
      },
      leg("leg_mid", "leg_mid", [[-1, -10], [-3, -4], [0, 0]], 5),
      leg("leg_front", "leg_front", [[10, -10], [15, -5], [14, 0]], 5),
    ],
  };
}

export function exampleClips(): Record<string, Clip> {
  const legs = (degrees: number, cycles: number) => [
    { type: "sway" as const, bone: "leg_front", degrees, cycles, phase: 0 },
    { type: "sway" as const, bone: "leg_mid", degrees, cycles, phase: 0.5 },
    { type: "sway" as const, bone: "leg_back", degrees, cycles, phase: 0 },
  ];
  return {
    idle: {
      duration: 1.6,
      loop: true,
      tracks: [],
      motions: [
        { type: "bob", bone: "body", amount: 0.8, cycles: 1, phase: 0 },
        { type: "sway", bone: "head", degrees: 3, cycles: 1, phase: 0.25 },
      ],
      visibility: [{ part: "eye", keys: [[0, true], [0.9, false], [0.95, true]] }],
      markers: [],
    },
    walk: {
      duration: 0.6,
      loop: true,
      tracks: [],
      motions: [...legs(22, 2), { type: "bob", bone: "body", amount: 1.2, cycles: 4, phase: 0 }],
      visibility: [],
      markers: [],
    },
    windup: {
      duration: 0.6,
      loop: false,
      tracks: [
        { bone: "body", property: "rotate", keys: [[0, 0], [0.7, -12], [1, -10]], ease: "smooth" },
        { bone: "head", property: "rotate", keys: [[0, 0], [0.7, 10], [1, 8]], ease: "smooth" },
      ],
      motions: [{ type: "shake", bone: "body", amount: 0.8 }, { type: "squash", bone: "body", amount: 0.12, at: 0.8, width: 0.4 }],
      visibility: [],
      markers: [],
    },
    attack: {
      duration: 0.36,
      loop: true,
      tracks: [{ bone: "body", property: "rotate", keys: [[0, 8], [1, 8]], ease: "step" }],
      motions: [...legs(32, 3), { type: "bob", bone: "body", amount: 1.5, cycles: 6, phase: 0 }],
      visibility: [],
      markers: [],
    },
    // Plays once and holds: rears up from the blow, slumps, legs curl, the eye goes dark.
    death: {
      duration: 0.7,
      loop: false,
      tracks: [
        { bone: "body", property: "rotate", keys: [[0, 0], [0.2, -16], [0.65, 18], [1, 14]], ease: "smooth" },
        { bone: "body", property: "y", keys: [[0, 0], [0.2, -6], [0.6, 5], [1, 4]], ease: "smooth" },
        { bone: "head", property: "rotate", keys: [[0, 0], [0.3, -10], [1, 32]], ease: "smooth" },
        { bone: "leg_front", property: "rotate", keys: [[0, 0], [1, -70]], ease: "smooth" },
        { bone: "leg_mid", property: "rotate", keys: [[0, 0], [1, -60]], ease: "smooth" },
        { bone: "leg_back", property: "rotate", keys: [[0, 0], [1, -50]], ease: "smooth" },
      ],
      motions: [{ type: "squash", bone: "body", amount: 0.2, at: 0.62, width: 0.3 }],
      visibility: [{ part: "eye", keys: [[0, true], [0.55, false]] }],
      markers: [],
    },
  };
}
