extends RefCounted
## One weapon attack made by a wielder, the player's and an enemy's alike (same code), and the
## geometry of hit shapes. Mirrors packages/core/src/combat/weaponModel.ts line for line
## (game/test/weapons.test.ts plays the same attacks through both).
##
## Wielder space: the origin at the centre of the wielder's box, facing right (x forward, y down);
## x is mirrored when it faces left. Frame 0 is the frame the attack starts on; `step` runs once
## per physics frame (the player after it moves, an enemy in its action's tick).
##
## The wielder (player.gd, enemy.gd) provides, duck-typed:
##   center() -> Vector2, size() -> Vector2, facing_sign() -> float,
##   weapon_targets() -> Array (things with rect(): enemies, props, shots, or the player),
##   weapon_solids() -> Array (solid dicts a pogo bounces off: hazards and breakables),
##   weapon_landed(attack, point, first: bool, bounce: bool) (hit-stop and shake per hit; recoil on the
##     attack's `first` hit; `bounce`: a pogo strike's first bounce),
##   weapon_texture(ref) -> Texture2D or null (a projectile's sprite),
##   weapon_fired(attack) (recoil when projectiles leave).

const WeaponProjectile := preload("res://scripts/combat/weapon_projectile.gd")
const FPS := 60
const ARC_STEP_DEG := 3.0
const ARC_CHUNK_DEG := 90.0
const AIMS := {"forward": Vector2(1, 0), "up": Vector2(0, -1), "down": Vector2(0, 1)}

var weapon: Dictionary
var attack: Dictionary
## Unit aim, wielder space.
var aim := Vector2.RIGHT
var frame := 0
var windup := 0
var active := 1
var recovery := 0
var total := 1
var cooldown := 0
var phase := ""
## Things hit by this attack (each at most once), and whether any hit landed yet.
var hits: Array = []
var landed := false
var bounced := false
## The wielder's weapon view (weapon_view.gd), told of phases and hits; may be null.
var view: Node2D = null


static func frames(seconds: float) -> int:
	return maxi(0, roundi(seconds * FPS))


func _init(weapon_: Dictionary, attack_: Dictionary, aim_: Vector2) -> void:
	weapon = weapon_
	attack = attack_
	aim = aim_
	var timing: Dictionary = attack.get("timing", {})
	windup = frames(float(timing.get("windup", 0.05)))
	active = maxi(1, frames(float(timing.get("active", 0.12))))
	recovery = frames(float(timing.get("recovery", 0.15)))
	total = windup + active + recovery
	cooldown = frames(float(attack.get("cooldown", 0.2)))


## The phase on frame `f` ("" once done).
func phase_at(f: int) -> String:
	if f < windup:
		return "windup"
	if f < windup + active:
		return "active"
	if f < total:
		return "recovery"
	return ""


## This frame's phase (before `step`).
func current_phase() -> String:
	return phase_at(frame)


## px/s forward while active (0 otherwise).
func lunge_now() -> float:
	return float(attack.get("movement", {}).get("lunge", 0.0)) if current_phase() == "active" else 0.0


func done() -> bool:
	return frame >= total


## Run this frame of the attack (hits while active); then the next frame. False once it is done.
func step(wielder) -> bool:
	if frame >= total:
		return false
	var now := phase_at(frame)
	if now != phase:
		phase = now
		if view != null:
			view.set_phase(attack, phase, aim, wielder.facing_sign())
	if now == "active":
		_active_frame(wielder, frame - windup)
	frame += 1
	if frame >= total:
		phase = ""
		if view != null:
			view.set_phase(attack, "", aim, wielder.facing_sign())
		return false
	return true


