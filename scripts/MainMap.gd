extends CollisionObject


onready var toolbar: Node = get_parent().get_node("GUI").get_node("Toolbar")

var is_building: bool = false
var is_editing: bool = false

onready var network: Node = $Network
onready var network_nodes_container: Node = network.get_child(0)
onready var network_ways_container: Node = network.get_child(1)

const network_node_scene: PackedScene = preload("res://scenes/NetworkNode.tscn")
const network_way_scene: PackedScene = preload("res://scenes/NetworkWay.tscn")

var network_way: Spatial
var network_node_a: Area
var network_node_b: Area
var network_node_snap_to: Area


func _ready():
	toolbar.connect("set_is_building", self, "set_network_state", ["build"])
	toolbar.connect("set_is_editing", self, "set_network_state", ["edit"])


func set_network_state(state: bool, mode: String):
	match(mode):
		"build":
			is_building = state
			if !is_building:
				remove_staged_network_way()
		"edit":
			is_editing = state

	if network_nodes_container.get_child_count() > 0:
		for node in network_nodes_container.get_children():
			match(mode):
				"build":
					node.is_snappable = state
				"edit":
					node.is_editable = state
			node._update()


func move_network_node(node: Area, position: Vector3):
	node.transform.origin = position
	if network_way != null:
		update_network_way()


func commit_network_node(node: Area, position: Vector3):
	node.transform.origin = position
	node.is_staged = false
	node._update()


func add_network_node(position) -> Node:
	var node = network_node_scene.instance()

	node.connect("network_node_snap_to", self, "handle_network_node_snap_to", [node])
	node.connect("network_node_snapped", self, "handle_network_node_snapped", [node])

	node.transform.origin = position
	node.is_staged = true
	node.is_snappable = false

	network_nodes_container.add_child(node)

	return node


func handle_network_node_snap_to(node_is_snappable: bool, node: Node):
	if node_is_snappable:
		if network_node_a != null and network_node_a.is_staged:
			network_node_a.visible = false
			move_network_node(network_node_a, node.transform.origin)

		if network_node_b != null and network_node_b.is_staged:
			network_node_b.visible = false
			move_network_node(network_node_b, node.transform.origin)

	else:
		if network_node_a != null and network_node_a.is_staged:
			network_node_a.visible = true

		if network_node_b != null and network_node_b.is_staged:
			network_node_b.visible = true


func handle_network_node_snapped(node: Node):
	if network_node_a != null and network_node_a.is_staged:
		network_node_a.queue_free()
		network_node_a = node
		network_node_a.is_staged = false
		network_node_a.is_snappable = false
		network_node_b = add_network_node(network_node_a.transform.origin)
		add_network_way()
	elif network_node_b != null and network_node_b.is_staged:
		network_node_b.queue_free()
		network_node_b = node
		network_node_b.is_staged = false
		network_node_b.is_snappable = false
		commit_network_way()


func remove_staged_network_way():
	if network_node_a != null:
		network_node_a.queue_free()

	if network_way != null and network_way.is_staged:
		network_node_b.queue_free()
		network_way.queue_free()

	reset_network_variables()


func reset_network_variables():
	network_node_a = null
	network_node_b = null
	network_node_snap_to = null
	network_way = null


func add_network_way():
	network_way = network_way_scene.instance()
	network_ways_container.add_child(network_way)
	update_network_way()


func update_network_way():
	network_way.network_node_a_id = network_node_a.get_instance_id()
	network_way.network_node_b_id = network_node_b.get_instance_id()
	network_way._update()


func commit_network_way():
	network_way.is_staged = false
	network_node_a.is_snappable = true
	network_node_b.is_snappable = true
	update_network_way()
	reset_network_variables()


func _on_Map_input_event(_camera:Node, event:InputEvent, position:Vector3, _normal:Vector3, _shape_idx:int):
	if is_building:
		if network_node_a == null:
			network_node_a = add_network_node(position)

		elif network_node_a.is_staged:
			move_network_node(network_node_a, position)

			if event.is_action_released("ui_left_click"):
				commit_network_node(network_node_a, position)
				network_node_b = add_network_node(position)
				add_network_way()

		elif network_node_b.is_staged:
			move_network_node(network_node_b, position)

			if event.is_action_released("ui_left_click"):
				commit_network_node(network_node_b, position)
				commit_network_way()
