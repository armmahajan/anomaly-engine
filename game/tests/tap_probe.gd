extends SceneTree
## Headless probe for game/test/tap.test.ts: a move key tapped between two frames (pressed and released
## before the next physics frame) still turns and moves the player. Plays the project, waits `settle`
## frames, then taps move_left once and reports the player's x and facing before and after.
##   godot --headless --fixed-fps 60 --path game --script res://tests/tap_probe.gd -- in.json out.json
## in.json: {"project", "settle"}


func _initialize() -> void:
	_run.call_deferred()


func _key(action: String, pressed: bool) -> void:
	var event := InputEventAction.new()
	event.action = action
	event.pressed = pressed
	Input.parse_input_event(event)


func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var input = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	var main: Node = load("res://main.tscn").instantiate()
	root.add_child(main)
	main.handle_message({"type": "load", "project": input.project})
	main.handle_message({"type": "play", "seed": 1})
	for i in int(input.settle):
		await physics_frame
	var player: Node = main._player
	var before := {"x": player.center().x, "facing": player.facing_sign()}
	# Down and up before the next frame reads the keys.
	_key("move_left", true)
	_key("move_left", false)
	for i in 3:
		await physics_frame
	var after := {"x": player.center().x, "facing": player.facing_sign()}
	var file := FileAccess.open(args[1], FileAccess.WRITE)
	file.store_string(JSON.stringify({"before": before, "after": after}))
	file.close()
	quit()
