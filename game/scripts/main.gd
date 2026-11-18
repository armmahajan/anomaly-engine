extends Node2D
## Runtime entry point. Talks to the studio over window.postMessage and
## shows the playtest room (edit mode) or plays the world (rooms and doors) from the project spec it receives.
## Protocol: see packages/core/src/protocol.ts.

const PROTOCOL_VERSION := 15
const STUDIO_SOURCE := "anomaly-studio"
const RUNTIME_SOURCE := "anomaly-runtime"

const PlayerScript := preload("res://scripts/player.gd")
const EnemyScript := preload("res://scripts/enemy.gd")
const ProjectCheck := preload("res://scripts/project_check.gd")
const Registry := preload("res://primitives/registry.gd")
const HudScript := preload("res://scripts/hud.gd")
## Physics frames the world freezes for when a sword hit lands.
const HIT_STOP_FRAMES := 3
const RenderService := preload("res://scripts/art/render_service.gd")
const WorldView := preload("res://scripts/art/world_view.gd")
const StageView := preload("res://scripts/art/stage_view.gd")
const WorldStage := preload("res://scripts/art/world_stage.gd")
const Level := preload("res://scripts/level.gd")
const PropsScript := preload("res://scripts/props.gd")
const ModalLayer := preload("res://scripts/modal.gd")
const FxScript := preload("res://scripts/fx.gd")

var _project: Dictionary = {}
var _mode := "edit"
var _seed = null
var _deaths := 0
var _freeze := 0
var _hud: Node2D
## Last error reported to the studio (read by the headless simulator).
var last_error := ""
var _world: Node2D = null
var _player: Node = null
var _edit_camera: Camera2D
var _render_service: Node
## The current room's props (props.gd), modals and the map (modal.gd), feedback effects (fx.gd).
var _props: Node = null
var _modals: CanvasLayer = null
var _fx: Node = null
## Clip forced on a character in edit mode ("characterId" -> clip), for previews.
var _preview_clips := {}

var _window: JavaScriptObject = null
var _origin := ""
## Must stay referenced, or the JS callback is garbage collected.
var _on_message_ref: JavaScriptObject = null


func _ready() -> void:
	_register_actions()
	_edit_camera = Camera2D.new()
	add_child(_edit_camera)
	_edit_camera.make_current()
	get_viewport().size_changed.connect(_fit_edit_camera)
	var hud_layer := CanvasLayer.new()
	hud_layer.layer = 2  # above room frames
	add_child(hud_layer)
	_hud = HudScript.new()
	_hud.main = self
	_hud.visible = false
	hud_layer.add_child(_hud)
	_render_service = RenderService.new()
	add_child(_render_service)
	_run = WorldRuntime.new()
	_run.main = self
	add_child(_run)
	_run.events.changed.connect(func(): if _props != null and is_instance_valid(_props): _props.refresh())
	_modals = ModalLayer.new()
	add_child(_modals)
	_modals.setup(self)
	_modals.register(_run.events)
	_fx = FxScript.new()
	add_child(_fx)
	_fx.setup(self)
	_fx.register(_run.events)

	if OS.has_feature("web"):
		_window = JavaScriptBridge.get_interface("window")
		_origin = str(_window.location.origin)
		# The art pipeline opens a render-only page (?render): only redraw when asked.
		if str(_window.location.search).contains("render"):
			OS.low_processor_usage_mode = true
		_on_message_ref = JavaScriptBridge.create_callback(_on_js_message)
		_window.addEventListener("message", _on_message_ref)
	_send({
		"type": "ready",
		"protocolVersion": PROTOCOL_VERSION,
		"primitives": {"actions": Registry.ACTIONS.keys(), "conditions": Registry.CONDITIONS.keys(), "effects": _run.events.effect_types()},
	})


# --- messaging -------------------------------------------------------------

