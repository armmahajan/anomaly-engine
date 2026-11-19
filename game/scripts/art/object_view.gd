extends Node2D
## Draws one object asset (core art/asset.ts: a character asset with subject "object": a switch, a jaw,
## a shockwave, a bolt) and plays its clips. Props (props.gd), effects (fx.gd spawnEffect, projectile
## bursts) and projectiles (combat/projectile.gd, weapon_projectile.gd) use it. Contract:
## packages/core/src/art/animation.ts.
##
## The rig is drawn by rig_view.gd like any character's, centred: the rest pose's bounds are centred on
## this node's origin (scale with `fit` or `scale`). It loops its idle clip (none = the rest pose);
## `play_once` plays another clip, then goes back to idle or holds the last frame. Every marker its
## clips cross is re-emitted as `marker` (the owner routes it as an event: events.gd `marker`).

const CharacterArt := preload("res://scripts/art/character_art.gd")
const RigView := preload("res://scripts/art/rig_view.gd")

## A clip reached one of its markers (once per pass, in time order).
signal marker(marker_name: String, clip: String)
## A clip played with `play_once` (or a one-shot clip shown with `show_once`) reached its end.
signal finished(clip: String)

var asset_id := ""
## The rest pose's bounds, rig space (feet origin).
var bounds := Rect2(-12, -24, 24, 24)

var _rig: Node2D = null
var _idle := ""
## The clip a play_once is playing ("" = none), what follows it, and whether it is now held.
var _once := ""
var _then := "idle"
var _held := false


## An object asset by id: a character asset with a rig (objects are subject "object"; any rigged
## character asset draws the same way), or {}.
static func find_asset(art: Variant, id: String) -> Dictionary:
	if typeof(art) != TYPE_DICTIONARY or id == "":
		return {}
	for asset in art.get("assets", []):
		if typeof(asset) == TYPE_DICTIONARY and asset.get("id") == id and asset.get("kind") == "character" and typeof(asset.get("rig")) == TYPE_DICTIONARY:
			return asset
	return {}


## The main node (main.gd) above `node`, or null.
static func main_of(node: Node) -> Node:
	var at := node
	while at != null:
		if "_run" in at and "_fx" in at and "_project" in at:
			return at
		at = at.get_parent()
	return null


## Build the view for `asset` (find_asset). `idle`: the clip it loops ("" or unknown = rest pose).
## `markers`: fire `marker` as its clips play (play only).
func setup(asset: Dictionary, art: Dictionary, idle := "", markers := true) -> void:
	asset_id = str(asset.get("id", ""))
	_rig = CharacterArt.make_view(asset, art)
	_rig.emit_markers = markers
	_rig.marker.connect(func(marker_name: String, clip: String): marker.emit(marker_name, clip))
	_rig.posed.connect(_on_posed)
	bounds = RigView.rest_bounds_of(asset.rig)
	add_child(_rig)
	_rig.position = -bounds.get_center()
	_idle = idle if _rig.has_clip(idle) else ""
	_rig.play(_idle)


## Scale so the rest pose fits `size` (keeping its shape), times `scale`.
func fit(size: Vector2, k := 1.0) -> void:
	var b := bounds.size.max(Vector2(1, 1))
	var s := minf(size.x / b.x, size.y / b.y) * k
	scale = Vector2(s, s)


func has_clip(clip: String) -> bool:
	return _rig != null and _rig.has_clip(clip)


func clip_loops(clip: String) -> bool:
	return bool(_rig.clip_data(clip).get("loop", true)) if has_clip(clip) else false


## Play `clip` from its start; when a one-shot clip ends: back to idle ("idle") or hold its last
## frame ("hold"). A looping clip keeps looping (until another play). False (and nothing changes)
## when the object has no such clip.
func play_once(clip: String, then := "idle") -> bool:
	if not has_clip(clip):
		return false
	_once = clip
	_then = then
	_held = false
	_rig.play(clip, true)
	return true


## Loop (or play) `clip` as its usual clip, from its start ("" = rest pose).
func play_loop(clip: String) -> void:
	_once = ""
	_held = false
	_idle = clip if has_clip(clip) else ""
	_rig.play(_idle, true)


## The clip a play_once is playing (until it ends), else null (state: props[].playing).
func playing() -> Variant:
	return _once if _once != "" and not _held else null


## The clip shown now ("" = rest pose) and how far into it (seconds).
func current_clip() -> String:
	return _rig.current_clip() if _rig != null else ""


func clip_time() -> float:
	return _rig.clip_time() if _rig != null else 0.0


func held() -> bool:
	return _held


func _on_posed() -> void:
	if _once == "" or _held or not _rig.clip_ended():
		return
	var clip := _once
	if _then == "hold":
		_held = true
	else:
		_once = ""
		_rig.play(_idle, true)
	finished.emit(clip)
