extends RefCounted
## Connects characters to their art: builds the RigView for a character's
## appearance and picks which clip plays. Mirrors ACTION_CLIP_SLOTS in
## packages/core/src/art/clip.ts.

const RigView := preload("res://scripts/art/rig_view.gd")

const ACTION_CLIP_SLOTS := {
	"strike": ["attack"],
	"shoot": ["attack"],
	"leap": ["jump"],
	"slam": ["attack"],
	"summon": ["windup"],
	"teleport": ["idle"],
	"patrol": ["walk", "run"],
	"wait": ["idle"],
	"chase": ["run", "walk"],
	"charge": ["attack", "run"],
	"telegraph": ["windup"],
	"retreat": ["walk", "run"],
	"returnHome": ["walk"],
	"jump": ["jump"],
	"hover": ["fly"],
}


## The character's art asset, or {} when it is drawn as a box.
static func asset_for(character: Dictionary, art: Variant) -> Dictionary:
	var asset_id = character.get("appearance")
	if asset_id == null or typeof(art) != TYPE_DICTIONARY:
		return {}
	for asset in art.get("assets", []):
		if typeof(asset) == TYPE_DICTIONARY and asset.get("id") == asset_id and typeof(asset.get("rig")) == TYPE_DICTIONARY:
			return asset
	return {}


## A RigView for the asset (not yet added to the tree).
static func make_view(asset: Dictionary, art: Dictionary) -> Node2D:
	var view = RigView.new()
	view.setup(asset.rig, art.get("direction", {}), asset.get("clips", {}))
	# Keep animating in edit mode, when the world itself is frozen.
	view.process_mode = Node.PROCESS_MODE_ALWAYS
	return view


## Attack actions: slots by phase (windup / active / recovery), tried before the action's own slots.
## Mirrors ACTION_PHASE_SLOTS in packages/core/src/art/clip.ts.
const ACTION_PHASE_SLOTS := {
	"strike": {"windup": ["windup"], "active": ["strike", "attack"], "recovery": ["recover", "idle"]},
	"shoot": {"windup": ["windup"], "active": ["shoot", "attack"], "recovery": ["recover", "idle"]},
	"leap": {"windup": ["windup"], "active": ["leap", "jump"], "recovery": ["recover", "idle"]},
	"slam": {"windup": ["windup"], "active": ["slam", "attack"], "recovery": ["recover", "idle"]},
	"summon": {"windup": ["cast", "windup"], "active": ["cast"], "recovery": ["recover", "idle"]},
	"teleport": {"windup": ["cast", "windup"], "active": ["cast"], "recovery": ["recover", "idle"]},
}


## First existing clip for a behavior state: explicit mapping, then the action's slots for its
## current phase (attacks), then the action's slots, then idle. Flyers use "fly" for moving actions.
static func clip_for_state(asset: Dictionary, view: Node2D, state_id: String, action_type: String, flying := false, phase := "") -> String:
	var mapped = asset.get("stateClips", {}).get(state_id)
	if mapped != null and view.has_clip(str(mapped)):
		return str(mapped)
	var slots: Array = []
	if phase != "":
		slots.append_array(ACTION_PHASE_SLOTS.get(action_type, {}).get(phase, []))
	for slot in ACTION_CLIP_SLOTS.get(action_type, []):
		if not slot in slots:
			slots.append(slot)
	if flying and ("walk" in slots or "run" in slots):
		slots = ["fly"] + slots
	return first_clip(view, slots)


static func first_clip(view: Node2D, slots: Array) -> String:
	for slot in slots:
		if view.has_clip(slot):
			return slot
	return "idle" if view.has_clip("idle") else ""
