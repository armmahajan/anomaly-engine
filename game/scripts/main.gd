extends Node2D
## Runtime entry point. Talks to the studio over window.postMessage and
## builds the sandbox scene from the project spec it receives.
## Protocol: see packages/core/src/protocol.ts.

const PROTOCOL_VERSION := 9
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
## Clip forced on a character in edit mode ("characterId" -> clip), for previews.
var _preview_clips := {}

var _window: JavaScriptObject = null
var _origin := ""
## Must stay referenced, or the JS callback is garbage collected.
var _on_message_ref: JavaScriptObject = null


func _ready() -> void:
	_setup_input()
	_edit_camera = Camera2D.new()
	add_child(_edit_camera)
	_edit_camera.make_current()
	get_viewport().size_changed.connect(_fit_edit_camera)
	var hud_layer := CanvasLayer.new()
	add_child(hud_layer)
	_hud = HudScript.new()
	_hud.visible = false
	hud_layer.add_child(_hud)
	_render_service = RenderService.new()
	add_child(_render_service)

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
		"primitives": {"actions": Registry.ACTIONS.keys(), "conditions": Registry.CONDITIONS.keys()},
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
			_build_world()
			_apply_stage()
			_send({"type": "loaded", "revision": int(_project.revision)})
		"play":
			if _project.is_empty():
				_error("not_loaded", "no project loaded")
			else:
				_seed_run(int(message.get("seed", 0)))
				_deaths = 0
				_stage = {"mode": "game"}  # play always happens in the arena
				_apply_stage()
				_set_mode("play")
			_send({"type": "modeChanged", "mode": _mode})
		"stop":
			_build_world()  # back to spawn state = reset
			_seed = null
			_deaths = 0
			_set_mode("edit")
			_apply_stage()
			_send({"type": "modeChanged", "mode": _mode})
		"getState":
			_send({
				"type": "state",
				"requestId": str(message.get("requestId", "")),
				"mode": _mode,
				"revision": int(_project.get("revision", -1)),
				"seed": _seed,
				"deaths": _deaths,
				"stage": str(_stage.get("mode", "game")),
				"dressed": _dressing_view != null,
				"entities": _entity_states(),
			})
		"renderRig", "renderWorld":
			_render_service.render(message, _send)
		"images":
			var images = message.get("images")
			if typeof(images) == TYPE_DICTIONARY:
				_textures.merge(WorldView.textures_from(images), true)
				# The arena's dressing may have been waiting for these.
				if _mode == "edit" and _dressing_view == null and not _dressing_scene().is_empty():
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
		var other:
			_error("unknown_message", "unknown message type '%s'" % other)


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

func _build_world() -> void:
	if _world != null:
		remove_child(_world)
		_world.queue_free()
		_world = null
		_player = null
	_freeze = 0
	if _project.is_empty():
		return

	var sandbox: Dictionary = _project.sandbox
	RenderingServer.set_default_clear_color(Color(sandbox.backgroundColor))

	_world = Node2D.new()
	_world.name = "World"
	_world.process_mode = Node.PROCESS_MODE_DISABLED  # frozen until play
	add_child(_world)

	var platform_color := Color(sandbox.platformColor)
	# A dressed arena: the biome room draws the platforms (textured) and everything around them.
	var dressing := _dressing_scene()
	_dressing_view = null
	if not dressing.is_empty():
		_dressing_view = WorldView.new()
		_dressing_view.process_mode = Node.PROCESS_MODE_ALWAYS  # parallax follows the edit camera too
		_dressing_view.vignette = false
		_world.add_child(_dressing_view)
		_dressing_view.build(dressing, _textures, Vector2(sandbox.width, sandbox.height) * 1.5)
	var solids: Array = Level.build(_world, sandbox.solids, platform_color, _dressing_view != null, sandbox.get("grid"), int(_project.get("world", {}).get("ledgeThickness", 20)))

	var characters := {}
	for c in _project.characters:
		characters[c.id] = c
	var enemies := []
	for spawn in sandbox.spawns:
		var character: Dictionary = characters[spawn.characterId]
		var body: CharacterBody2D = PlayerScript.new() if character.kind == "player" else EnemyScript.new()
		body.setup(character, sandbox, Vector2(spawn.x, spawn.y), _project.get("art", {}))
		body.spawn_id = spawn.id
		_world.add_child(body)
		if character.kind == "player":
			_player = body
		else:
			enemies.append(body)
	for enemy in enemies:
		enemy.player = _player
	if _player != null:
		_player.solids = solids
		_player.enemies = enemies
		_player.landed_hit.connect(_hit_stop)
		_player.died.connect(_restart_run, CONNECT_DEFERRED)
		_player.smashed.connect(_on_smashed)
	_hud.player = _player
	_apply_preview_clips()

	_fit_edit_camera()


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


