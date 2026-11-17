extends RefCounted
## All behavior primitives the runtime implements, keyed by the type name
## used in the project spec (packages/core/src/behavior.ts is the contract).
##
## Action scripts:    const PARAMS; static func enter(actor, params); static func tick(actor, params, delta)
## Condition scripts: const PARAMS; static func check(actor, params) -> bool
## PARAMS maps each parameter to "number", "bool", "color", "id" (another thing's id) or "enum:a|b" (checked on load).

const ACTIONS := {
	"patrol": preload("res://primitives/actions/patrol.gd"),
	"wait": preload("res://primitives/actions/wait.gd"),
	"chase": preload("res://primitives/actions/chase.gd"),
	"charge": preload("res://primitives/actions/charge.gd"),
	"telegraph": preload("res://primitives/actions/telegraph.gd"),
	"retreat": preload("res://primitives/actions/retreat.gd"),
	"returnHome": preload("res://primitives/actions/return_home.gd"),
	"jump": preload("res://primitives/actions/jump.gd"),
	"hover": preload("res://primitives/actions/hover.gd"),
	"strike": preload("res://primitives/actions/strike.gd"),
	"shoot": preload("res://primitives/actions/shoot.gd"),
	"leap": preload("res://primitives/actions/leap.gd"),
	"slam": preload("res://primitives/actions/slam.gd"),
	"summon": preload("res://primitives/actions/summon.gd"),
	"teleport": preload("res://primitives/actions/teleport.gd"),
}

const CONDITIONS := {
	"playerWithin": preload("res://primitives/conditions/player_within.gd"),
	"playerBeyond": preload("res://primitives/conditions/player_beyond.gd"),
	"after": preload("res://primitives/conditions/after.gd"),
	"hitWall": preload("res://primitives/conditions/hit_wall.gd"),
	"actionDone": preload("res://primitives/conditions/action_done.gd"),
	"atLedge": preload("res://primitives/conditions/at_ledge.gd"),
	"onGround": preload("res://primitives/conditions/on_ground.gd"),
	"airborne": preload("res://primitives/conditions/airborne.gd"),
	"playerAbove": preload("res://primitives/conditions/player_above.gd"),
	"playerBelow": preload("res://primitives/conditions/player_below.gd"),
	"playerLevel": preload("res://primitives/conditions/player_level.gd"),
	"playerInFront": preload("res://primitives/conditions/player_in_front.gd"),
	"playerBehind": preload("res://primitives/conditions/player_behind.gd"),
	"canSeePlayer": preload("res://primitives/conditions/can_see_player.gd"),
	"wasHit": preload("res://primitives/conditions/was_hit.gd"),
	"healthBelow": preload("res://primitives/conditions/health_below.gd"),
	"chance": preload("res://primitives/conditions/chance.gd"),
}
