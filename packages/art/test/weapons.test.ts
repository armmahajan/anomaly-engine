import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyBatch,
  Clip,
  createDefaultProject,
  exampleRig,
  gameArtPlan,
  ProjectSpec,
  Weapon,
  type FileRef,
  type Grip,
  type OperationCall,
  type WeaponAttack,
} from "@anomaly/core";
import {
  animate,
  attackTiming,
  BudgetExceeded,
  checkWeaponClip,
  checkWeaponPoints,
  decodePng,
  encodePng,
  FakeImageModel,
  FakeRenderer,
  FakeVisionModel,
  fitWeaponClip,
  gripAt,
  handGrip,
  heldLength,
  humanoidRig,
  tipAt,
  toCanvasSpace,
  toRigSpace,
  weaponArtStage,
  withHandGrip,
  type ArtActivity,
  type ArtContext,
  type Pixels,
} from "../src/index.ts";

class MemoryFiles {
  readonly files = new Map<string, Buffer>();
  async put(data: Buffer, ext: "png" | "jpg" | "webp"): Promise<FileRef> {
    const ref = `${createHash("sha256").update(data).digest("hex").slice(0, 32)}.${ext}`;
    this.files.set(ref, data);
    return ref;
  }
  async get(ref: FileRef): Promise<Buffer> {
    const data = this.files.get(ref);
    if (!data) throw new Error(`no file ${ref}`);
    return data;
  }
}

/** A held object drawn in code: a thin handle and a long wide head, pointing `left` or right. */
function drawnWeapon(left = false): Pixels {
  const width = 120;
  const height = 30;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const handle = x < 24 && y >= 12 && y < 18;
      const head = x >= 24 && y >= 6 && y < 24 && x < 118 - Math.abs(y - 15) * 2;
      if (handle || head) data.set(handle ? [90, 60, 40, 255] : [200, 210, 220, 255], (y * width + (left ? width - 1 - x : x)) * 4);
    }
  }
  return { width, height, data };
}

/** Renderer whose 1x1 slice is a given image (the "trimmed" weapon). */
class WeaponRenderer extends FakeRenderer {
  private readonly piece: Pixels;
  constructor(piece: Pixels) {
    super();
    this.piece = piece;
  }
  override async sliceGrid() {
    return [{ png: encodePng(this.piece), width: this.piece.width, height: this.piece.height, cell: 0 }];
  }
}

const swing: WeaponAttack = {
  id: "swing",
  name: "Swing",
  trigger: { aim: "forward", where: "both", hold: 0 },
  shape: { type: "arc", radius: 60, from: -70, to: 50 },
  damage: 1,
  knockback: 350,
  timing: { windup: 0.08, active: 0.12, recovery: 0.2 },
  cooldown: 0.2,
  movement: { lunge: 0, recoil: 0, pogo: false },
  combo: { next: null, window: 0.35 },
  ammo: null,
  hitStop: 0.05,
  shake: 0,
  clip: null,
};
const thrust: WeaponAttack = { ...swing, id: "thrust", name: "Thrust", shape: { type: "thrust", length: 70, width: 20 }, timing: { windup: 0.1, active: 0.1, recovery: 0.2 } };
const shot: WeaponAttack = {
  ...swing,
  id: "shot",
  name: "Shot",
  shape: { type: "projectile", projectile: { speed: 700, gravity: 0, count: 1, spread: 0, lifetime: 1.2, pierce: 0, size: 12, color: "#ffffff", sprite: null } },
  timing: { windup: 0.15, active: 0.06, recovery: 0.25 },
};

function harness(project: ProjectSpec, renderer: FakeRenderer = new FakeRenderer(), budget = 1) {
  let current = project;
  let spent = 0;
  const log: ArtActivity[] = [];
  const vision = new FakeVisionModel();
  const image = new FakeImageModel();
  const files = new MemoryFiles();
  const ctx: ArtContext = {
    project: () => current,
    image,
    vision,
    renderer,
    files,
    log: (a) => log.push(a),
    remaining: () => budget - spent,
    spend: (u) => {
      spent += u.cost;
      if (spent > budget) throw new BudgetExceeded("over budget");
    },
  };
  const commit = (operations: OperationCall[]) => {
    const result = applyBatch(current, operations);
    if (!result.ok) throw new Error(`${result.error.message} ${JSON.stringify(result.error.issues)}`);
    current = result.project;
  };
  return { ctx, commit, log, vision, image, files, project: () => current, spent: () => spent };
}

