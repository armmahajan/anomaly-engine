extends RefCounted
## All behavior primitives the runtime implements, keyed by the type name
## used in the project spec (packages/core/src/behavior.ts is the contract).
##
## Action scripts:    const PARAMS; static func enter(actor, params); static func tick(actor, params, delta)
## Condition scripts: const PARAMS; static func check(actor, params) -> bool
## PARAMS maps each parameter to "number" or "color" (checked on load).

const ACTIONS := {
	"patrol": preload("res://primitives/actions/patrol.gd"),
	"wait": preload("res://primitives/actions/wait.gd"),
	"chase": preload("res://primitives/actions/chase.gd"),
	"charge": preload("res://primitives/actions/charge.gd"),
	"telegraph": preload("res://primitives/actions/telegraph.gd"),
}

const CONDITIONS := {
	"playerWithin": preload("res://primitives/conditions/player_within.gd"),
	"playerBeyond": preload("res://primitives/conditions/player_beyond.gd"),
	"after": preload("res://primitives/conditions/after.gd"),
	"hitWall": preload("res://primitives/conditions/hit_wall.gd"),
}
