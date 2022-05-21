extends CollisionObject


onready var network: Node = $Network
onready var network_nodes: Node = network.get_child(0)
onready var network_ways: Node = network.get_child(1)

const network_node_scene: PackedScene = preload("res://scenes/NetworkNode.tscn")
const network_way_scene: PackedScene = preload("res://scenes/NetworkWay.tscn")

var is_building_mode: bool = false
var staged_network_way: Spatial
var network_node_origin: Area
var network_node_destination: Area


func _on_Button_set_is_building_mode(state):
	is_building_mode = state

	if !is_building_mode:
		remove_staged_network_node()


func _on_Map_input_event(_camera, event, click_position, _click_normal, _shape_idx):
	if is_building_mode:
		if network_node_origin == null:
			add_network_node_origin(click_position)

		elif network_node_origin.is_staged:
			move_network_node(network_node_origin, click_position)

			if event is InputEventMouseButton and event.button_index == BUTTON_LEFT:
				commit_network_node(network_node_origin, click_position)
				add_network_node_destination(click_position)
				add_network_way()

		elif network_node_destination.is_staged:
			move_network_node(network_node_destination, click_position)
			move_network_way()

			if event is InputEventMouseButton and event.button_index == BUTTON_LEFT:
				if is_click_debounced(click_position):
					commit_network_node(network_node_destination, click_position)
					commit_network_way()
					reset_network_node_positions()


func move_network_node(node: Area, position: Vector3):
	node.transform.origin = position


func commit_network_node(node: Area, position: Vector3):
	if is_click_debounced(position):
		node.transform.origin = position
		node.is_staged = false


func add_network_node_origin(position):
	network_node_origin = network_node_scene.instance()
	network_node_origin.transform.origin = position
	network_node_origin.is_staged = true
	network_nodes.add_child(network_node_origin)


func add_network_node_destination(position):
	network_node_destination = network_node_scene.instance()
	network_node_destination.transform.origin = position
	network_node_destination.is_staged = true
	network_nodes.add_child(network_node_destination)


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


func add_network_way():
	staged_network_way = network_way_scene.instance()
	staged_network_way.add_network_node(network_node_origin.get_instance_id())
	staged_network_way.add_network_node(network_node_destination.get_instance_id())
	network_ways.add_child(staged_network_way)


func move_network_way():
	staged_network_way.update_destination_node(network_node_destination.get_instance_id())


func commit_network_way():
	staged_network_way.is_staged = false
	staged_network_way = null


func is_click_debounced(clicked_position):
	var last_clicked_position: Vector3
	if last_clicked_position == Vector3.ZERO || last_clicked_position != clicked_position:
		return true
	else:
		last_clicked_position = clicked_position
		return false