function withWeapon(attacks: WeaponAttack[], extra: Partial<ProjectSpec> = {}): ProjectSpec {
  const base = createDefaultProject();
  const weapon = Weapon.parse({ id: "blade", name: "Blade", description: "a short one-handed blade", attacks, art: { brief: "a short curved blade with a wrapped handle" } });
  return ProjectSpec.parse({ ...base, weapons: { list: [weapon], loadout: { slots: [{ id: "main", label: "Main", action: "attack", start: "blade" }] } }, ...extra });
}

/** The project with the player drawn as the humanoid rig (rest-pose preview, no clips). */
function withPlayerRig(project: ProjectSpec, rig = withHandGrip(humanoidRig())): ProjectSpec {
  const player = project.characters.find((c) => c.kind === "player")!;
  const asset = { id: "hero_look", name: "Hero", kind: "character", brief: "a small hero", concepts: [], chosen: null, rig, preview: null, clips: {}, clipPreviews: {}, stateClips: {} };
  return ProjectSpec.parse({ ...project, characters: project.characters.map((c) => (c.id === player.id ? { ...c, appearance: asset.id } : c)), art: { ...project.art, assets: [asset] } });
}

describe("weapon sprite stage", () => {
  it("draws one transparent image pointing right and writes sprite, grip, tip and scale", async () => {
    const h = harness(withWeapon([swing]), new WeaponRenderer(drawnWeapon()));
    const result = await weaponArtStage(h.ctx, { weaponId: "blade" });
    expect(h.image.requests).toHaveLength(1);
    const request = h.image.requests[0]!;
    expect(request).toMatchObject({ transparent: true, quality: "low" });
    expect(request.prompt).toContain("pointing to the right");
    expect(request.prompt).toContain("a short curved blade with a wrapped handle");
    expect(request.prompt).toContain(h.project().art.direction.palette[0]);
    h.commit(result.operations);
    const art = h.project().weapons.list[0]!.art;
    expect(art.sprite).toMatch(/\.png$/);
    expect(art.brief).toBe("a short curved blade with a wrapped handle"); // other art fields stay
    // The fake vision model answers 15% / 97% across the middle: on the handle, at the far end.
    expect(art.grip[0]).toBeLessThan(24);
    expect(art.tip[0]).toBeGreaterThan(100);
    expect(art.scale).toBeCloseTo(heldLength(h.project().weapons.list[0]!) / Math.hypot(art.tip[0] - art.grip[0], art.tip[1] - art.grip[1]), 2);
    expect(h.spent()).toBeLessThan(0.01);
  });

  it("mirrors a sprite drawn pointing left (its grip ends up on the left)", async () => {
    const h = harness(withWeapon([swing]), new WeaponRenderer(drawnWeapon(true)));
    // The model reads it right: the handle on the right, the tip on the left.
    h.vision.replies.push(JSON.stringify({ grip: [Math.round(((120 - 10) * 512) / 120), Math.round((15 * 512) / 120)], tip: [Math.round((3 * 512) / 120), Math.round((15 * 512) / 120)] }));
    h.commit((await weaponArtStage(h.ctx, { weaponId: "blade" })).operations);
    const art = h.project().weapons.list[0]!.art;
    expect(art.grip[0]).toBeLessThan(art.tip[0]);
    const sprite = decodePng(await h.files.get(art.sprite!));
    expect(sprite.data[(15 * sprite.width + 10) * 4 + 3]).toBe(255); // the handle is on the left now
    expect(h.log.some((a) => a.text === "mirrored it to point right")).toBe(true);
  });

  it("checks the points: a grip off the object moves onto it, a tip short of the end moves to it", () => {
    const pixels = drawnWeapon();
    const checked = checkWeaponPoints(pixels, { grip: [10, 2], tip: [60, 15] });
    expect(pixels.data[(Math.floor(checked.grip[1]) * pixels.width + Math.floor(checked.grip[0])) * 4 + 3]).toBe(255);
    expect(checked.tip[0]).toBeGreaterThan(110);
    expect(checked.notes).toHaveLength(2);
    // No reply: the long axis decides.
    const fallback = checkWeaponPoints(pixels, null);
    expect(fallback.grip[0]).toBeLessThan(30);
    expect(fallback.tip[0]).toBeGreaterThan(110);
  });

  it("fails cleanly for an unknown weapon", async () => {
    const h = harness(withWeapon([swing]));
    await expect(weaponArtStage(h.ctx, { weaponId: "nope" })).rejects.toThrow(/no weapon "nope"/);
  });
});

