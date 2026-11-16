extends RefCounted
## Rush toward where the player was when the state began. Done on hitting a wall
## (flyers: any surface).

const PARAMS := {"speed": "number", "direction": "enum:horizontal|towardPlayer"}


static func enter(actor, params: Dictionary) -> void:
	actor.face_player()
	var direction := Vector2(actor.facing, 0.0)
	if actor.flying and params.direction == "towardPlayer" and actor.player != null:
		direction = (actor.player.center() - actor.center()).normalized()
	actor.memory.direction = direction


static func tick(actor, params: Dictionary, _delta: float) -> void:
	var velocity: Vector2 = actor.memory.direction * float(params.speed)
	if actor.flying:
		actor.velocity = velocity
	else:
		actor.velocity.x = velocity.x
	if actor.is_on_wall() or (actor.flying and actor.get_slide_collision_count() > 0):
		actor.action_done = true
