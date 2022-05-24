extends Node


const network_sub_node_scene: PackedScene = preload("res://scenes/NetworkSubNode.tscn")

var network_node_a_id: int
var network_node_a: Area
var network_node_b_id: int
var network_node_b: Area

var is_staged: bool = true


func _update():
	network_node_a = instance_from_id(network_node_a_id)
	network_node_b = instance_from_id(network_node_b_id)

	# Connect to signals
	if !network_node_a.is_connected("network_node_updated", self, "_update"):
		network_node_a.connect("network_node_updated", self, "_update")
		network_node_a.connect("tree_exited", self, "remove_network_way", [network_node_a])
	
	if !network_node_b.is_connected("network_node_updated", self, "_update"):
		network_node_b.connect("network_node_updated", self, "_update")
		network_node_b.connect("tree_exited", self, "remove_network_way", [network_node_b])

	draw_line()

	if !is_staged:
		add_network_sub_nodes()


func draw_line():
	# Draw line between nodes
	var debug_line = $Draw3D
	debug_line.clear()
	debug_line.begin(Mesh.PRIMITIVE_LINE_STRIP)

	var network_node_a_position = network_node_a.transform.origin
	var network_node_b_position = network_node_b.transform.origin

	debug_line.add_vertex(network_node_a_position)
	debug_line.add_vertex(network_node_b_position)

	$Path.curve.add_point(network_node_a_position)
	$Path.curve.add_point(network_node_b_position)

	debug_line.end()


func add_network_sub_nodes():
	var MAX_SEGMENT_LENGTH = 2

	# Clean up existing NetworkSubNodes
	for node in $NetworkSubNodes.get_children():
		node.queue_free()

	var total_distance = network_node_a.transform.origin.distance_to(network_node_b.transform.origin)
	var segment_count = int(total_distance / MAX_SEGMENT_LENGTH) - 1

	if segment_count > 0:
		var weight = 1.0 / float(segment_count) # Distance between the NetworkSubNodes
		var segment_weight = 0

		for segment in segment_count:
			segment_weight = segment_weight + weight

			var network_sub_node = network_sub_node_scene.instance()
			network_sub_node.transform.origin = network_node_a.transform.origin.linear_interpolate(network_node_b.transform.origin, segment_weight)
			$NetworkSubNodes.add_child(network_sub_node)


func remove_network_way(removed_node: Area):
	# Ignore if event was triggered by removing a staged NetworkNode
	if removed_node.is_staged:
		return

	# Check if the "other" NetworkNode is associated with another NetworkWay,
	# if not remove such NetworkNode.
	if network_node_a == removed_node:
		if network_node_b != null and network_node_b.get_signal_connection_list("network_node_updated").size() < 2:
			network_node_b.queue_free()

	if network_node_b == removed_node:
		if network_node_a != null and network_node_a.get_signal_connection_list("network_node_updated").size() < 2:
			network_node_a.queue_free()

	network_node_a = null
	network_node_b = null

	# Remove the NetworkWay after resetting any orphan NetworkNodes
	queue_free()

