extends Node


var network_node_ids: PoolIntArray
var is_staged: bool = true


func add_network_node(id: int):
	network_node_ids.append(id)
	instance_from_id(id).connect("network_node_changed", self, "_update")
	instance_from_id(id).connect("network_node_removed", self, "remove_network_node")
	_update()


func remove_network_node(id: int):
	if network_node_ids.size() == 2:
		for id in network_node_ids:
			instance_from_id(id).queue_free()
			queue_free()

	else:
		var network_node_index = Array(network_node_ids).find_last(id)
		network_node_ids.remove(network_node_index)


func _update():
	if network_node_ids.size() != 2:
		return

	var debug_line = $Draw3D
	var waypoints: PoolVector3Array = []

	for id in network_node_ids:
		waypoints.append(instance_from_id(id).transform.origin)

	debug_line.clear()
	debug_line.begin(Mesh.PRIMITIVE_LINE_STRIP)

	for waypoint in waypoints:
		$Path.curve.add_point(waypoint)
		debug_line.add_vertex(waypoint)

	debug_line.end()

	
