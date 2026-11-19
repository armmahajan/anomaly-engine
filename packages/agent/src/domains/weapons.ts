import {
  CreateWeaponInput,
  DeleteWeaponAttackInput,
  DeleteWeaponInput,
  RemoveGripInput,
  SetGripInput,
  SetLoadoutInput,
  SetWeaponAttackInput,
  UpdateWeaponInput,
} from "@anomaly/core";
import { z } from "zod";
import type { DomainTools } from "./types.ts";

const WeaponRef = z.strictObject({ weaponId: z.string().describe("A weapon id (the project summary lists them).") });

type WeaponOp = "createWeapon" | "updateWeapon" | "setWeaponAttack" | "deleteWeaponAttack" | "deleteWeapon" | "setLoadout";
/** The bone editor's other operations are the creator's hands-on tool (not build tools: STUDIO_ONLY_OPERATIONS). */
type RigEditOp = "setGrip" | "removeGrip";

/** Weapons (generic attack data the player and enemies wield) and the creator's loadout, plus the bone editor's rig edits. */
export const weaponTools: DomainTools<WeaponOp | RigEditOp> = {
  descriptions: {
    createWeapon:
      "Add a weapon (id, name, description, brief of its look); then give it attacks with setWeaponAttack. Each attack has a trigger (aim forward/up/down/any, ground/air/both, hold seconds for a charged one), a hit shape (arc radius+angles, box, thrust, or projectile), damage, knockback, timing (windup/active/recovery), cooldown, movement (lunge, recoil, pogo), an optional combo next attack, optional ammo (an item spent per use) and an optional clip (the wielder's animation). Build weapons from the wiki's description; no stock weapon types.",
    updateWeapon: "Rename or describe a weapon, or change fields of its art (sprite, grip, tip, scale, brief, trail, spark).",
    setWeaponAttack: "Add an attack to a weapon, or replace the one with the same id.",
    deleteWeaponAttack: "Remove one of a weapon's attacks (it keeps at least one).",
    deleteWeapon: "Delete a weapon (loadout slots that started with it start empty).",
    setLoadout:
      "Set the loadout: up to 3 slots, each with a label, a control action (attack, alt_attack or special_attack) and the weapon it starts with (null = empty; an empty attack slot uses the player's built-in attack), and whether the player can cycle weapons. Players get more weapons through the giveWeapon effect.",
    setGrip: "Set where a rig holds weapons (a point on a bone and the resting angle).",
    removeGrip: "Remove a grip from a rig.",
  },
  schemas: {
    createWeapon: CreateWeaponInput,
    updateWeapon: UpdateWeaponInput,
    setWeaponAttack: SetWeaponAttackInput,
    deleteWeaponAttack: DeleteWeaponAttackInput,
    deleteWeapon: DeleteWeaponInput,
    setLoadout: SetLoadoutInput,
    setGrip: SetGripInput,
    removeGrip: RemoveGripInput,
  },
  reads: [
    {
      name: "getWeapon",
      description: "Exact JSON of one weapon (every attack in full, its art) and who uses it: the loadout slots it starts in, the enemies that wield it.",
      schema: WeaponRef,
      run: (project, args) => {
        const parsed = WeaponRef.safeParse(args);
        const weapon = parsed.success && project.weapons.list.find((w) => w.id === parsed.data.weaponId);
        if (!weapon) return { ok: false, error: { code: "not_found", message: `known weapons: ${project.weapons.list.map((w) => w.id).join(", ") || "none"}` } };
        const wieldedBy = project.characters.filter((c) => c.kind === "enemy" && Object.values(c.behavior.states).some((s) => s.action.type === "useWeapon" && s.action.weapon === weapon.id)).map((c) => c.id);
        const slots = project.weapons.loadout.slots.filter((s) => s.start === weapon.id).map((s) => s.id);
        return { ok: true, weapon, ...(slots.length && { startsIn: slots }), ...(wieldedBy.length && { wieldedBy }) };
      },
    },
  ],
  summary: (project) => {
    const { list, loadout } = project.weapons;
    if (list.length === 0) return ["Weapons: none (the player's built-in attack)."];
    const slots = loadout.slots.map((s) => `${s.label} on ${s.action}${s.start ? `: ${s.start}` : ""}`).join("; ");
    return [`Weapons (getWeapon reads one in full): ${list.map((w) => `${w.id} (${w.attacks.map((a) => a.id).join(", ")})`).join("; ")}. Loadout: ${slots}${loadout.cycle ? "; cycling on" : ""}.`];
  },
};
