extends SceneTree
## Headless probe for game/test/animation.test.ts (animation in play: object props, playAnimation,
## spawnEffect, markers, projectile looks, the object stage). Plays each scenario's world and, at
## given frames, fires events or runs effects directly (as a handler would); every frame it reports
## what the runtime state says about animation plus what each object view and rig is showing.
##   godot --headless --fixed-fps 60 --path game --script res://tests/animation_probe.gd -- in.json out.json
## in.json:  {"scenarios": [{"project", "world"?, "frames", "actions": [action], "stage"?}]}
##   action: {"frame", "do": "fire", "event"} | {"frame", "do": "effects", "effects", "context"?: {prop?, spawn?}}
##           | {"frame", "do": "place", "x", "y"} (the player, standing still)
##   stage: a `stage` message's stage, applied (edit mode) instead of playing; reports the stage view.
## out.json: {"results": [{"error", "frames": [frame], "markers": [{name, from}], "stage"?}]}

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
		for i in 5:
			await process_frame
		var view = main._stage_view
		var rig = view._rig if view != null else null
		var stage := {"state": main.run_state().stage, "built": rig != null, "clip": rig.current_clip() if rig != null else "", "time": rig.clip_time() if rig != null else 0.0, "bones": rig.show_bones if rig != null else false}
		var error: String = main.last_error
		main.queue_free()
		await process_frame
		return {"error": error, "frames": [], "markers": [], "stage": stage}
	main.handle_message({"type": "play", "seed": 1, "world": scenario.get("world")})
	var frames := []
	var actions: Array = scenario.get("actions", [])
	for frame in int(scenario.frames):
		for action in actions:
			if int(action.frame) == frame:
				_act(main, action)
		await physics_frame
		frames.append(_observe(main, frame))
	var markers: Array = main._run.events.markers.duplicate()
	var error: String = main.last_error
	main.queue_free()
	await process_frame
	return {"error": error, "frames": frames, "markers": markers}


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
		"place":
			main._run._place(main._player, Vector2(float(action.x), float(action.y)), Vector2.ZERO)


func _observe(main: Node, frame: int) -> Dictionary:
	var state: Dictionary = main.run_state()
	var views := {}
	if main._props != null and is_instance_valid(main._props):
		for id in main._props._props:
			var object = main._props.object_of(id)
			if object != null:
				views[id] = {"clip": object.current_clip(), "time": object.clip_time(), "held": object.held(), "scale": object.scale.x}
	var rigs := {}
	for child in main._world.get_children():
		if child is CharacterBody2D and child._rig != null:
			rigs[child.spawn_id] = {"clip": child._rig.current_clip(), "time": child._rig.clip_time()}
	var centers := {}
	for child in main._world.get_children():
		if child is CharacterBody2D:
			var c: Vector2 = child.center()
			centers[child.spawn_id] = [c.x, c.y]
	return {
		"frame": frame,
		"props": state.props, "playerPlaying": state.playerPlaying, "effects": state.effects,
		"markers": state.markers.size(), "projectiles": state.projectiles, "flags": state.flags,
		"entities": state.entities.map(func(e): return {"spawnId": e.spawnId, "playing": e.playing, "state": e.behaviorState, "phase": e.phase}),
		"health": main._player.health if main._player != null else -1,
		"shake": main._fx.state().shake,
		"views": views, "rigs": rigs, "centers": centers,
	}
