extends RefCounted
## Melee: the hitbox shows (flashing) during the windup, hurts while active
## (moving `lunge` px/s forward), then recovery. Done at the end.

const Attack := preload("res://scripts/combat/attack.gd")
const PARAMS := {
	"windup": "number", "active": "number", "recovery": "number", "damage": "number",
	"width": "number", "height": "number", "offsetX": "number", "lunge": "number", "color": "color",
}


static func enter(actor, _params: Dictionary) -> void:
	actor.face_player()
	Attack.set_phase(actor, "windup")


static func tick(actor, params: Dictionary, _delta: float) -> void:
	actor.velocity.x = 0.0
	var t: float = actor.state_time
	var windup := float(params.windup)
	var end_active := windup + float(params.active)
	if t < windup:
		Attack.set_phase(actor, "windup")
		Attack.warn(actor, params.color)
		actor.show_attack(_box(actor, params), false, Color(params.color))
	elif t < end_active:
		Attack.set_phase(actor, "active")
		Attack.unwarn(actor)
		actor.velocity.x = actor.facing * float(params.lunge)
		var box := _box(actor, params)
		actor.show_attack(box, true, Color(params.color))
		Attack.hurt(actor.player, box, actor.position.x, actor.facing, int(params.damage), actor.knockback())
	else:
		Attack.set_phase(actor, "recovery")
		actor.show_attack(null)
		actor.action_done = t >= end_active + float(params.recovery)


static func _box(actor, params: Dictionary) -> Rect2:
	var size := Vector2(float(params.width), float(params.height))
	var centre: Vector2 = actor.center() + Vector2(actor.facing * float(params.offsetX), 0.0)
	return Rect2(centre - size / 2.0, size)