## The player died: rebuild the arena and replay the same seed.
func _restart_run() -> void:
	if _mode != "play":
		return
	_deaths += 1
	_build_world()
	_seed_run(_seed)
	_set_mode("play")


func _hit_stop() -> void:
	if _mode == "play":
		_freeze = HIT_STOP_FRAMES
		_world.process_mode = Node.PROCESS_MODE_DISABLED


func _physics_process(_delta: float) -> void:
	if _freeze > 0:
		_freeze -= 1
		if _freeze == 0 and _mode == "play" and _world != null:
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
		_player.camera.reset_smoothing()
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


## In edit mode, show the whole arena.
func _fit_edit_camera() -> void:
	if _project.is_empty():
		return
	var arena := Vector2(_project.sandbox.width, _project.sandbox.height)
	var view := get_viewport_rect().size
	var z: float = min(view.x / arena.x, view.y / arena.y) * 0.95
	_edit_camera.zoom = Vector2(z, z)
	_edit_camera.position = arena / 2.0


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
				"health": child.health,
			})
	return out


# --- input -----------------------------------------------------------------

func _setup_input() -> void:
	_add_action("move_left", [KEY_A, KEY_LEFT])
	_add_action("move_right", [KEY_D, KEY_RIGHT])
	_add_action("jump", [KEY_SPACE, KEY_Z])
	_add_action("attack", [KEY_X, KEY_J])
	_add_action("aim_up", [KEY_W, KEY_UP])
	_add_action("aim_down", [KEY_S, KEY_DOWN])
	_add_action("dash", [KEY_C, KEY_SHIFT, KEY_K])


func _add_action(action: String, keys: Array) -> void:
	if not InputMap.has_action(action):
		InputMap.add_action(action)
	for key in keys:
		var event := InputEventKey.new()
		event.physical_keycode = key
		InputMap.action_add_event(action, event)


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


## Show what the studio's mode asks for: the arena, one character, or a world room.
func _apply_stage() -> void:
	var mode := str(_stage.get("mode", "game"))
	if mode != "character" and _stage_view != null:
		_stage_view.queue_free()
		_stage_view = null
	if mode != "world" and _world_stage != null:
		_world_stage.queue_free()
		_world_stage = null
	if _world != null:
		_world.visible = mode == "game"
	if _dressing_view != null and is_instance_valid(_dressing_view):
		_dressing_view.set_shown(mode == "game")
	match mode:
		"game":
			if _mode == "play" and _player != null:
				_player.camera.make_current()
			else:
				_edit_camera.make_current()
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


# --- the dressed arena ------------------------------------------------------------

var _dressing_view: Node2D = null


## The arena's dressing as a world scene (core worldSceneFor), or {} if none / images not here yet.
func _dressing_scene() -> Dictionary:
	if _project.is_empty():
		return {}
	var sandbox: Dictionary = _project.sandbox
	var dressing = sandbox.get("dressing")
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
	for ref in [kit.backdrop, kit.ground]:
		if not _textures.has(ref):
			return {}
	var scene: Dictionary = room.composition.duplicate()
	scene.merge({
		"name": room.name,
		"width": maxf(960.0, float(sandbox.width)),
		"height": maxf(360.0, float(sandbox.height)),
		"backdrop": kit.backdrop,
		"ground": kit.ground,
		"pieces": kit.pieces,
		"platforms": sandbox.solids.filter(func(p): return str(p.kind) != "breakable" and float(p.height) >= 8.0).map(func(p): return {"x": p.x, "y": p.y, "width": p.width, "height": p.height}),
		"terrain": {"grid": sandbox.grid, "ledgeThickness": int(_project.get("world", {}).get("ledgeThickness", 20))},
	}, true)
	return scene


func _process(delta: float) -> void:
	if _dressing_view != null and is_instance_valid(_dressing_view):
		var camera := get_viewport().get_camera_2d()
		if camera != null:
			_dressing_view.focus = camera.get_screen_center_position()
		if _player != null and is_instance_valid(_player):
			_dressing_view.fade_front_around(_player.center(), delta)