func _on_js_message(args: Array) -> void:
	if args.is_empty():
		return
	var event: JavaScriptObject = args[0]
	if str(event.origin) != _origin:
		return
	var data = event.data
	if typeof(data) != TYPE_STRING:
		return
	var envelope = JSON.parse_string(data)
	if typeof(envelope) != TYPE_DICTIONARY or envelope.get("source") != STUDIO_SOURCE:
		return  # not for us
	if int(envelope.get("protocolVersion", -1)) != PROTOCOL_VERSION:
		_error("protocol_mismatch", "runtime speaks protocol v%d" % PROTOCOL_VERSION)
		return
	var message = envelope.get("message")
	if typeof(message) != TYPE_DICTIONARY:
		_error("invalid_message", "message must be an object")
		return
	handle_message(message)


func handle_message(message: Dictionary) -> void:
	match str(message.get("type", "")):
		"load":
			if _mode == "play":
				_error("busy", "cannot load a project while playing; stop first")
				return
			var project = message.get("project")
			var problem: String = ProjectCheck.check(project)
			if problem != "":
				_error("invalid_project", problem)
				return
			_project = project
			_apply_controls()
			_build_world()
			_apply_stage()
			_send({"type": "loaded", "revision": int(_project.revision)})
		"play":
			var problem := "" if _project.is_empty() else _start_world_play(message.get("world"))
			if _project.is_empty():
				_error("not_loaded", "no project loaded")
			elif problem != "":
				_error("invalid_world_start", problem)
			else:
				_seed_run(int(message.get("seed", 0)))
				_deaths = 0
				_stage = {"mode": "game"}  # play always shows the game
				_apply_stage()
				_set_mode("play")
			_send({"type": "modeChanged", "mode": _mode})
		"stop":
			_run.stop()
			_modals.reset()
			_fx.reset()
			_build_world()  # back to spawn state = reset
			_seed = null
			_deaths = 0
			_set_mode("edit")
			_apply_stage()
			_send({"type": "modeChanged", "mode": _mode})
		"getState":
			var state := run_state()
			state.merge({"type": "state", "requestId": str(message.get("requestId", ""))})
			_send(state)
		"previewModal":
			if _mode != "play":
				_modals.preview(message.get("modalId"))
		"renderRig", "renderWorld":
			_render_service.render(message, _send)
		"images":
			var images = message.get("images")
			if typeof(images) == TYPE_DICTIONARY:
				_textures.merge(WorldView.textures_from(images), true)
				# The playtest room's dressing may have been waiting for these.
				if _mode == "edit" and _dressing_view == null and not _dressing_scene(_playtest_room()).is_empty():
					_build_world()
				_apply_stage()
		"stage":
			var stage = message.get("stage")
			if typeof(stage) != TYPE_DICTIONARY:
				_error("invalid_stage", "stage must be an object")
				return
			_stage = stage
			if _mode != "play":
				_apply_stage()
		"previewClip":
			var character_id := str(message.get("characterId", ""))
			var clip = message.get("clip")
			if clip == null:
				_preview_clips.erase(character_id)
			else:
				_preview_clips[character_id] = str(clip)
			_apply_preview_clips()
		"controls":
			var overrides = message.get("overrides")
			if typeof(overrides) != TYPE_DICTIONARY:
				_error("invalid_controls", "controls.overrides must be an object")
				return
			_player_keys = overrides
			_apply_controls()
		var other:
			_error("unknown_message", "unknown message type '%s'" % other)


