extends SceneTree
## Headless terrain probe (see game/test/terrain.test.ts):
##   godot --headless --fixed-fps 60 --path game --script res://tests/terrain_probe.gd -- in.json out.json
## in.json:  {"cases": [{"rows", "ledge"} | {"solids"} | {"project", "frames", "input", "textures": [ref...]}]}
## out.json: {"results": [terrain describe() | {"rows", "ledge", "origin"} | {"error", "before", "after", "dressed"}]}
## A grid case draws the rows; a solids case rebuilds a grid from them; a project case plays
## it with the given input and describes the active terrain (plain, or the dressed arena's)
## before and after.

const Terrain := preload("res://scripts/terrain.gd")


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var input = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	var results := []
	for case in input.cases:
		if case.has("rows"):
			var terrain: Node2D = Terrain.new()
			root.add_child(terrain)
			terrain.build(case.rows, int(case.ledge), {})
			results.append(terrain.describe())
			terrain.queue_free()
		elif case.has("solids"):
			var rebuilt: Dictionary = Terrain.rows_from_solids(case.solids)
			results.append({"rows": rebuilt.rows, "ledge": rebuilt.ledge, "origin": [rebuilt.origin.x, rebuilt.origin.y]})
		else:
			results.append(await _play(case))
	FileAccess.open(args[1], FileAccess.WRITE).store_string(JSON.stringify({"results": results}))
	quit()


func _play(case: Dictionary) -> Dictionary:
	var main: Node = load("res://main.tscn").instantiate()
	root.add_child(main)
	for ref in case.get("textures", []):
		var image := Image.create(64, 64, false, Image.FORMAT_RGBA8)
		image.fill(Color(0.5, 0.5, 0.5))
		main._textures[str(ref)] = ImageTexture.create_from_image(image)
	main.handle_message({"type": "load", "project": case.project})
	main.handle_message({"type": "play", "seed": 1})
	var before := _terrain(main)
	for frame in range(int(case.frames) + 1):
		for press in case.get("input", []):
			if frame == int(press.from) or frame == int(press.to):
				var event := InputEventAction.new()
				event.action = press.action
				event.pressed = frame == int(press.from)
				event.strength = 1.0 if event.pressed else 0.0
				Input.parse_input_event(event)
		await physics_frame
	for action in ["move_left", "move_right", "jump", "attack", "aim_up", "aim_down", "dash"]:
		Input.action_release(action)
	Input.flush_buffered_events()
	var out := {"error": main.last_error, "dressed": main._dressing_view != null, "before": before, "after": _terrain(main)}
	main.queue_free()
	await process_frame
	return out


func _terrain(main: Node) -> Dictionary:
	var view = main._dressing_view
	var terrain = view._terrain if view != null else main._world.get_node_or_null("Terrain")
	return terrain.describe() if terrain != null else {}