describe("rig grips", () => {
  it("places the hand grip at the front arm's hand, pointing down and forward when the arm hangs", () => {
    const grip = handGrip(humanoidRig())!;
    expect(grip).toMatchObject({ id: "hand", bone: "arm_near_lower" });
    expect(grip.at[0]).toBeCloseTo(-1, 0);
    expect(grip.at[1]).toBeCloseTo(-14, 0);
    expect(grip.angle).toBeGreaterThan(35);
    expect(grip.angle).toBeLessThan(65);
  });

  it("keeps a valid hand grip, skips rigs without arms, and survives the canvas round trip", () => {
    const custom: Grip = { id: "hand", bone: "arm_far_lower", at: [5, -15], angle: -40 };
    expect(withHandGrip({ ...humanoidRig(), grips: [custom] }).grips).toEqual([custom]);
    expect(withHandGrip(exampleRig()).grips).toBeUndefined(); // the beetle has no arms
    const rig = withHandGrip(humanoidRig());
    const frame = { scale: 0.25, anchor: [256, 480] as [number, number] };
    const back = toRigSpace(toCanvasSpace(rig, frame), frame);
    expect(back.grips![0]!.at[0]).toBeCloseTo(rig.grips![0]!.at[0], 0);
    expect(back.grips![0]!.at[1]).toBeCloseTo(rig.grips![0]!.at[1], 0);
  });

  it("follows the hand bone on a pose", () => {
    const rig = withHandGrip(humanoidRig());
    const grip = rig.grips![0]!;
    const clip = Clip.parse({ duration: 1, loop: false, tracks: [{ bone: "arm_near_upper", property: "rotate", keys: [[0, 0], [1, -90]], ease: "linear" }] });
    const raised = gripAt(rig, grip, clip, 1);
    // Turned 90° anticlockwise about the shoulder (-3, -30): the hand goes forward... of a right-facing rig, up is -y.
    expect(raised.angle).toBeCloseTo(grip.angle - 90, 0);
    expect(raised.at[1]).toBeLessThan(-25);
  });
});