## Everything the studio (and the headless simulator) can read about the runtime (protocol "state").
func run_state() -> Dictionary:
	var events = _run.events
	var playing: bool = _run.active
	return {
		"mode": _mode,
		"revision": int(_project.get("revision", -1)),
		"seed": _seed,
		"deaths": _deaths,
		"stage": str(_stage.get("mode", "game")),
		"dressed": _dressing_view != null,
		"entities": _entity_states(),
		"room": _run.room_id if playing else _shown_room().get("id"),
		"visited": _run.visited.duplicate() if playing else [],
		"entry": {"x": _run.entry.x, "y": _run.entry.y} if playing else null,
		"flags": events.flags.keys() if playing else [],
		"items": events.items.duplicate() if playing else {},
		"abilities": _run.abilities.duplicate() if playing else [],
		"checkpoint": events.checkpoint.duplicate() if playing and not events.checkpoint.is_empty() else null,
		"modal": _modals.current(),
		"mapOpen": _modals.map_open(),
		"healthBars": _hud.health_bars(),
		"props": _props.state() if _props != null and is_instance_valid(_props) else [],
		"camera": _camera_state(),
		"controls": _controls_state(),
	}


## Where the current camera looks (room px, the view's centre) and its zoom (screen px per room px).
func _camera_state():
	var camera := get_viewport().get_camera_2d()
	if camera == null:
		return null
	var at := camera.get_screen_center_position()
	return {"x": at.x, "y": at.y, "zoom": camera.zoom.x}


## Pause or resume gameplay (a modal is open): the room stops, doors and timers wait.
func set_paused(paused: bool) -> void:
	_run.paused = paused
	if _world != null and _mode == "play":
		_world.process_mode = Node.PROCESS_MODE_DISABLED if paused else Node.PROCESS_MODE_INHERIT


func _send(message: Dictionary) -> void:
	var payload := JSON.stringify({"source": RUNTIME_SOURCE, "message": message})
	if _window == null:
		print("[runtime] ", payload)
		return
	_window.parent.postMessage(payload, _origin)


func _error(code: String, text: String) -> void:
	last_error = "%s: %s" % [code, text]
	push_warning("[runtime] %s: %s" % [code, text])
	_send({"type": "error", "code": code, "message": text})


# --- world -----------------------------------------------------------------

## Edit mode: the playtest room, frozen, with the player at the playtest spot.
func _build_world() -> void:
	_freeze = 0
	if _project.is_empty():
		return
	RenderingServer.set_default_clear_color(Color(_project.world.get("backgroundColor", "#1b2030")))
	var room := _playtest_room()
	if room.is_empty():
		if _world != null:
			remove_child(_world)
			_world.queue_free()
		_world = null
		_player = null
		_dressing_view = null
		_hud.player = null
		return
	var test: Dictionary = _project.world.playtest
	_build_room(room, Vector2(test.x, test.y), null, test.get("abilities", []))
	_apply_preview_clips()
	_fit_edit_camera()


## The world's playtest room (with derived size and solids), or {}.
func _playtest_room() -> Dictionary:
	var test = _project.get("world", {}).get("playtest")
	return _room_by_id(str(test.room)) if typeof(test) == TYPE_DICTIONARY else {}


func _room_by_id(id: String) -> Dictionary:
	for room in _project.get("world", {}).get("rooms", []):
		if room.id == id:
			return room
	return {}


func _on_smashed(rect: Rect2) -> void:
	Level.clear(_world, rect)
	if _dressing_view != null and is_instance_valid(_dressing_view):
		_dressing_view.clear_terrain(rect)
		_dressing_view.remove_resting_on(rect)


## Every enemy gets its own RNG derived from the run seed and its spawn id.
func _seed_run(run_seed: int) -> void:
	_seed = run_seed
	for child in _world.get_children():
		if child is CharacterBody2D and "rng" in child:
			child.rng.seed = hash("%d:%s" % [run_seed, child.spawn_id])


## The player died: the world's death rule respawns them; the run keeps its seed.
func _restart_run() -> void:
	if _mode != "play" or not _run.active:
		return
	_deaths += 1
	_run.on_player_died()
	_seed_run(_seed)
	_set_mode("play")


func _hit_stop() -> void:
	hit_stop(HIT_STOP_FRAMES)


## Freeze the room for `frames` physics frames (play only).
func hit_stop(frames: int) -> void:
	if _mode == "play" and _world != null:
		_freeze = maxi(_freeze, frames)
		_world.process_mode = Node.PROCESS_MODE_DISABLED


