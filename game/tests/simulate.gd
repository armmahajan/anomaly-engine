extends SceneTree
## Headless simulator for primitive tests (see game/test/*.test.ts):
##   godot --headless --fixed-fps 60 --path game --script res://tests/simulate.gd -- in.json out.json
## in.json:  {"scenarios": [{"project", "seed", "world"?, "frames", "samples": [frame...], "input": [{"action", "from", "to"}], "aim"?: [{"from", "to"?, "at"?: [x, y], "angle"?, "distance"?}]}]}
##            (`world`: start in the game world, as the play message's `world`; else the arena;
##            an input action may be a mouse button, "MouseLeft" / "MouseRight" / "MouseMiddle";
##            `aim` moves the cursor every frame from..to-1 to a room point or an angle from the player)
## out.json: {"results": [{"error", "samples": [{"frame", "deaths", "room", "entry", "visited", "entities", ...the rest of main.run_state()}]}]}


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var input = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	var results := []
	for scenario in input.scenarios:
		results.append(await _simulate(scenario))
	FileAccess.open(args[1], FileAccess.WRITE).store_string(JSON.stringify({"results": results}))
	quit()


func _simulate(scenario: Dictionary) -> Dictionary:
	var main: Node = load("res://main.tscn").instantiate()
	root.add_child(main)
	main.handle_message({"type": "load", "project": scenario.project})
	var play := {"type": "play", "seed": scenario.get("seed", 1)}
	if scenario.has("world"):
		play.world = scenario.world
	main.handle_message(play)
	var samples := []
	var wanted: Array = scenario.get("samples", [])
	for frame in range(int(scenario.frames) + 1):
		# The cursor first (a mouse button is pressed where it is).
		for aim in scenario.get("aim", []):
			if frame >= int(aim.from) and frame < int(aim.get("to", 1e9)):
				_move_mouse(main, aim)
		for press in scenario.get("input", []):
			if frame == int(press.from):
				_send_action(press.action, true)
			elif frame == int(press.to):
				_send_action(press.action, false)
		if float(frame) in wanted or frame in wanted:
			var run: Node = main._run
			var sample: Dictionary = main.run_state()
			sample.merge({
				"frame": frame,
				"room": run.room_id if run.active else null,
				"entry": [run.entry.x, run.entry.y] if run.active else null,
				"visited": run.visited.duplicate(),
				"facing": main._player.facing_sign() if main._player != null and is_instance_valid(main._player) else null,
			}, true)
			samples.append(sample)
		await physics_frame
	for action in ["move_left", "move_right", "jump", "attack", "alt_attack", "special_attack", "weapon_cycle", "aim_up", "aim_down", "dash", "interact", "map"]:
		Input.action_release(action)
	for button in MOUSE_BUTTONS.values():
		_send_button(button, false)
	Input.flush_buffered_events()
	var error: String = main.last_error
	main.queue_free()
	await process_frame
	return {"error": error, "samples": samples}


const MOUSE_BUTTONS := {"MouseLeft": MOUSE_BUTTON_LEFT, "MouseRight": MOUSE_BUTTON_RIGHT, "MouseMiddle": MOUSE_BUTTON_MIDDLE}
## Where the cursor is (window px), for button events.
var _mouse := Vector2.ZERO


## Move the cursor (a real mouse motion event, through the window) to a room point: `at` [x, y], or
## `angle` degrees from the player's centre (0 = right, 90 = down), `distance` px away (default 160).
func _move_mouse(main: Node, aim: Dictionary) -> void:
	var point := Vector2.ZERO
	if aim.has("at"):
		point = Vector2(float(aim.at[0]), float(aim.at[1]))
	elif main._player != null and is_instance_valid(main._player):
		point = main._player.center() + Vector2.from_angle(deg_to_rad(float(aim.angle))) * float(aim.get("distance", 160.0))
	var viewport: Viewport = main.get_viewport()
	_mouse = root.get_final_transform() * (viewport.get_canvas_transform() * point)
	var event := InputEventMouseMotion.new()
	event.position = _mouse
	event.global_position = _mouse
	Input.parse_input_event(event)


func _send_button(button: int, pressed: bool) -> void:
	var event := InputEventMouseButton.new()
	event.button_index = button
	event.pressed = pressed
	event.position = _mouse
	event.global_position = _mouse
	Input.parse_input_event(event)


## Like a key event from the browser: queued, and seen by the next physics frame as pressed and just pressed together.
## Mouse button names (MouseLeft...) send a button event at the cursor, which the input map turns into its actions.
func _send_action(action: String, pressed: bool) -> void:
	if MOUSE_BUTTONS.has(action):
		_send_button(MOUSE_BUTTONS[action], pressed)
		return
	var event := InputEventAction.new()
	event.action = action
	event.pressed = pressed
	event.strength = 1.0 if pressed else 0.0
	Input.parse_input_event(event)
