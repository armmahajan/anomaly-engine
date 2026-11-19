extends SceneTree
## Headless probe for game/test/looks.test.ts (looks: setLook, clearLook, emit, dissolve, cameraZoom,
## stateEntered, a behavior state's look, the character stage's look). Plays each scenario's world and,
## at given frames, fires events, runs effects (as a handler would) or hurts a spawn; every frame it
## reports the runtime state's look fields and what each look view shows (art/look_view.gd describe).
##   godot --headless --fixed-fps 60 --path game --script res://tests/look_probe.gd -- in.json out.json
## in.json:  {"scenarios": [{"project", "world"?, "frames", "actions": [action], "stage"?}]}
##   action: {"frame", "do": "fire", "event"} | {"frame", "do": "effects", "effects", "context"?: {prop?, spawn?}}
##           | {"frame", "do": "hurt", "spawn", "damage"} | {"frame", "do": "place", "x", "y"}
##   stage: a `stage` message's stage, applied (edit mode) instead of playing; reports its look view.
## out.json: {"results": [{"error", "frames": [frame], "stage"?}]}

const WorldRuntime := preload("res://scripts/world_runtime.gd")


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var input = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	var results := []
	for scenario in input.scenarios:
		results.append(await _probe(scenario))
	FileAccess.open(args[1], FileAccess.WRITE).store_string(JSON.stringify({"results": results}))
	quit()


func _probe(scenario: Dictionary) -> Dictionary:
	WorldRuntime._memory_store.clear()
	var main: Node = load("res://main.tscn").instantiate()
	root.add_child(main)
	main.handle_message({"type": "load", "project": scenario.project})
	if typeof(scenario.get("stage")) == TYPE_DICTIONARY:
		main.handle_message({"type": "stage", "stage": scenario.stage})
		var shown := []
		for i in 30:
			await process_frame
			if i == 4 or i == 29:
				shown.append(main._stage_view.look_state())
		var cleared: Dictionary = scenario.stage.duplicate()
		cleared.erase("look")
		main.handle_message({"type": "stage", "stage": cleared})
		for i in 30:
			await process_frame
		shown.append(main._stage_view.look_state())
		var error: String = main.last_error
		main.queue_free()
		await process_frame
		return {"error": error, "frames": [], "stage": shown}
	main.handle_message({"type": "play", "seed": 1, "world": scenario.get("world")})
	var frames := []
	var actions: Array = scenario.get("actions", [])
	for frame in int(scenario.frames):
		for action in actions:
			if int(action.frame) == frame:
				_act(main, action)
		await physics_frame
		frames.append(_observe(main, frame))
	var error: String = main.last_error
	main.queue_free()
	await process_frame
	return {"error": error, "frames": frames}


func _act(main: Node, action: Dictionary) -> void:
	var events = main._run.events
	match str(action.do):
		"fire":
			events.fire(action.event.duplicate())
			events.flush()
		"effects":
			var context := {"room": main._run.room_id}
			var given = action.get("context", {})
			var room: Dictionary = main._run.current_room()
			for prop in room.get("props", []):
				if prop.id == given.get("prop"):
					context.prop = prop
			for spawn in room.get("spawns", []):
				if spawn.id == given.get("spawn"):
					context.spawn = spawn
			events.run_effects(action.effects, context)
			events.flush()
		"hurt":
			var enemy = main._fx.enemy_for(str(action.spawn))
			if enemy != null:
				enemy.take_hit(int(action.get("damage", 1)), Vector2.ZERO)
		"place":
			main._run._place(main._player, Vector2(float(action.x), float(action.y)), Vector2.ZERO)


func _observe(main: Node, frame: int) -> Dictionary:
	var state: Dictionary = main.run_state()
	var looks := {}
	for child in main._world.get_children():
		if child is CharacterBody2D and child.look != null:
			var d: Dictionary = child.look.describe()
			d.rigScale = child._rig.scale.y if child._rig != null else (child._box.scale.y if child._box != null else 1.0)
			looks[child.spawn_id] = d
	if main._props != null and is_instance_valid(main._props):
		for id in main._props._props:
			var view = main._props._views[id]
			if view.look != null:
				var d: Dictionary = view.look.describe()
				var drawn: Node2D = view.object if view.object != null else view.body
				d.rigScale = drawn.scale.y
				looks["prop:" + id] = d
	return {
		"frame": frame,
		"entities": state.entities.map(func(e): return {"spawnId": e.spawnId, "state": e.behaviorState, "look": e.look, "dissolved": e.dissolved, "health": e.health}),
		"props": state.props.map(func(p): return {"id": p.id, "look": p.look, "dissolved": p.dissolved}),
		"playerLook": state.playerLook, "playerDissolved": state.playerDissolved, "emitters": state.emitters,
		"zoom": state.camera.zoom if state.camera != null else 0.0,
		"flags": state.flags, "items": state.items,
		"looks": looks,
	}
