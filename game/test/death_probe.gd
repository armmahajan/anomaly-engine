extends SceneTree
## Headless probe for game/test/death.test.ts: an enemy's death, frame by frame (what run_state()
## doesn't report: its clip, fade, the burst, whether it still hurts).
##   godot --headless --fixed-fps 60 --path game --script res://test/death_probe.gd -- in.json out.json
## in.json: {"project", "spawn", "frames", "attackAt"?: frame the player swings (press 2 frames),
##           "touchAt"?: frame the player is put onto the enemy, "respawnAt"?: frame the room is rebuilt}


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var input = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	var main: Node = load("res://main.tscn").instantiate()
	root.add_child(main)
	main.handle_message({"type": "load", "project": input.project})
	main.handle_message({"type": "play", "seed": 1})
	await physics_frame
	var out := {"error": main.last_error, "frames": [], "hasRig": false}
	for frame in int(input.frames):
		var enemy := _find(main, str(input.spawn))
		if frame == 0:
			out.hasRig = enemy != null and enemy._rig != null
		if frame == int(input.get("attackAt", -1)):
			_send_action("attack", true)
		if frame == int(input.get("attackAt", -1)) + 2:
			_send_action("attack", false)
		if frame == int(input.get("touchAt", -1)) and enemy != null:
			main._run._place(main._player, enemy.position, Vector2.ZERO)
		if frame == int(input.get("respawnAt", -1)):
			main._run.respawn("entry")
		await physics_frame
		enemy = _find(main, str(input.spawn))
		var rig: Node2D = enemy._rig if enemy != null else null
		var bursts := 0
		var corpses := 0
		for child in main._world.get_children():
			if "_parts" in child:
				bursts += 1
			if child is CharacterBody2D and "dead" in child and child.dead and child.visible:
				corpses += 1
		out.frames.append({
			"frame": frame,
			"dead": enemy.dead,
			"gone": enemy.gone,
			"visible": enemy.visible,
			"processing": enemy.is_physics_processing(),
			"alpha": enemy.modulate.a,
			"clip": rig.current_clip() if rig != null else "",
			"scaleY": rig.scale.y if rig != null else (enemy._fallback_pose()[0].y if enemy.dead else 1.0),
			"layer": enemy.collision_layer,
			"health": enemy.health,
			"playerHealth": main._player.health,
			"killed": main._run.events.flags.has("down"),
			"bursts": bursts,
			"corpses": corpses,
		})
	Input.action_release("attack")
	FileAccess.open(args[1], FileAccess.WRITE).store_string(JSON.stringify(out))
	main.queue_free()
	quit()


func _find(main: Node, spawn: String) -> Node:
	for child in main._world.get_children():
		if child is CharacterBody2D and "spawn_id" in child and child.spawn_id == spawn:
			return child
	return null


func _send_action(action: String, pressed: bool) -> void:
	var event := InputEventAction.new()
	event.action = action
	event.pressed = pressed
	event.strength = 1.0 if pressed else 0.0
	Input.parse_input_event(event)