describe("weapon-aware clips", () => {
  const rig = withHandGrip(humanoidRig());
  const grip = rig.grips![0]!;
  const empty = (attack: WeaponAttack) => Clip.parse({ duration: attackTiming(attack).duration, loop: false });

  it("projectiles are fired from the held weapon: on the aim when it fires, steady while firing, never above the aim line", () => {
    const clip = fitWeaponClip(rig, grip, shot, empty(shot));
    const check = checkWeaponClip(rig, grip, shot, clip, heldLength({ attacks: [shot] }));
    const { activeFrom, activeTo } = attackTiming(shot);
    expect(check.problems).toEqual([]);
    expect(Math.abs(gripAt(rig, grip, clip, activeFrom).angle)).toBeLessThan(10); // level with a forward aim
    for (let t = 0; t <= 1; t += 0.02) expect(gripAt(rig, grip, clip, t).angle).toBeGreaterThan(-12); // never raised above the aim (only the recoil kick)
    for (let t = activeFrom; t <= activeTo; t += 0.02) expect(Math.abs(gripAt(rig, grip, clip, t).angle)).toBeLessThan(18);
    expect(gripAt(rig, grip, clip, 1).angle).toBeCloseTo(grip.angle, 0); // lowered back to rest
  });

  it.each([
    ["an arc", swing],
    ["a thrust", thrust],
  ])("%s: the held weapon moves fastest inside the active window and points where the attack does", (_, attack) => {
    const clip = fitWeaponClip(rig, grip, attack, empty(attack));
    const check = checkWeaponClip(rig, grip, attack, clip, heldLength({ attacks: [attack] }));
    const { activeFrom, activeTo } = attackTiming(attack);
    expect(check.problems).toEqual([]);
    expect(check.peak).toBeGreaterThanOrEqual(activeFrom - 0.02);
    expect(check.peak).toBeLessThanOrEqual(activeTo + 0.02);
    expect(clip.loop).toBe(false);
    // Starts and ends at rest.
    expect(gripAt(rig, grip, clip, 1).angle).toBeCloseTo(grip.angle, 0);
  });

  it("an arc sweeps from its start angle to its end angle over the active window", () => {
    const clip = fitWeaponClip(rig, grip, swing, empty(swing));
    const { activeFrom, activeTo } = attackTiming(swing);
    expect(gripAt(rig, grip, clip, activeFrom).angle).toBeCloseTo(-70, 0);
    expect(gripAt(rig, grip, clip, activeTo).angle).toBeCloseTo(50, 0);
  });

  it("a thrust drives the tip forward during the active window", () => {
    const clip = fitWeaponClip(rig, grip, thrust, empty(thrust));
    const { activeFrom, activeTo } = attackTiming(thrust);
    const length = heldLength({ attacks: [thrust] });
    expect(tipAt(rig, grip, clip, activeTo, length)[0] - tipAt(rig, grip, clip, activeFrom, length)[0]).toBeGreaterThan(8);
    expect(Math.abs(gripAt(rig, grip, clip, activeTo).angle)).toBeLessThan(3);
  });

  it("animate writes a weapon's attack clips (named <weapon>_<attack>), holds them to the attack and names the clip on the attack", async () => {
    const h = harness(withPlayerRig(withWeapon([swing, thrust])));
    h.commit((await animate(h.ctx, { characterId: "player", weaponId: "blade", feedback: "big and heavy" })).operations);
    const asset = h.project().art.assets[0]!;
    if (asset.kind !== "character") throw new Error("expected a character asset");
    expect(Object.keys(asset.clips).sort()).toEqual(["blade_swing", "blade_thrust"]);
    expect(asset.clips.blade_swing!.direction).toBe("big and heavy");
    expect(asset.clips.blade_swing!.duration).toBeCloseTo(0.4, 5);
    // The fake model peaks in the wind-up: the stage turned the arm to the attack.
    for (const [name, attack] of [["blade_swing", swing], ["blade_thrust", thrust]] as const) {
      expect(checkWeaponClip(asset.rig!, asset.rig!.grips![0]!, attack, asset.clips[name]!, heldLength({ attacks: [attack] })).ok).toBe(true);
    }
    expect(h.log.some((a) => a.text.startsWith("blade_swing: the weapon moves fastest"))).toBe(true);
    expect(h.project().weapons.list[0]!.attacks.map((a) => a.clip)).toEqual(["blade_swing", "blade_thrust"]);
    expect(h.vision.requests.some((r) => r.content.some((c) => c.type === "text" && c.text.includes("The hit (active window) is t 0.20-0.50")))).toBe(true);
  });

  it("redoes one clip by name with a direction, and keeps that direction for the next redo", async () => {
    const h = harness(withPlayerRig(withWeapon([swing])));
    const taunt = JSON.stringify({ clips: { taunt: { duration: 1, loop: false, tracks: [{ bone: "head", property: "rotate", keys: [[0, 0], [0.5, 12], [1, 0]] }] } } });
    h.vision.replies.push(taunt);
    h.commit((await animate(h.ctx, { characterId: "player", clip: "taunt", direction: "a cocky shrug" })).operations);
    const clips = () => {
      const asset = h.project().art.assets[0]!;
      return asset.kind === "character" ? asset.clips : {};
    };
    expect(clips().taunt?.direction).toBe("a cocky shrug");
    const asked = (n: number) => h.vision.requests.filter((r) => r.content.some((c) => c.type === "text" && c.text.includes('"taunt" (a cocky shrug)'))).length >= n;
    expect(asked(1)).toBe(true);
    h.vision.replies.push(taunt);
    h.commit((await animate(h.ctx, { characterId: "player", clip: "taunt" })).operations);
    expect(clips().taunt?.direction).toBe("a cocky shrug");
    expect(asked(2)).toBe(true);
    // Only the named clip was written.
    expect(Object.keys(clips())).toEqual(["taunt"]);
  });

  it("the full animate pass includes the attack clips of the weapons the character wields", async () => {
    const h = harness(withPlayerRig(withWeapon([swing])));
    h.commit((await animate(h.ctx, { characterId: "player" })).operations);
    const asset = h.project().art.assets[0]!;
    expect(asset.kind === "character" && Object.keys(asset.clips)).toEqual(expect.arrayContaining(["idle", "attack", "blade_swing"]));
  });
});

describe("game-art plan: weapons", () => {
  it("plans a sprite for each weapon the game uses and the attack clips its wielders miss", () => {
    const project = withPlayerRig(withWeapon([swing]));
    const plan = gameArtPlan(project);
    expect(plan.find((s) => s.id === "weapon:blade")).toMatchObject({ kind: "weapon", request: { stage: "weaponArt", weaponId: "blade" } });
    const step = plan.find((s) => s.id === "character:player");
    expect(step?.request.clips).toEqual(["blade_swing"]);
    // An unused weapon is not drawn.
    const unused = withWeapon([swing], { weapons: { list: [Weapon.parse({ id: "spare", name: "Spare" })], loadout: { slots: [{ id: "main", label: "Main", action: "attack", start: null }], cycle: false } } });
    expect(gameArtPlan(unused).some((s) => s.kind === "weapon")).toBe(false);
  });
});
