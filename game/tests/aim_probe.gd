extends SceneTree
## Headless probe for game/test/aim.test.ts: does the drawn weapon follow a mouse aim? Plays the
## project, holds the cursor at `angle` degrees from the player (room space, y down), clicks at
## frame `press`, and reports every frame of the attack: the held weapon's direction and hand
## (weapon_view.gd), the player's centre and facing, and each projectile the frame it appears.
##   godot --headless --fixed-fps 60 --path game --script res://tests/aim_probe.gd -- in.json out.json
## in.json: {"project", "angle", "press", "frames"}

const WeaponProjectile := preload("res://scripts/combat/weapon_projectile.gd")

var _mouse := Vector2.ZERO


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var input = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	var main: Node = load("res://main.tscn").instantiate()
	root.add_child(main)
	main.handle_message({"type": "load", "project": input.project})
	main.handle_message({"type": "play", "seed": 1})
	var seen := {}
	var out := {"error": "", "frames": []}
	for frame in int(input.frames):
		var player: Node = main._player
		var point: Vector2 = player.center() + Vector2.from_angle(deg_to_rad(float(input.angle))) * 160.0
		_mouse = root.get_final_transform() * (main.get_viewport().get_canvas_transform() * point)
		var motion := InputEventMouseMotion.new()
		motion.position = _mouse
		Input.parse_input_event(motion)
		if frame == int(input.press) or frame == int(input.press) + 2:
			var click := InputEventMouseButton.new()
			click.button_index = MOUSE_BUTTON_LEFT
			click.pressed = frame == int(input.press)
			click.position = _mouse
			Input.parse_input_event(click)
		await physics_frame
		# Read once the frame's physics and its process (the rig posing, the weapon following) ran.
		await process_frame
		await create_timer(0.0).timeout
		var view: Node2D = player._weapon_view
		var shots := []
		for child in main._world.get_children():
			if child is WeaponProjectile and not seen.has(child.get_instance_id()):
				seen[child.get_instance_id()] = true
				shots.append({"x": child.position.x, "y": child.position.y, "vx": child.velocity.x, "vy": child.velocity.y})
		var pointing: Vector2 = view.pointing_global()
		var hand: Vector2 = view.grip_global()
		out.frames.append({
			"state": player.behavior_state,
			"phase": player.phase,
			"facing": player.facing_sign(),
			"centre": [player.center().x, player.center().y],
			"hand": [hand.x, hand.y],
			"pointing": [pointing.x, pointing.y],
			"tip": [(hand + pointing * view._length).x, (hand + pointing * view._length).y],
			"shots": shots,
		})
	out.error = main.last_error
	FileAccess.open(args[1], FileAccess.WRITE).store_string(JSON.stringify(out))
	main.queue_free()
	quit()