func _physics_process(_delta: float) -> void:
	if _freeze > 0:
		_freeze -= 1
		if _freeze == 0 and _mode == "play" and _world != null and not _run.paused:
			_world.process_mode = Node.PROCESS_MODE_INHERIT


func _set_mode(mode: String) -> void:
	_mode = mode
	_freeze = 0
	_hud.visible = mode == "play"
	_apply_preview_clips()
	if _world != null:
		_world.process_mode = Node.PROCESS_MODE_INHERIT if mode == "play" else Node.PROCESS_MODE_DISABLED
	if mode == "play" and _player != null:
		_player.camera.make_current()
		_player.camera.snap()
		_focus_canvas()
	else:
		_edit_camera.make_current()
		_fit_edit_camera()


## Keyboard input only reaches the game when its canvas has focus.
func _focus_canvas() -> void:
	if _window == null:
		return
	var canvas = _window.document.getElementById("canvas")
	if canvas != null:
		canvas.focus()


## The room shown in edit mode: the Rooms stage's, else the playtest room ({} if none).
func _shown_room() -> Dictionary:
	var room := _stage_room()
	return room if not room.is_empty() else _playtest_room()


## In edit mode, show the whole room.
func _fit_edit_camera() -> void:
	if _project.is_empty():
		return
	var shown := _shown_room()
	if shown.is_empty():
		return
	var size := Vector2(shown.width, shown.height)
	var view := get_viewport_rect().size
	var z: float = min(view.x / size.x, view.y / size.y) * 0.95
	_edit_camera.zoom = Vector2(z, z)
	_edit_camera.position = size / 2.0


func _entity_states() -> Array:
	var out := []
	if _world == null:
		return out
	for child in _world.get_children():
		if child is CharacterBody2D:
			out.append({
				"spawnId": child.spawn_id,
				"characterId": child.character_id,
				"x": child.position.x,
				"y": child.position.y,
				"velocityX": child.velocity.x,
				"velocityY": child.velocity.y,
				"behaviorState": child.behavior_state if child.behavior_state != "" else null,
				"phase": child.phase if "phase" in child and child.phase != "" else null,
				"health": child.health,
			})
	return out


# --- input -----------------------------------------------------------------

## The input actions the game scripts read (player.gd, props.gd, modal.gd). Their keys are data:
## project.controls.bindings (the game's) with the player's overrides (the "controls" message),
## by key name (packages/core/src/controls/controls.ts KEY_NAMES). Menus also take Godot's ui_* keys.
const ACTIONS := ["move_left", "move_right", "jump", "attack", "aim_up", "aim_down", "dash", "interact", "map"]
## Key names that are not a letter or a digit -> Godot keys (by physical position, like the defaults).
const NAMED_KEYS := {
	"Space": KEY_SPACE, "Enter": KEY_ENTER, "Shift": KEY_SHIFT, "Ctrl": KEY_CTRL, "Alt": KEY_ALT,
	"Tab": KEY_TAB, "Backspace": KEY_BACKSPACE, "Up": KEY_UP, "Down": KEY_DOWN, "Left": KEY_LEFT,
	"Right": KEY_RIGHT, "Comma": KEY_COMMA, "Period": KEY_PERIOD, "Slash": KEY_SLASH,
	"Semicolon": KEY_SEMICOLON, "Quote": KEY_APOSTROPHE, "BracketLeft": KEY_BRACKETLEFT,
	"BracketRight": KEY_BRACKETRIGHT, "Minus": KEY_MINUS, "Equal": KEY_EQUAL,
	"Backslash": KEY_BACKSLASH, "Backquote": KEY_QUOTELEFT, "Insert": KEY_INSERT,
	"Delete": KEY_DELETE, "Home": KEY_HOME, "End": KEY_END, "PageUp": KEY_PAGEUP,
	"PageDown": KEY_PAGEDOWN,
}
## The player's own keys (protocol "controls"): action -> key names, replacing the game's for that action.
var _player_keys := {}


