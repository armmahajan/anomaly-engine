extends RefCounted
## Flash and shake (hanging still if airborne), hop `height` px, crash down;
## on landing a shockwave runs along the ground both ways. Done on landing.
## Flyers drop from where they are.

const Attack := preload("res://scripts/combat/attack.gd")
const Shockwave := preload("res://scripts/combat/shockwave.gd")
const PARAMS := {
	"windup": "number", "height": "number", "damage": "number",
	"waveSpeed": "number", "waveReach": "number", "waveHeight": "number", "color": "color",
}
const DROP_SPEED := 1100.0


static func enter(actor, _params: Dictionary) -> void:
	actor.face_player()


static func tick(actor, params: Dictionary, _delta: float) -> void:
	actor.velocity.x = 0.0
	if actor.action_done:
		return
	if actor.state_time < float(params.windup):
		if not actor.is_on_floor():
			actor.hold_air = true
			actor.velocity.y = 0.0
		Attack.warn(actor, params.color, true)
		return
	actor.hold_air = false
	if not actor.memory.has("started"):
		actor.memory.started = true
		Attack.unwarn(actor)
		var g: float = actor.gravity()
		if actor.is_on_floor() and not actor.flying and float(params.height) > 0.0 and g > 0.0:
			actor.velocity.y = -sqrt(2.0 * g * float(params.height))
			actor.memory.rising = true
			return
	if not actor.is_on_floor():
		actor.memory.airborne = true
		if actor.velocity.y >= 0.0 or not actor.memory.get("rising", false):
			actor.velocity.y = DROP_SPEED
	elif actor.memory.get("airborne", false) or not actor.memory.get("rising", false):
		_land(actor, params)


static func _land(actor, params: Dictionary) -> void:
	actor.action_done = true
	actor.velocity.y = 0.0
	for direction in [-1.0, 1.0]:
		var wave: Node2D = Shockwave.new()
		wave.position = actor.position + Vector2(direction * actor.size().x / 2.0, 0.0)
		wave.direction = direction
		wave.speed = float(params.waveSpeed)
		wave.reach = float(params.waveReach)
		wave.height = float(params.waveHeight)
		wave.damage = int(params.damage)
		wave.knockback = actor.knockback()
		wave.color = Color(params.color)
		wave.player = actor.player
		actor.get_parent().add_child(wave)
	actor.shake_screen(6.0, 0.25)
