extends StaticBody


onready var toolbar: Node = get_parent().get_node("GUI").get_node("Toolbar")

onready var network_nodes_container: Node = $Network.get_node("Nodes")
onready var network_ways_container: Node = $Network.get_node("Ways")

const network_node_scene: PackedScene = preload("res://scenes/NetworkNode.tscn")
const network_way_scene: PackedScene = preload("res://scenes/NetworkWay.tscn")

var is_building: bool = false
var is_editing: bool = false
var is_removing: bool = false

var current_network_node_a: Area
var current_network_node_b: Area
var current_network_way: Area
var existing_network_node_snapped_to: Area



# World ------------------------------------------------------------------------


func _ready():
	toolbar.connect("set_is_building", self, "set_world_state", ["build"])
	toolbar.connect("set_is_editing", self, "set_world_state", ["edit"])
	toolbar.connect("set_is_removing", self, "set_world_state", ["remove"])


func set_world_state(state: bool, mode: String):
	match(mode):
		"build":
			is_building = state

		"edit":
			is_editing = state

		"remove":
			is_removing = state


func _on_World_input_event(_camera: Node, event: InputEvent, position: Vector3, _normal: Vector3, _shape_idx: int):
	if !is_building:
		return

	if !current_network_node_a:
		current_network_node_a = add_network_node(position)

	if current_network_node_a and current_network_node_a.is_staged:
		move_network_node(current_network_node_a, position)

	elif current_network_node_b and current_network_node_b.is_staged:
		move_network_node(current_network_node_b, position)
		update_current_network_way()

	if event.is_action_released("ui_left_click"):
		if current_network_node_a.is_staged:
			commit_current_network_node_a()
			current_network_node_b = add_network_node(position)
			add_current_network_way()

		else:
			commit_current_network_node_b()
			commit_current_network_way()
			continue_network_way_from_network_node_b(position)


func snap_to_position(should_snap: bool, snap_position: Vector3):
	if should_snap:
		if current_network_node_a and current_network_node_a.is_staged:
			move_network_node(current_network_node_a, snap_position)
		else:
			move_network_node(current_network_node_b, snap_position)

		update_current_network_way()


# NetworkNodes -----------------------------------------------------------------


func add_network_node(position: Vector3) -> Area:
	var new_network_node = network_node_scene.instance()
	new_network_node.connect("network_node_snap_to", self, "snap_to_position")
	new_network_node.connect("network_node_snapped_to", self, "handle_snapped_to_network_node", [new_network_node])
	new_network_node.transform.origin = position
	network_nodes_container.add_child(new_network_node)
	return new_network_node


func commit_current_network_node_a():
	current_network_node_a.is_staged = false
	current_network_node_a.is_snappable = true


func commit_current_network_node_b():
	current_network_node_b.is_staged = false
	current_network_node_b.is_snappable = true


func handle_snapped_to_network_node(node: Area):
	if current_network_node_a.is_staged:
		current_network_node_a.queue_free()
		current_network_node_a = node
	else:
		current_network_node_b.queue_free()
		current_network_node_b = node

	update_current_network_way()


func move_network_node(node: Node, position: Vector3):
	node.transform.origin = position


func continue_network_way_from_network_node_b(position: Vector3):
	current_network_node_a = current_network_node_b
	current_network_node_b = add_network_node(position)
	add_current_network_way()


# NetworkWays ------------------------------------------------------------------


func add_network_way() -> Area:
	var new_network_way = network_way_scene.instance()
	new_network_way.connect("network_way_snap_to", self, "snap_to_position")
	# new_network_way.connect("network_way_snapped_to", self, "handle_snapped_to_network_way")
	network_ways_container.add_child(new_network_way)
	return new_network_way


func add_current_network_way():
	current_network_way = add_network_way()
	update_current_network_way()


func update_current_network_way():
	if current_network_way:
		current_network_way.network_node_a = current_network_node_a
		current_network_way.network_node_b = current_network_node_b
		current_network_way._update()


func commit_current_network_way():
	current_network_way.network_node_b = current_network_node_b
	current_network_way.is_staged = false
	current_network_way.is_snappable = true
	update_current_network_way()
