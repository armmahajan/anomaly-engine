/**
 * Population and screens stages, and the legibility lints (agent L owns this folder).
 *
 * populationStage (populate.ts): turn each unpinned plan room's `contents` into the
 * built world room's spawns, props and handlers, on spots the player can reach
 * (spots.ts, from the room's traversal graph): enemies on surfaces away from the
 * doors; `lockRoom` enemies close the room's doors (seal props shown while a flag is
 * set and they are unbeaten) until the last falls, then give their `grants` with a
 * message and set the flag; pickups give an ability or key item; save points; the
 * world start; the ending (endGame); key gates at the `a` door of links needing keys.
 * Everything through existing primitives (props, handlers, items, flags, abilities,
 * modals): nothing role-specific.
 *
 * screensStage (screens.ts): a title screen on gameStarted, an ending screen, a
 * message (modal) for every ability or key the player can get, and the map on.
 * Population creates the messages and the ending it shows itself (grants.ts); screens
 * adds the rest. Both only add missing screens.
 *
 * lintLegibility (lint.ts): silent_grant and skippable_guardian, part of lintProject.
 */
export { populationStage, doorRect, allOf, anyOf } from "./populate.ts";
export { screensStage } from "./screens.ts";
export { lintLegibility, silentGrants, skippableGuardians } from "./lint.ts";
export { roomSpots, type RoomSpots, type Spot, type PickOptions } from "./spots.ts";
export { messageModalId, messageModal, grantEffect, safeId, weaponUse } from "./grants.ts";
