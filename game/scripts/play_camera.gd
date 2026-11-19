extends Camera2D
## The play camera. Its zoom is fixed by the world's camera setting: `rows` tiles fill the view's
## height (the width follows the window). It follows `target` (the player) on both axes with a
## deadzone and a little look-ahead, clamped to the room; on an axis where the room is smaller
## than the view, the room is centred. main.gd sets `room_size` on every room entry; `snap()`
## jumps straight to the player (room entries, respawns, play starting).

const TILE := 32.0
## Half-size of the deadzone as shares of the view: the player moves this far before the camera follows.
const DEADZONE := Vector2(0.06, 0.12)
## Look-ahead toward where the player faces, as a share of the view's width.
const LOOK_AHEAD := 0.16
## How fast the look-ahead swings across, in view widths per second.
const LOOK_SPEED := 0.3
## Standing, the player rests this share of the view's height below its centre (more to see above).
const STAND_BIAS := 0.1
## How fast (1/s) the camera catches up with where it wants to be.
const FOLLOW := 7.0
## The view is never narrower than this (width / height).
const MIN_ASPECT := 1.6

var target: Node2D = null
## Tiles the view shows top to bottom (world.camera.rows).
var rows := 14.0
var room_size := Vector2(960, 448)
## A cameraZoom punch on top of the fitted zoom (fx.gd sets it; 1 = none).
var punch := 1.0
## Where the deadzone is centred (world px).
var _anchor := Vector2.ZERO
var _look := 0.0


func _init() -> void:
	top_level = true  # placed by this script, not carried by the player's transform
	process_priority = -10  # before the room's parallax reads where the camera looks


## Screen px per world px: the view's height holds `rows` tiles. A window narrower than MIN_ASPECT
## keeps that aspect's width instead (and shows more height), so a portrait window isn't a slit.
func fitted_zoom() -> float:
	var size := get_viewport_rect().size
	var tall := maxf(rows, 1.0) * TILE
	return minf(size.y / tall, size.x / (tall * MIN_ASPECT))


## Size of the view in world px.
func view_size() -> Vector2:
	return get_viewport_rect().size / fitted_zoom()


func _process(delta: float) -> void:
	follow(delta)


## Jump to the target at once (no easing, look-ahead reset).
func snap() -> void:
	if target == null or not is_instance_valid(target) or not is_inside_tree():
		return
	_apply_zoom()
	_look = 0.0
	_anchor = _point() - Vector2(0.0, STAND_BIAS * view_size().y)
	global_position = _clamped(_anchor)
	reset_smoothing()
	force_update_scroll()


func follow(delta: float) -> void:
	if target == null or not is_instance_valid(target) or not is_inside_tree():
		return
	_apply_zoom()
	var view := view_size()
	var p := _point()
	var dz := DEADZONE * view
	# Horizontal: a deadzone, plus look-ahead toward where the player runs.
	if p.x > _anchor.x + dz.x:
		_anchor.x = p.x - dz.x
	elif p.x < _anchor.x - dz.x:
		_anchor.x = p.x + dz.x
	var vx: float = target.velocity.x if "velocity" in target else 0.0
	if absf(vx) > 20.0:
		_look = move_toward(_look, signf(vx) * LOOK_AHEAD * view.x, LOOK_SPEED * view.x * delta)
	# Vertical: standing, settle with the player a little below the centre; in the air, only
	# follow once they leave the deadzone (a jump doesn't drag the view up and down).
	var rest := p.y - STAND_BIAS * view.y
	if target.get("_on_floor") == true:
		_anchor.y = move_toward(_anchor.y, rest, maxf(absf(rest - _anchor.y), view.y * 0.25) * minf(1.0, 4.0 * delta))
	elif rest < _anchor.y - dz.y:
		_anchor.y = rest + dz.y
	elif rest > _anchor.y + dz.y:
		_anchor.y = rest - dz.y
	var goal := _clamped(_anchor + Vector2(_look, 0.0))
	global_position = _clamped(global_position.lerp(goal, 1.0 - exp(-FOLLOW * delta)))
	force_update_scroll()


func _apply_zoom() -> void:
	var z := fitted_zoom() * punch
	zoom = Vector2(z, z)
	position_smoothing_enabled = false
	# The script keeps the view inside the room (and centres small rooms), not Camera2D's limits.
	limit_left = -10000000
	limit_top = -10000000
	limit_right = 10000000
	limit_bottom = 10000000


func _point() -> Vector2:
	return target.center() if target.has_method("center") else target.global_position


## A camera centre that keeps the view inside the room; centred on an axis where the room is smaller.
func _clamped(at: Vector2) -> Vector2:
	var half := view_size() / 2.0
	var out := at
	for axis in 2:
		var size: float = room_size[axis]
		out[axis] = size / 2.0 if size <= half[axis] * 2.0 else clampf(at[axis], half[axis], size - half[axis])
	return out