## Every action exists from the start (with no keys until a project arrives), so reading one never fails.
func _register_actions() -> void:
	for action in ACTIONS:
		if not InputMap.has_action(action):
			InputMap.add_action(action)


## Godot's key for a key name ("A", "7", "Space", "Left"), or KEY_NONE.
static func key_code(key_name: String) -> int:
	if key_name.length() == 1:
		var c := key_name.unicode_at(0)
		if c >= 65 and c <= 90:  # A-Z
			return KEY_A + (c - 65)
		if c >= 48 and c <= 57:  # 0-9
			return KEY_0 + (c - 48)
	return int(NAMED_KEYS.get(key_name, KEY_NONE))


## The keys in effect: the game's (project.controls.bindings) with the player's overrides on top.
func _bindings() -> Dictionary:
	var out := {}
	var controls = _project.get("controls")
	if typeof(controls) == TYPE_DICTIONARY and typeof(controls.get("bindings")) == TYPE_DICTIONARY:
		out = controls.bindings.duplicate()
	for action in _player_keys:
		if typeof(_player_keys[action]) == TYPE_ARRAY and not _player_keys[action].is_empty():
			out[action] = _player_keys[action]
	return out


## Rebuild the keyboard part of the input map; other events (e.g. gamepad buttons) stay.
func _apply_controls() -> void:
	var bindings := _bindings()
	for action in bindings:
		var keys = bindings[action]
		if typeof(keys) != TYPE_ARRAY:
			continue
		var codes := []
		for key_name in keys:
			var code := key_code(str(key_name))
			if code != KEY_NONE and not codes.has(code):
				codes.append(code)
		if codes.is_empty():
			continue  # nothing usable: keep what it has
		if not InputMap.has_action(action):
			InputMap.add_action(action)
		for event in InputMap.action_get_events(action):
			if event is InputEventKey:
				InputMap.action_erase_event(action, event)
		for code in codes:
			var event := InputEventKey.new()
			event.physical_keycode = code
			InputMap.action_add_event(action, event)
		Input.action_release(action)  # a key held while it changed doesn't stay pressed


## Keys per action as the input map has them (protocol state "controls").
func _controls_state() -> Dictionary:
	var names := {}
	for key_name in NAMED_KEYS:
		names[NAMED_KEYS[key_name]] = key_name
	var out := {}
	for action in ACTIONS:
		var keys := []
		for event in InputMap.action_get_events(action):
			if event is InputEventKey:
				var code: int = event.physical_keycode
				if code >= KEY_A and code <= KEY_Z or code >= KEY_0 and code <= KEY_9:
					keys.append(char(code))
				elif names.has(code):
					keys.append(names[code])
		out[action] = keys
	return out


# --- art previews ------------------------------------------------------------

## In edit mode, characters with a preview clip play it; in play mode, behavior decides.
func _apply_preview_clips() -> void:
	if _world == null:
		return
	for child in _world.get_children():
		if child is CharacterBody2D and child.has_method("set_preview_clip"):
			child.set_preview_clip(_preview_clips.get(child.character_id, "") if _mode == "edit" else "")


# --- stages (studio modes) -------------------------------------------------------

var _stage: Dictionary = {"mode": "game"}
var _stage_view: Node2D = null
var _world_stage: Node2D = null
## Decoded world images by file ref (sent once each with `images`).
var _textures := {}