func _active_frame(wielder, i: int) -> void:
	var shape: Dictionary = attack.shape
	var facing: float = wielder.facing_sign()
	var centre: Vector2 = wielder.center()
	if str(shape.type) == "projectile":
		if i == 0:
			_fire(wielder, centre, facing)
		return
	var polygons := []
	for poly in hit_polygons(shape, aim, wielder.size(), i, active):
		polygons.append(to_world(poly, centre, facing))
	var push := Vector2(aim.x * facing, aim.y)
	for target in wielder.weapon_targets():
		if target in hits or not is_instance_valid(target):
			continue
		var box: Rect2 = target.rect()
		if not polygons.any(func(p): return polygon_hits_rect(p, box)):
			continue
		hits.append(target)
		if strike(target, int(attack.get("damage", 1)), push, float(attack.get("knockback", 350.0)), centre.x, facing):
			_landed(wielder, box.get_center())
	# A downward pogo strike bounces off hazards and breakable tiles too.
	if pogo_down(attack, aim) and not bounced:
		for solid in wielder.weapon_solids():
			if not str(solid.kind) in ["hazard", "breakable"]:
				continue
			var box := Rect2(float(solid.x), float(solid.y), float(solid.w), float(solid.h))
			if polygons.any(func(p): return polygon_hits_rect(p, box)):
				_landed(wielder, Vector2(clampf(centre.x, box.position.x, box.end.x), box.position.y))
				break


func _landed(wielder, point: Vector2) -> void:
	var first := not landed
	var bounce := pogo_down(attack, aim) and not bounced
	landed = true
	bounced = bounced or bounce
	if view != null:
		view.hit_at(point)
	wielder.weapon_landed(attack, point, first, bounce)


## A downward attack that bounces its wielder (movement.pogo while aiming in the down bucket).
static func pogo_down(attack_: Dictionary, aim_: Vector2) -> bool:
	return bool(attack_.get("movement", {}).get("pogo", false)) and aim_bucket(aim_) == "down"


func _fire(wielder, centre: Vector2, facing: float) -> void:
	var p: Dictionary = attack.shape.get("projectile", {})
	var speed := float(p.get("speed", 700.0))
	for heading in fan_headings(p, aim):
		var shot: Node2D = WeaponProjectile.new()
		shot.position = centre
		shot.velocity = Vector2(cos(heading) * facing, sin(heading)) * speed
		shot.gravity = float(p.get("gravity", 0.0))
		shot.life = float(p.get("lifetime", 1.2))
		shot.radius = float(p.get("size", 12.0))
		shot.pierce = int(p.get("pierce", 0))
		shot.color = Color(str(p.get("color", "#ffffff")))
		shot.texture = wielder.weapon_texture(p.get("sprite"))
		shot.damage = int(attack.get("damage", 1))
		shot.knockback = float(attack.get("knockback", 350.0))
		shot.wielder = wielder
		shot.runner = self
		wielder.get_parent().add_child(shot)
	wielder.weapon_fired(attack)


## A projectile of this attack landed a hit (weapon_projectile.gd).
func projectile_landed(wielder, point: Vector2) -> void:
	if is_instance_valid(wielder):
		_landed(wielder, point)


## Hit one target: an enemy (take_hit), a prop or a shot (struck) or the player (hit). True when it landed.
static func strike(target, damage: int, push: Vector2, knockback: float, from_x: float, fallback: float) -> bool:
	if target.has_method("take_hit"):
		if target.dead:
			return false
		target.take_hit(damage, push, knockback)
		return true
	if target.has_method("struck"):
		return target.struck(damage, push)
	if target.has_method("hit"):
		if not target.can_be_hurt():
			return false
		var direction := signf(target.position.x - from_x)
		target.hit(direction if direction != 0.0 else fallback, knockback, damage)
		return true
	return false


# --- geometry (weaponModel.ts) --------------------------------------------------------------

static func front_distance(aim_: Vector2, body: Vector2) -> float:
	return absf(aim_.x) * (body.x / 2.0) + absf(aim_.y) * (body.y / 2.0)


static func _rotate(v: Vector2, angle: float) -> Vector2:
	return Vector2(v.x * cos(angle) - v.y * sin(angle), v.x * sin(angle) + v.y * cos(angle))


static func _oriented_box(centre: Vector2, along: float, across: float, angle: float) -> PackedVector2Array:
	var out := PackedVector2Array()
	for c in [Vector2(along / 2.0, across / 2.0), Vector2(-along / 2.0, across / 2.0), Vector2(-along / 2.0, -across / 2.0), Vector2(along / 2.0, -across / 2.0)]:
		out.append(centre + _rotate(c, angle))
	return out


