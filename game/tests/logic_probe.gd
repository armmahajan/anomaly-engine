extends SceneTree
## Headless game-logic probe (see game/test/logic.test.ts): plays a world run,
## lets it settle, then drives the run's logic directly, step by step in one
## frame (no physics in between), and reports the run's memory after each step.
##   godot --headless --fixed-fps 60 --path game --script res://tests/logic_probe.gd -- in.json out.json
## in.json:  {"scenarios": [{"project", "world", "settle": frames, "steps": [step]}]}
##   step: {"do": "fire", "event"} | {"do": "touch"|"interact"|"hit", "prop"} | {"do": "kill", "spawn"}
##         | {"do": "die"} | {"do": "timer", "timer"} | {"do": "press", "button"} | {"do": "door", "door"}
##         | {"do": "continue"}
## out.json: {"results": [{"error", "states": [{room, visited, flags, items, abilities, checkpoint, modals, saved}]}]}

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
	main.handle_message({"type": "play", "seed": 1, "world": scenario.world})
	for i in int(scenario.get("settle", 10)):
		await physics_frame
	var run: Node = main._run
	var states := [_state(main)]
	for step in scenario.steps:
		match str(step.do):
			"fire":
				run.events.fire(step.event.duplicate())
				run.events.flush()
			"touch", "interact":
				run.events.fire({"type": step.do, "prop": step.prop})
				run.events.flush()
			"hit":
				main._props.strike(main._props._props[step.prop], Vector2.RIGHT)
				run.events.flush()
				if main._props._dying.has(step.prop):
					main._props._destroy(step.prop)  # what its deferred call does after the frame's events
			"kill":
				for child in main._world.get_children():
					if child is CharacterBody2D and "spawn_id" in child and child.spawn_id == step.spawn:
						child.take_hit(9999, Vector2.RIGHT)
				run.events.flush()
			"die":
				run.on_player_died()
			"timer":
				if run.events.timers.has(step.timer):
					run.events.timers[step.timer] = 0.0
					run.events.tick(0.0)
				run.events.flush()
			"press":
				main._modals._press(int(step.button))
			"door":
				for door in run.current_room().doors:
					if door.id == step.door:
						run._go_through(main._player, door, Vector2.ZERO)
				run.events.flush()
			"continue":
				var resume: Dictionary = scenario.world.duplicate()
				resume["continue"] = true
				run.start(main._project, resume)
		states.append(_state(main))
	var error: String = main.last_error
	main.queue_free()
	await process_frame
	return {"error": error, "states": states}


func _state(main: Node) -> Dictionary:
	var run: Node = main._run
	var screen: Dictionary = main._modals.describe()
	var modals := []
	if screen.modal != null:
		modals.append(screen.modal.id)
	modals.append_array(screen.queued)
	var flags: Array = run.events.flags.keys()
	flags.sort()
	var saved = WorldRuntime._memory_store.get(run._save_key)
	return {
		"room": run.room_id, "visited": run.visited.duplicate(), "flags": flags, "items": run.events.items.duplicate(),
		"abilities": run.abilities.duplicate(), "checkpoint": run.events.checkpoint if not run.events.checkpoint.is_empty() else null,
		"modals": modals, "saved": JSON.parse_string(saved) if saved != null else null,
	}