## Show what the studio's mode asks for: the playtest room, one character, a biome room or a world room.
func _apply_stage() -> void:
	var mode := str(_stage.get("mode", "game"))
	if mode != "character" and _stage_view != null:
		_stage_view.queue_free()
		_stage_view = null
	if mode != "world" and _world_stage != null:
		_world_stage.queue_free()
		_world_stage = null
	_show_room_stage()
	if _world != null:
		_world.visible = mode == "game"
	if _dressing_view != null and is_instance_valid(_dressing_view):
		_dressing_view.set_shown(mode == "game")
	match mode:
		"game", "room":
			if _mode == "play" and _player != null:
				_player.camera.make_current()
			else:
				_edit_camera.make_current()
				_fit_edit_camera()
		"character":
			if _project.is_empty():
				return
			if _stage_view == null:
				_stage_view = StageView.new()
				add_child(_stage_view)
			var problem: String = _stage_view.apply(_project, _stage)
			if problem != "":
				_send({"type": "error", "code": "stage", "message": problem})
		"world":
			if _world_stage == null:
				_world_stage = WorldStage.new()
				_world_stage.send = _send
				add_child(_world_stage)
			_world_stage.apply(_stage, _textures)


# --- dressed rooms -------------------------------------------------------------------

var _dressing_view: Node2D = null


## A world room's dressing as a world scene (core worldSceneFor), or {} if none / images not here yet.
func _dressing_scene(level: Dictionary) -> Dictionary:
	if _project.is_empty() or level.is_empty():
		return {}
	var dressing = level.get("dressing")
	if typeof(dressing) != TYPE_DICTIONARY:
		return {}
	var biome = null
	for asset in _project.get("art", {}).get("assets", []):
		if asset.get("id") == dressing.get("biome") and asset.get("kind") == "biome":
			biome = asset
	if biome == null or typeof(biome.get("kit")) != TYPE_DICTIONARY:
		return {}
	var room = null
	for r in biome.get("rooms", []):
		if r.get("id") == dressing.get("room"):
			room = r
	if room == null:
		return {}
	var kit: Dictionary = biome.kit
	var refs := [kit.backdrop, kit.ground]
	for plane in kit.get("backgrounds", []):
		refs.append(plane.file)
	for ref in refs:
		if not _textures.has(ref):
			return {}
	var scene: Dictionary = room.composition.duplicate()
	scene.merge({
		"name": room.name,
		"width": maxf(960.0, float(level.width)),
		"height": maxf(360.0, float(level.height)),
		"backdrop": kit.backdrop,
		"backgrounds": kit.get("backgrounds", []),
		"atmosphere": kit.get("atmosphere", {}),
		"ground": kit.ground,
		"pieces": kit.pieces,
		"platforms": level.solids.filter(func(p): return str(p.kind) != "breakable" and float(p.height) >= 8.0).map(func(p): return {"x": p.x, "y": p.y, "width": p.width, "height": p.height}),
		"terrain": {"grid": level.grid, "ledgeThickness": int(_project.get("world", {}).get("ledgeThickness", 20))},
	}, true)
	return scene


func _process(delta: float) -> void:
	if _dressing_view != null and is_instance_valid(_dressing_view):
		var camera := get_viewport().get_camera_2d()
		if camera != null:
			_dressing_view.focus = camera.get_screen_center_position()
		if _player != null and is_instance_valid(_player):
			_dressing_view.fade_front_around(_player.center(), delta)
	if _room_dressing != null and is_instance_valid(_room_dressing):
		_room_dressing.focus = _edit_camera.get_screen_center_position()


# --- world play (rooms and doors; the run and its rules live in world_runtime.gd) ----------

const WorldRuntime := preload("res://scripts/world_runtime.gd")
var _run: Node = null
## Rooms stage (edit mode): a frozen view of one world room.
var _room_view: Node2D = null
var _room_dressing: Node2D = null


## A play message's world start begins a run there; without one, at the world's playtest. Returns a problem or "".
func _start_world_play(start) -> String:
	if typeof(start) != TYPE_DICTIONARY:
		var test = _project.get("world", {}).get("playtest")
		if typeof(test) != TYPE_DICTIONARY:
			return "no playtest room: set one first"
		start = {"room": test.room, "x": test.x, "y": test.y, "abilities": test.get("abilities", [])}
	return _run.start(_project, start)


