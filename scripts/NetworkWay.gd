extends Area


signal network_way_sub_node_snap_to
signal network_way_collided

const network_sub_node_scene: PackedScene = preload("res://scenes/NetworkSubNode.tscn")

var network_node_a_id: int
var network_node_a: Area
var network_node_a_origin: Vector3
var network_node_b_id: int
var network_node_b: Area
var network_node_b_origin: Vector3
var network_nodes_distance: float

var is_staged: bool = true
var is_snappable: bool = false
var is_hovering: bool = false
var is_hovering_sub_node: bool = false


func _update():
	network_node_a = instance_from_id(network_node_a_id)
	network_node_b = instance_from_id(network_node_b_id)

	network_node_a_origin = network_node_a.transform.origin
	network_node_b_origin = network_node_b.transform.origin
	network_nodes_distance = network_node_a_origin.distance_to(network_node_b_origin)

	# Connect to signals
	if !network_node_a.is_connected("network_node_updated", self, "_update"):
		network_node_a.connect("network_node_updated", self, "_update")
		network_node_a.connect("tree_exited", self, "remove_network_way", [network_node_a])
	
	if !network_node_b.is_connected("network_node_updated", self, "_update"):
		network_node_b.connect("network_node_updated", self, "_update")
		network_node_b.connect("tree_exited", self, "remove_network_way", [network_node_b])

	draw_line()
	
	if !is_staged:
		set_collision_shape()

	if is_snappable:
		if $NetworkSubNodes.get_child_count() == 0:
			add_network_sub_nodes()
	else:
		remove_network_sub_nodes()

	if is_hovering:
		$NetworkSubNodes.visible = true
	else:
		$NetworkSubNodes.visible = false


func draw_line():
	# Draw line between nodes
	var debug_line = $Draw3D
	debug_line.clear()
	debug_line.begin(Mesh.PRIMITIVE_LINE_STRIP)

	var network_node_a_position = network_node_a_origin
	var network_node_b_position = network_node_b_origin

	debug_line.add_vertex(network_node_a_position)
	debug_line.add_vertex(network_node_b_position)

	$Path.curve.add_point(network_node_a_position)
	$Path.curve.add_point(network_node_b_position)

	debug_line.end()


func set_collision_shape():
	var collision_position = lerp_network_nodes(0.5)
	$CollisionShape.shape = BoxShape.new()
	$CollisionShape.look_at_from_position(collision_position, network_node_a_origin, network_node_b_origin)
	$CollisionShape.shape.extents = Vector3(0.1, 1.0, network_nodes_distance * 0.5)


func add_network_sub_nodes():
	var MAX_SEGMENT_LENGTH = 2

	var segment_count = int(network_nodes_distance / MAX_SEGMENT_LENGTH) # Ignore the first and last segments

	if segment_count > 0:
		var weight = 1.0 / float(segment_count) # Distance between the NetworkSubNodes
		var segment_weight = 0
		var segment_index = 0

		for segment in segment_count:
			# No no need to create the last NetworkSubNode
			if segment_index == segment_count - 1:
				break

			segment_index += 1
			segment_weight = segment_weight + weight

			var network_sub_node = network_sub_node_scene.instance()
			network_sub_node.transform.origin = lerp_network_nodes(segment_weight)
			network_sub_node.connect("network_sub_node_snap_to", self, "handle_network_sub_node_snap_to", [network_sub_node])
			network_sub_node.connect("network_sub_node_snapped", self, "handle_network_sub_node_snapped", [network_sub_node])
			network_sub_node.look_at_from_position(network_sub_node.transform.origin, network_node_a_origin, network_node_b_origin)
			$NetworkSubNodes.add_child(network_sub_node)


func handle_network_sub_node_snap_to(state: bool, node: Area):
	is_hovering_sub_node = state
	emit_signal("network_way_sub_node_snap_to", state, node)
	_update()


func handle_network_sub_node_snapped(network_sub_node_snapped: Area):
	emit_signal("network_way_collided", network_sub_node_snapped.transform.origin)


func remove_network_sub_nodes():
	for network_sub_node in $NetworkSubNodes.get_children():
		network_sub_node.queue_free()


func lerp_network_nodes(weight: float):
	return network_node_a_origin.linear_interpolate(network_node_b_origin, weight)


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


func _on_NetworkWay_mouse_entered():
	is_hovering = true
	_update()

func _on_NetworkWay_mouse_exited():
	if !is_hovering_sub_node:
		is_hovering = false
	_update()
