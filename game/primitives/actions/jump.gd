extends RefCounted
## One leap from the ground. Done on landing. Flyers can't jump (done at once).

const PARAMS := {"height": "number", "distance": "number", "toward": "enum:player|facing"}


static func enter(actor, params: Dictionary) -> void:
	if params.toward == "player":
		actor.face_player()


static func tick(actor, params: Dictionary, delta: float) -> void:
	if actor.flying:
		actor.action_done = true
		return
	if not actor.memory.has("vx"):
		actor.velocity.x = 0.0
		if not actor.is_on_floor():
			return
		var g: float = actor.gravity()
		# The take-off frame has no gravity yet: solve h = v^2 / 2g + v * dt / 2 for v.
		var half_step := g * delta / 2.0
		var vy := -half_step + sqrt(half_step * half_step + 2.0 * g * float(params.height))
		if vy <= 0.0 or g <= 0.0:
			actor.action_done = true
			actor.memory.vx = 0.0
			return
		actor.velocity.y = -vy
		actor.memory.vx = actor.facing * float(params.distance) / (2.0 * vy / g + delta)
		actor.memory.airborne = false
	if not actor.is_on_floor():
		actor.memory.airborne = true
	elif actor.memory.airborne:
		actor.action_done = true
	actor.velocity.x = 0.0 if actor.action_done else actor.memory.vx
