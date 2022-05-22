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
var network_node_origin: Area
var network_node_destination: Area
var network_node_selected: Area


func _ready():
	toolbar.connect("set_is_building", self, "set_is_building")
	toolbar.connect("set_is_editing", self, "set_is_editing")


func set_is_building(state: bool):
	is_building = state

	if !is_building:
		remove_staged_network_way()


func set_is_editing(state: bool):
	is_editing = state

	if network_nodes_container.get_child_count() > 0:
		for node in network_nodes_container.get_children():
			node.is_editable = state
			node._update()


func _on_Map_input_event(_camera:Node, event:InputEvent, position:Vector3, _normal:Vector3, _shape_idx:int):
	if is_building:
		if network_node_origin == null:
			add_network_node_origin(position)

		elif network_node_origin.is_staged:
			move_network_node(network_node_origin, position)

			if event is InputEventMouseButton and event.button_index == BUTTON_LEFT:
				commit_network_node(network_node_origin, position)
				add_network_node_destination(position)
				add_network_way()

		elif network_node_destination.is_staged:
			move_network_node(network_node_destination, position)
			move_network_way()

			if event is InputEventMouseButton and event.button_index == BUTTON_LEFT:
				if is_click_debounced(position):
					commit_network_node(network_node_destination, position)
					commit_network_way()


func move_network_node(node: Area, position: Vector3):
	node.transform.origin = position


func commit_network_node(node: Area, position: Vector3):
	if is_click_debounced(position):
		node.transform.origin = position
		node.is_staged = false
		node._update()


func add_network_node_origin(position):
	network_node_origin = network_node_scene.instance()
	network_node_origin.transform.origin = position
	network_node_origin.is_staged = true
	network_nodes_container.add_child(network_node_origin)


func add_network_node_destination(position):
	network_node_destination = network_node_scene.instance()
	network_node_destination.transform.origin = position
	network_node_destination.is_staged = true
	network_nodes_container.add_child(network_node_destination)


func remove_staged_network_way():
	if network_node_origin != null:
		network_node_origin.queue_free()

	if network_way != null and network_way.is_staged:
		network_node_destination.queue_free()
		network_way.queue_free()

	reset_network_variables()


func reset_network_variables():
	network_node_origin = null
	network_node_destination = null
	network_way = null


func get_last_network_node():
	return network_nodes_container.get_child(network_nodes_container.get_child_count() - 1)


func add_network_way():
	network_way = network_way_scene.instance()
	network_way.add_network_node(network_node_origin.get_instance_id())
	network_way.add_network_node(network_node_destination.get_instance_id())
	network_ways_container.add_child(network_way)


func move_network_way():
	network_way._update()


func commit_network_way():
	network_way.is_staged = false
	reset_network_variables()


func is_click_debounced(clicked_position):
	var last_clicked_position: Vector3
	if last_clicked_position == Vector3.ZERO || last_clicked_position != clicked_position:
		return true
	else:
		last_clicked_position = clicked_position
		return false