static func _arc_slice(radius: float, a0: float, a1: float) -> Array:
	var out := []
	var chunks := maxi(1, ceili(absf(a1 - a0) / deg_to_rad(ARC_CHUNK_DEG) - 1e-9))
	for c in chunks:
		var from := a0 + (a1 - a0) * c / chunks
		var to := a0 + (a1 - a0) * (c + 1) / chunks
		var steps := maxi(1, ceili(absf(to - from) / deg_to_rad(ARC_STEP_DEG) - 1e-9))
		var poly := PackedVector2Array([Vector2.ZERO])
		for k in steps + 1:
			var a := from + (to - from) * k / steps
			poly.append(Vector2(radius * cos(a), radius * sin(a)))
		out.append(poly)
	return out


## The hit region on active frame `i` of `active_frames`: convex polygons in wielder space (projectiles: none).
static func hit_polygons(shape: Dictionary, aim_: Vector2, body: Vector2, i: int, active_frames: int) -> Array:
	var angle := atan2(aim_.y, aim_.x)
	match str(shape.type):
		"arc":
			var from := float(shape.get("from", -60.0))
			var to := float(shape.get("to", 60.0))
			var a0 := angle + deg_to_rad(from + (to - from) * i / active_frames)
			var a1 := angle + deg_to_rad(from + (to - from) * (i + 1) / active_frames)
			return _arc_slice(float(shape.radius), a0, a1)
		"box":
			var front := front_distance(aim_, body)
			var off: Array = shape.get("offset", [0, 0])
			var offset := _rotate(Vector2(float(off[0]), float(off[1])), angle)
			return [_oriented_box(aim_ * front + offset, float(shape.width), float(shape.height), angle)]
		"thrust":
			var length := float(shape.length)
			return [_oriented_box(aim_ * (length / 2.0), length, float(shape.get("width", 24.0)), angle)]
	return []


static func to_world(poly: PackedVector2Array, centre: Vector2, facing: float) -> PackedVector2Array:
	var out := PackedVector2Array()
	for p in poly:
		out.append(centre + Vector2(p.x * facing, p.y))
	return out


## Strict overlap of a convex polygon and a rectangle (separating axes).
static func polygon_hits_rect(poly: PackedVector2Array, rect: Rect2) -> bool:
	var axes := [Vector2(1, 0), Vector2(0, 1)]
	var n := poly.size()
	for k in n:
		var e := poly[(k + 1) % n] - poly[k]
		if absf(e.x) + absf(e.y) > 1e-9:
			axes.append(Vector2(-e.y, e.x))
	var corners := [rect.position, Vector2(rect.end.x, rect.position.y), rect.end, Vector2(rect.position.x, rect.end.y)]
	for axis in axes:
		var p_min := INF
		var p_max := -INF
		for p in poly:
			var d: float = p.dot(axis)
			p_min = minf(p_min, d)
			p_max = maxf(p_max, d)
		var b_min := INF
		var b_max := -INF
		for p in corners:
			var d: float = p.dot(axis)
			b_min = minf(b_min, d)
			b_max = maxf(b_max, d)
		var scale: float = axis.length()
		if p_max <= b_min + 1e-9 * scale or b_max <= p_min + 1e-9 * scale:
			return false
	return true


## Strict overlap of a circle and a rectangle.
static func circle_hits_rect(centre: Vector2, radius: float, rect: Rect2) -> bool:
	var closest := Vector2(clampf(centre.x, rect.position.x, rect.end.x), clampf(centre.y, rect.position.y, rect.end.y))
	return centre.distance_squared_to(closest) < radius * radius


## Headings (radians, wielder space) of a projectile fan around `aim_`.
static func fan_headings(p: Dictionary, aim_: Vector2) -> Array:
	var angle := atan2(aim_.y, aim_.x)
	var n := int(p.get("count", 1))
	var spread := deg_to_rad(float(p.get("spread", 0.0)))
	var out := []
	for k in n:
		out.append(angle + (0.0 if n == 1 else spread * (float(k) / float(n - 1) - 0.5)))
	return out


# --- picking and showing attacks ------------------------------------------------------------

