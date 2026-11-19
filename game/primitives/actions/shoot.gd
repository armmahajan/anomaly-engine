extends RefCounted
## Flash during the windup, then fire `count` projectiles in a fan (at the
## player, or at `angle` degrees from facing). Done once fired.
## The look (core art/animation.ts ProjectileLook): shots leave from `origin` (px from the
## shooter's centre, facing right); with `appear: windup` they sit there charging from the start
## of the windup and launch when it ends; `art` draws them as an object. The defaults (origin
## [0, 0], appear fire, art null) are the shots as they always were.

const Attack := preload("res://scripts/combat/attack.gd")
const Projectile := preload("res://scripts/combat/projectile.gd")
const PARAMS := {
	"windup": "number", "count": "number", "spread": "number", "speed": "number", "gravity": "number",
	"aim": "enum:player|angle", "angle": "number", "lifetime": "number", "damage": "number", "pogo": "bool", "color": "color",
	"look": "object",  # core art/animation.ts ProjectileLook (origin, appear, art); the defaults are today's shots
}


static func enter(actor, params: Dictionary) -> void:
	actor.face_player()
	Attack.set_phase(actor, "windup")
	if _look(params).appear == "windup" and float(params.windup) > 0.0:
		var shots := []
		for i in int(params.count):
			var shot := _make(actor, params)
			shot.charging = true
			shot.charge_memory = actor.memory
			actor.get_parent().add_child(shot)
			shots.append(shot)
		actor.memory.charging = shots


static func tick(actor, params: Dictionary, _delta: float) -> void:
	actor.velocity = Vector2(0.0, actor.velocity.y if not actor.flying else 0.0)
	if actor.action_done:
		Attack.after_instant(actor)
		return
	if actor.state_time < float(params.windup):
		Attack.set_phase(actor, "windup")
		Attack.warn(actor, params.color)
		return
	Attack.unwarn(actor)
	actor.face_player()
	var look := _look(params)
	var origin: Vector2 = actor.center() + Vector2(look.origin.x * actor.facing, look.origin.y)
	var heading := deg_to_rad(float(params.angle))
	heading = heading if actor.facing > 0.0 else PI - heading
	if params.aim == "player" and actor.player != null:
		heading = (actor.player.center() - origin).angle()
	var count := int(params.count)
	var spread := deg_to_rad(float(params.spread))
	var charged: Array = actor.memory.get("charging", [])
	for i in count:
		var offset := 0.0 if count == 1 else spread * (float(i) / float(count - 1) - 0.5)
		var v := Vector2.from_angle(heading + offset) * float(params.speed)
		var shot = charged[i] if i < charged.size() and is_instance_valid(charged[i]) else null
		if shot != null:
			shot.position = origin
			shot.launch(v)
			continue
		shot = _make(actor, params)
		shot.position = origin
		shot.velocity = v
		actor.get_parent().add_child(shot)
	actor.memory.erase("charging")
	actor.memory.at = actor.state_time
	Attack.set_phase(actor, "active")
	actor.action_done = true


## The look with its defaults: {origin: Vector2, appear, art (dict or null)}.
static func _look(params: Dictionary) -> Dictionary:
	var look = params.get("look")
	look = look if typeof(look) == TYPE_DICTIONARY else {}
	var o = look.get("origin", [0, 0])
	var origin := Vector2(float(o[0]), float(o[1])) if typeof(o) == TYPE_ARRAY and o.size() >= 2 else Vector2.ZERO
	var art = look.get("art")
	return {"origin": origin, "appear": str(look.get("appear", "fire")), "art": art if typeof(art) == TYPE_DICTIONARY else null}


static func _make(actor, params: Dictionary) -> Node2D:
	var look := _look(params)
	var shot: Node2D = Projectile.new()
	shot.gravity = float(params.gravity)
	shot.life = float(params.lifetime)
	shot.damage = int(params.damage)
	shot.knockback = actor.knockback()
	shot.pogo = bool(params.pogo)
	shot.color = Color(params.color)
	shot.player = actor.player
	shot.shooter = actor
	shot.art = look.art
	shot.look_origin = look.origin
	return shot
