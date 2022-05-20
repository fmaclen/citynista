extends CollisionObject


onready var network: Node = $Network
onready var network_nodes: Node = network.get_child(0)
onready var network_ways: Node = network.get_child(1)

const network_node_scene: Resource = preload("res://scenes/NetworkNode.tscn")
const network_way_scene: Resource = preload("res://scenes/NetworkWay.tscn")

var is_building_mode: bool = false
var network_node_origin: Area
var network_node_destination: Area


func _on_Button_set_is_building_mode(state):
	is_building_mode = state

	if !is_building_mode:
		remove_staged_network_node()


func _on_Map_input_event(_camera, event, click_position, _click_normal, _shape_idx):
	if is_building_mode:
		if network_node_origin == null:
			add_new_staged_network_node(click_position)

		elif network_node_origin.is_staged:
			move_network_node(network_node_origin, click_position)
			if event is InputEventMouseButton and event.button_index == BUTTON_LEFT:
				commit_network_node(network_node_origin, click_position)

		elif network_node_destination.is_staged:
			move_network_node(network_node_destination, click_position)
			if event is InputEventMouseButton and event.button_index == BUTTON_LEFT:
				commit_network_node(network_node_destination, click_position)
				add_new_network_way(network_node_origin, network_node_destination)
				reset_network_node_positions()


func move_network_node(node: Area, position: Vector3):
	node.transform.origin = position


func commit_network_node(node: Area, position: Vector3):
	if is_click_debounced(position):
		node.transform.origin = position
		node.is_staged = false
		add_new_staged_network_node(position)


func add_new_staged_network_node(position):
	var network_node = network_node_scene.instance()
	network_node.transform.origin = position
	network_node.is_staged = true
	network_nodes.add_child(network_node)

	if network_node_origin == null:
		network_node_origin = get_last_network_node()
	else:
		network_node_destination = get_last_network_node()


func remove_staged_network_node():
	var last_network_node = get_last_network_node()
	if last_network_node.is_staged:
		last_network_node.queue_free()
		reset_network_node_positions()


func reset_network_node_positions():
	network_node_origin = null
	network_node_destination = null


func get_last_network_node():
	return network_nodes.get_child(network_nodes.get_child_count() - 1)


func add_new_network_way(origin: Area, destination: Area):
	var network_way = network_way_scene.instance()
	network_way.add_network_node(origin.get_instance_id())
	network_way.add_network_node(destination.get_instance_id())
	network_ways.add_child(network_way)


func is_click_debounced(clicked_position):
	var last_clicked_position: Vector3
	if last_clicked_position == Vector3.ZERO || last_clicked_position != clicked_position:
		return true
	else:
		last_clicked_position = clicked_position
		return false

