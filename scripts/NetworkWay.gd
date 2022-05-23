extends Node


var network_node_a_id: int
var network_node_b_id: int

var is_staged: bool = true


func _update():
	var network_node_a = instance_from_id(network_node_a_id)
	var network_node_b = instance_from_id(network_node_b_id)

	# Connect to signals
	network_node_a.connect("network_node_updated", self, "_update")
	network_node_b.connect("network_node_updated", self, "_update")

	network_node_a.connect("network_node_removed", self, "queue_free")
	network_node_b.connect("network_node_removed", self, "queue_free")

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


func remove():
	print("handle removal of NetworkWay")