## Replace the level with a world room, the player at `at` (`carried` through a door, else a fresh one).
func _build_room(room: Dictionary, at: Vector2, carried: Node, abilities: Array) -> void:
	if carried != null and carried.get_parent() != null:
		carried.get_parent().remove_child(carried)
	if _world != null:
		remove_child(_world)
		_world.queue_free()
	_freeze = 0
	_world = Node2D.new()
	_world.name = "World"
	_world.process_mode = Node.PROCESS_MODE_INHERIT if _mode == "play" else Node.PROCESS_MODE_DISABLED
	add_child(_world)
	var bounds := _room_bounds(room, abilities)
	var player: Node = carried
	if player == null:
		player = PlayerScript.new()
		player.setup(_player_character(), bounds, at, _project.get("art", {}))
		player.spawn_id = "player"
		player.landed_hit.connect(_hit_stop)
		player.died.connect(_restart_run, CONNECT_DEFERRED)
		player.smashed.connect(_on_smashed)
		player.touched_hazard.connect(_run.on_hazard_touched)
	var level := _populate_room(_world, room, bounds, player)
	_dressing_view = level.dressing
	_props = level.props
	player._spawn = at
	player._kill_y = float(room.height) + 400.0
	player.camera.room_size = Vector2(float(room.width), float(room.height))
	player.camera.rows = view_rows()
	player.solids = level.solids
	player.enemies = level.enemies
	for enemy in level.enemies:
		enemy.player = player
	_player = player
	_hud.player = player
	if _mode == "play":
		player.camera.make_current()
	player.camera.snap()
	if _seed != null:
		_seed_run(_seed)


## What characters set up from (the world's gravity, the room's size, the run's abilities).
func _room_bounds(room: Dictionary, abilities: Array) -> Dictionary:
	return {"gravity": _project.world.get("gravity", 1800), "width": room.width, "height": room.height, "playerAbilities": abilities, "viewRows": view_rows()}


## Tiles the play view shows top to bottom (world.camera.rows).
func view_rows() -> float:
	return float(_project.get("world", {}).get("camera", {}).get("rows", 14))


func _player_character() -> Dictionary:
	for c in _project.characters:
		if c.kind == "player":
			return c
	return {}


## A room's dressing, solids, the player (if given) and its enemies under `parent`.
func _populate_room(parent: Node2D, room: Dictionary, bounds: Dictionary, player: Node) -> Dictionary:
	var dressing_view: Node2D = null
	var scene := _dressing_scene(room)
	if not scene.is_empty():
		dressing_view = WorldView.new()
		dressing_view.process_mode = Node.PROCESS_MODE_ALWAYS
		dressing_view.vignette = false
		# Beyond the room's edges only its far planes show, fogged (a room smaller than the view sits centred in them).
		dressing_view.frame_room = true
		# Playing, the layers line up for the play camera's view; edit views fit the whole room.
		dressing_view.view_height = view_rows() * WorldRuntime.TILE if player != null and _run.active else 0.0
		parent.add_child(dressing_view)
		dressing_view.build(scene, _textures, Vector2(room.width, room.height) * 1.5)
	else:
		_frame_room(parent, room)
	var solids: Array = Level.build(parent, room.solids, Color(_project.world.get("platformColor", "#4a5470")), dressing_view != null, room.get("grid"), int(_project.get("world", {}).get("ledgeThickness", 20)))
	Level.add_enemy_bounds(parent, float(room.width), float(room.height))
	if player != null:
		parent.add_child(player)
	var characters := {}
	for c in _project.characters:
		characters[c.id] = c
	var enemies := []
	for spawn in room.spawns:
		var character: Dictionary = characters.get(spawn.characterId, {})
		if character.get("kind") != "enemy":
			continue
		# Conditional spawns (e.g. stay beaten) follow the run; edit views show every spawn.
		if player != null and _run.active and spawn.get("when") != null and not _run.events.holds(spawn.when):
			continue
		var body: CharacterBody2D = EnemyScript.new()
		body.setup(character, bounds, Vector2(spawn.x, spawn.y), _project.get("art", {}))
		body.spawn_id = spawn.id
		if player != null:
			body.killed.connect(_run.on_enemy_killed.bind(str(spawn.id), str(spawn.characterId)))
		parent.add_child(body)
		enemies.append(body)
	var props: Node = PropsScript.new()
	props.name = "Props"
	parent.add_child(props)
	props.setup(self, room, solids, player)
	return {"solids": solids, "enemies": enemies, "dressing": dressing_view, "props": props}


