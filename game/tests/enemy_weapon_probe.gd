extends SceneTree
## Headless probe for game/test/enemyWeapon.test.ts: plays the project and reports, every frame, the
## first enemy's centre, whether it is hidden (teleporting), and its held weapon (weapon_view.gd):
## which weapon, whether it is shown and where it is held.
##   godot --headless --fixed-fps 60 --path game --script res://tests/enemy_weapon_probe.gd -- in.json out.json
## in.json: {"project", "frames"}


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var input = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	var main: Node = load("res://main.tscn").instantiate()
	root.add_child(main)
	main.handle_message({"type": "load", "project": input.project})
	main.handle_message({"type": "play", "seed": 1})
	var out := {"error": "", "frames": []}
	for frame in int(input.frames):
		await process_frame
		var enemies: Array = main._player.enemies if main._player != null else []
		if enemies.is_empty():
			out.frames.append({"enemy": false})
			continue
		var enemy: Node = enemies[0]
		var view: Node = enemy._weapon_view
		var c: Vector2 = enemy.center()
		var hold: Vector2 = view._hold.origin
		out.frames.append({
			"enemy": true,
			"center": [c.x, c.y],
			"hidden": bool(enemy._hidden),
			"weapon": str(view._weapon.get("id", "")),
			"shown": bool(view.visible),
			"hold": [hold.x, hold.y],
		})
	FileAccess.open(args[1], FileAccess.WRITE).store_string(JSON.stringify(out))
	quit()
