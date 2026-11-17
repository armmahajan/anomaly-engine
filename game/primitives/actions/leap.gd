extends RefCounted
## Crouch flashing, then leap to land where the player stands at take-off
## (at most maxDistance px away). Done on landing. Flyers can't leap (done at once).

const Attack := preload("res://scripts/combat/attack.gd")
const PARAMS := {"windup": "number", "height": "number", "maxDistance": "number", "color": "color"}


static func enter(actor, _params: Dictionary) -> void:
	actor.face_player()
	Attack.set_phase(actor, "windup")


static func tick(actor, params: Dictionary, delta: float) -> void:
	if actor.flying:
		Attack.set_phase(actor, "")
		actor.action_done = true
		return
	if not actor.memory.has("vx"):
		actor.velocity.x = 0.0
		if actor.state_time < float(params.windup):
			Attack.set_phase(actor, "windup")
			Attack.warn(actor, params.color)
			return
		Attack.unwarn(actor)
		if not actor.is_on_floor():
			return
		actor.face_player()
		var g: float = actor.gravity()
		# As jump.gd: the take-off frame has no gravity yet.
		var half_step := g * delta / 2.0
		var vy := -half_step + sqrt(half_step * half_step + 2.0 * g * float(params.height))
		var reach := float(params.maxDistance)
		var dx := 0.0 if actor.player == null else clampf(actor.player.position.x - actor.position.x, -reach, reach)
		if vy <= 0.0 or g <= 0.0:
			actor.action_done = true
			actor.memory.vx = 0.0
			return
		actor.velocity.y = -vy
		actor.memory.vx = dx / (2.0 * vy / g + delta)
		Attack.set_phase(actor, "active")
		actor.memory.airborne = false
	if not actor.is_on_floor():
		actor.memory.airborne = true
	elif actor.memory.airborne:
		actor.action_done = true
		Attack.set_phase(actor, "recovery")
	actor.velocity.x = 0.0 if actor.action_done else actor.memory.vx
