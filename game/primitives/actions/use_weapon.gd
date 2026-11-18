extends RefCounted
## Attack with a weapon the way the player does (combat/weapon_runner.gd: windup, active,
## recovery; its hit shape, lunge, recoil, projectiles), facing the player. Done after recovery.

const PARAMS := {"weapon": "id", "attack": "id?", "aim": "enum:facing|player"}


static func enter(actor, params: Dictionary) -> void:
	actor.face_player()
	if not actor.start_weapon(str(params.weapon), params.get("attack"), str(params.aim)):
		actor.action_done = true


static func tick(actor, _params: Dictionary, _delta: float) -> void:
	actor.velocity.x = 0.0
	if actor.weapon_runner != null and not actor.step_weapon():
		actor.action_done = true
