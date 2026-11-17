import type { ProjectSpec } from "../schema.ts";
import type { DomainWarning } from "../events/lint.ts";
import { roomSize } from "../world/opHelpers.ts";

type Rect = { x: number; y: number; width: number; height: number };
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Likely prop mistakes: outside the room, never present (with handlers that then never run), solid over where the player starts. */
export function lintProps(project: ProjectSpec): DomainWarning[] {
  const warnings: DomainWarning[] = [];
  const { world } = project;
  const player = project.characters.find((c) => c.kind === "player")?.size ?? { width: 28, height: 44 };
  const body = (at: { x: number; y: number }): Rect => ({ x: at.x - player.width / 2, y: at.y - player.height, ...player });
  const spots = [
    ...(world.start ? [{ room: world.start.room, label: "the world's start", rect: body(world.start) }] : []),
    ...(world.playtest ? [{ room: world.playtest.room, label: "the playtest spot", rect: body(world.playtest) }] : []),
  ];
  world.rooms.forEach((room, r) => {
    const size = roomSize(room);
    room.props.forEach((prop, i) => {
      const path = `world.rooms.${r}.props.${i}`;
      const name = `prop "${prop.id}" in room "${room.id}"`;
      if (prop.x < 0 || prop.y < 0 || prop.x + prop.width > size.width || prop.y + prop.height > size.height) {
        warnings.push({ code: "prop_out_of_bounds", path, message: `${name} reaches outside the room (${size.width}x${size.height} px)` });
      }
      if (prop.visible === false) {
        warnings.push({ code: "prop_never_present", path: `${path}.visible`, message: `${name} is never visible, so it is never drawn, solid or touched` });
        if (prop.handlers.length > 0) {
          warnings.push({ code: "prop_handlers_never_run", path: `${path}.handlers`, message: `${name} has handlers, but it is never visible, so they never run` });
        }
        return;
      }
      if (prop.solid === false) return;
      for (const spot of spots) {
        if (spot.room === room.id && overlaps(spot.rect, prop)) {
          const when = prop.solid === true ? "is solid" : "can be solid";
          warnings.push({ code: "prop_blocks_spot", path, message: `${name} ${when} and covers ${spot.label}: the player would start inside it` });
        }
      }
    });
  });
  return warnings;
}
