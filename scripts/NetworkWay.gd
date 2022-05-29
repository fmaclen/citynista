extends Area


signal network_way_snap_to(snap_position)
signal network_way_collided(collision_point)

const network_sub_node_scene: PackedScene = preload("res://scenes/NetworkSubNode.tscn")

var network_node_a: Area
var network_node_a_origin: Vector3
var network_node_b: Area
var network_node_b_origin: Vector3
var network_nodes_distance: float

var is_staged: bool = true
var is_snappable: bool = false
var is_hovering: bool = false
var snap_points: PoolVector3Array = []
var snapped_point: Vector3
var collided_point: Vector3

var MAX_SNAPPING_DISTANCE = 1.0


func _on_NetworkWay_mouse_entered():
	is_hovering = true
	_update()


func _on_NetworkWay_mouse_exited():
	is_hovering = false
	_update()


func _on_NetworkWay_input_event(_camera:Node, event:InputEvent, position:Vector3, _normal:Vector3, _shape_idx:int):
	if !is_snappable:
		return

	if is_hovering and event is InputEventMouse:
		for snap_point in snap_points:
			if position.distance_to(snap_point) < MAX_SNAPPING_DISTANCE:
				snapped_point = snap_point
				emit_signal("network_way_snap_to", true, snap_point)
				break
			else:
				snapped_point = Vector3.ZERO
				emit_signal("network_way_snap_to", false, position)

	if event.is_action_pressed("ui_left_click"):
		if snapped_point != Vector3.ZERO:
			emit_signal("network_way_collided", snapped_point)


func _update():
	network_node_a_origin = network_node_a.transform.origin
	network_node_b_origin = network_node_b.transform.origin
	network_nodes_distance = network_node_a_origin.distance_to(network_node_b_origin)

	# Connect to signals (if not's not already connected)
	if !network_node_a.is_connected("network_node_updated", self, "_update"):
		network_node_a.connect("network_node_updated", self, "_update")
		network_node_a.connect("tree_exited", self, "remove_network_way", [network_node_a])
	
	if !network_node_b.is_connected("network_node_updated", self, "_update"):
		network_node_b.connect("network_node_updated", self, "_update")
		network_node_b.connect("tree_exited", self, "remove_network_way", [network_node_b])

	draw_line()
	update_collision_shape()

	if is_snappable:
		if $NetworkSubNodes.get_child_count() == 0:
			add_snap_points()
	else:
		remove_snap_points()

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


func update_collision_shape():
	if network_node_a_origin != network_node_b_origin:
		var collision_position = lerp_network_nodes(0.5)
		$CollisionShape.shape = BoxShape.new()
		$CollisionShape.shape.extents = Vector3(0.1, 1.0, (network_nodes_distance * 0.5) - 1.0)
		$CollisionShape.look_at_from_position(collision_position, network_node_a_origin, network_node_b_origin)


func add_snap_points():
	var MAX_SEGMENT_LENGTH = 2

	var snap_point_count = int(network_nodes_distance / MAX_SEGMENT_LENGTH) # Ignore the first and last segments

	if snap_point_count > 0:
		var weight = 1.0 / float(snap_point_count) # Distance between the NetworkSubNodes
		var segment_weight = 0
		var segment_index = 0

		for segment in snap_point_count:
			# No no need to create the last NetworkSubNode
			if segment_index == snap_point_count - 1:
				break

			segment_index += 1
			segment_weight = segment_weight + weight

			var snap_point = lerp_network_nodes(segment_weight)
			snap_points.append(snap_point)

			var network_sub_node = network_sub_node_scene.instance()
			network_sub_node.transform.origin = snap_point
			network_sub_node.look_at_from_position(network_sub_node.transform.origin, network_node_a_origin, network_node_b_origin)
			$NetworkSubNodes.add_child(network_sub_node)


func remove_snap_points():
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
	if removed_node == network_node_a:
		network_node_a = null

	if removed_node == network_node_b:
		network_node_b = null

	if network_node_a != null:
		network_node_a.disconnect("network_node_updated", self, "_update")
		network_node_a.remove_from_network_way()

	if network_node_b != null:
		network_node_b.disconnect("network_node_updated", self, "_update")
		network_node_b.remove_from_network_way()

	# Remove the NetworkWay after resetting any orphan NetworkNodes
	queue_free()