## The attack a press (held < 0) or a release after `held` seconds picks (weaponModel.ts pickAttack):
## trigger aim ("forward", "up", "down"; down only in the air), where, hold; longer hold, then an exact
## aim, then not a combo's next, then list order.
static func pick(weapon_: Dictionary, aim_name: String, airborne: bool, held: float) -> Dictionary:
	var effective := "forward" if aim_name == "down" and not airborne else aim_name
	var followups := {}
	for a in weapon_.get("attacks", []):
		var next = a.get("combo", {}).get("next")
		if next != null:
			followups[str(next)] = true
	var best := {}
	var best_rank := []
	for a in weapon_.get("attacks", []):
		var t: Dictionary = a.get("trigger", {})
		var where := str(t.get("where", "both"))
		var aim_of := str(t.get("aim", "forward"))
		var hold := float(t.get("hold", 0.0))
		if (where == "ground" and airborne) or (where == "air" and not airborne):
			continue
		if aim_of != "any" and aim_of != effective:
			continue
		if (held < 0.0 and hold > 0.0) or (held >= 0.0 and (hold <= 0.0 or hold > held + 1e-9)):
			continue
		var rank := [hold, 0 if aim_of == "any" else 1, 0 if followups.has(str(a.id)) else 1]
		if best.is_empty() or _better(rank, best_rank):
			best = a
			best_rank = rank
	return best


static func _better(a: Array, b: Array) -> bool:
	for k in a.size():
		if a[k] != b[k]:
			return a[k] > b[k]
	return false


## Mouse aiming (weaponModel.ts aimBucket): within AIM_BUCKET_DEG of straight up is "up", of
## straight down "down" (picking counts it only in the air), anything else "forward".
const AIM_BUCKET_DEG := 45.0


static func aim_bucket(aim_: Vector2) -> String:
	var edge := cos(deg_to_rad(AIM_BUCKET_DEG))
	if aim_.y <= -edge + 1e-6:
		return "up"
	if aim_.y >= edge - 1e-6:
		return "down"
	return "forward"


## How much of the turn toward a mouse aim the art shows (0..1), by the frames run so far: blended
## in over the windup, whole while active, out over the recovery.
func aim_weight() -> float:
	var f := float(frame)
	if f < windup:
		return f / float(windup)
	if f <= windup + active:
		return 1.0
	return clampf(1.0 - (f - windup - active) / maxf(1.0, float(recovery)), 0.0, 1.0)


## The way an attack's clip is drawn aiming (radians, wielder space): up or down for those triggers, else forward.
static func authored_angle(attack_: Dictionary) -> float:
	match str(attack_.get("trigger", {}).get("aim", "forward")):
		"up":
			return -PI / 2.0
		"down":
			return PI / 2.0
	return 0.0


## The aim an attack is made with: its trigger's, or the one held when it is "any" (or when chained).
static func aim_for(attack_: Dictionary, held_aim: String, airborne: bool) -> Vector2:
	var aim_of := str(attack_.get("trigger", {}).get("aim", "forward"))
	if aim_of == "any":
		aim_of = held_aim
	if aim_of == "down" and not airborne:
		aim_of = "forward"
	return AIMS.get(aim_of, Vector2.RIGHT)


## Clip slots by phase when the attack has no clip of its own (or the art lacks it).
const PHASE_SLOTS := {"windup": ["windup", "attack"], "active": ["strike", "attack"], "recovery": ["recover", "idle"]}


## Pose the wielder's rig for this frame of the attack: its own clip scaled to the whole attack
## (windup + active + recovery), else the clip slots of its phase. True when it posed the clip by time.
func pose_rig(rig: Node2D, first_clip: Callable) -> bool:
	var clip = attack.get("clip")
	if clip != null and rig.has_clip(str(clip)):
		if rig.current_clip() != str(clip):
			rig.play(str(clip), true)
		rig.manual_time = true
		rig.pose_at(rig.clip_duration(str(clip)) * clampf(float(frame) / float(maxi(1, total)), 0.0, 1.0))
		return true
	rig.play(first_clip.call(rig, PHASE_SLOTS.get(phase_at(mini(frame, total - 1)), ["attack"])))
	return false