## Shade everything outside a plain (undressed) room, so a room smaller than the view sits framed in it.
func _frame_room(parent: Node2D, room: Dictionary) -> void:
	var frame := CanvasLayer.new()
	frame.name = "RoomFrame"
	frame.layer = 1
	frame.follow_viewport_enabled = true
	parent.add_child(frame)
	# A CanvasLayer doesn't inherit visibility: hide it with its room (e.g. the playtest room behind the Rooms stage).
	var follow := func(): frame.visible = parent.is_visible_in_tree()
	parent.visibility_changed.connect(follow)
	follow.call()
	var w := float(room.width)
	var h := float(room.height)
	var m := 100000.0
	var color := Color(str(_project.world.get("backgroundColor", "#1b2030"))).darkened(0.35)
	for r in [Rect2(-m, -m, w + 2.0 * m, m), Rect2(-m, h, w + 2.0 * m, m), Rect2(-m, 0, m, h), Rect2(w, 0, m, h)]:
		var rect := ColorRect.new()
		rect.position = r.position
		rect.size = r.size
		rect.color = color
		rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
		frame.add_child(rect)


## The world room the Rooms stage shows, or {}.
func _stage_room() -> Dictionary:
	if str(_stage.get("mode", "")) != "room" or _project.is_empty():
		return {}
	for room in _project.get("world", {}).get("rooms", []):
		if room.id == _stage.get("roomId"):
			return room
	return {}


func _show_room_stage() -> void:
	if _room_view != null:
		remove_child(_room_view)
		_room_view.queue_free()
		_room_view = null
		_room_dressing = null
	var room := _stage_room()
	if room.is_empty() or _mode == "play":
		return
	_room_view = Node2D.new()
	_room_view.process_mode = Node.PROCESS_MODE_DISABLED
	add_child(_room_view)
	_room_dressing = _populate_room(_room_view, room, _room_bounds(room, []), null).dressing
	var markers := RoomMarkers.new()
	markers.room = room
	markers.start = _project.get("world", {}).get("start")
	_room_view.add_child(markers)


## Rooms stage overlay: door openings (green when connected) and the world's start.
class RoomMarkers extends Node2D:
	var room: Dictionary
	var start = null

	func _draw() -> void:
		for door in room.doors:
			var lo := float(door.offset) * 32.0
			var length := float(door.size) * 32.0
			var color := Color("#5fd3a0") if typeof(door.get("to")) == TYPE_DICTIONARY else Color("#e0b050")
			match str(door.side):
				"left":
					draw_rect(Rect2(0, lo, 6, length), color)
				"right":
					draw_rect(Rect2(float(room.width) - 6.0, lo, 6, length), color)
				"top":
					draw_rect(Rect2(lo, 0, length, 6), color)
				"bottom":
					draw_rect(Rect2(lo, float(room.height) - 6.0, length, 6), color)
		if typeof(start) == TYPE_DICTIONARY and start.get("room") == room.id:
			var box := Rect2(Vector2(start.x, start.y) - Vector2(14, 44), Vector2(28, 44))
			draw_rect(box, Color(1, 1, 1, 0.3))
			draw_rect(box, Color.WHITE, false, 2.0)
