extends RefCounted
## Vanish (untouchable, harmless) while a marker shows where it will appear:
## home, a random spot within `range` of home, or `range` px past the player
## (on the player's far side). Reappears after the windup. Done on reappearing.

const PARAMS := {"to": "enum:home|random|behindPlayer", "range": "number", "windup": "number", "color": "color"}


static func enter(actor, params: Dictionary) -> void:
	actor.vanish(_destination(actor, params), Color(params.color))


static func tick(actor, params: Dictionary, _delta: float) -> void:
	actor.velocity = Vector2.ZERO
	if not actor.action_done and actor.state_time >= float(params.windup):
		actor.appear()
		actor.face_player()
		actor.action_done = true


static func _destination(actor, params: Dictionary) -> Vector2:
	var reach := float(params.range)
	var spot: Vector2 = actor.home
	match params.to:
		"random":
			spot += Vector2(actor.rng.randf_range(-reach, reach), actor.rng.randf_range(-reach, reach) / 2.0 if actor.flying else 0.0)
		"behindPlayer":
			if actor.player != null:
				var side := signf(actor.player.position.x - actor.position.x)
				spot = actor.player.position + Vector2((side if side != 0.0 else actor.facing) * reach, 0.0)
	return actor.free_spot(spot)
