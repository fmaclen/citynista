extends Area


signal network_way_snap_to(should_snap, snap_position)
signal network_way_snapped_to(collision_point)

const gizmo_snap_to: PackedScene = preload("res://scenes/GizmoSnapTo.tscn")
const network_way_lane_scene: PackedScene = preload("res://scenes/NetworkWayLane.tscn")

const material_default: SpatialMaterial = preload("res://assets/theme/ColorDefault.tres")
const material_staged: SpatialMaterial = preload("res://assets/theme/ColorStaged.tres")
const material_removable: SpatialMaterial = preload("res://assets/theme/ColorRemovable.tres")

var network_node_a: Area
var network_node_a_origin: Vector3
var network_node_b: Area
var network_node_b_origin: Vector3
var network_nodes_distance: float

var width: float
var is_staged: bool = true
var is_snappable: bool = false
var is_hovering: bool = false
var is_removable: bool = false
var snap_points: PoolVector3Array = []
var snapped_point: Vector3
var collided_point: Vector3

const HALF: float = 0.5
const MAX_SNAPPING_DISTANCE: float = 5.0
const MAX_SNAPPING_LENGTH: int = 5
const COLLISION_SHAPE_HEIGHT: float = 0.5


func _on_NetworkWay_mouse_entered():
	is_hovering = true
	_update()


func _on_NetworkWay_mouse_exited():
	is_hovering = false
	_update()


func _on_NetworkWay_input_event(_camera:Node, event:InputEvent, position:Vector3, _normal:Vector3, _shape_idx:int):
	_update()

	if !is_hovering:
		return

	if event is InputEventMouse:
		if is_snappable:
			for snap_point in snap_points:
				if position.distance_to(snap_point) < MAX_SNAPPING_DISTANCE:
					snapped_point = snap_point
					emit_signal("network_way_snap_to", true, snap_point)
					break
				else:
					snapped_point = Vector3.ZERO
					emit_signal("network_way_snap_to", false, position)

	if event.is_action_pressed("ui_left_click"):
		if is_snappable:
			if snapped_point != Vector3.ZERO:
				emit_signal("network_way_snapped_to")

		elif is_removable:
			remove_network_way()


func _update():
	network_node_a_origin = network_node_a.transform.origin
	network_node_b_origin = network_node_b.transform.origin
	network_nodes_distance = network_node_a_origin.distance_to(network_node_b_origin)

	# Connect to signals (if not's not already connected)
	if !network_node_a.is_connected("network_node_updated", self, "_update"):
		network_node_a.connect("network_node_updated", self, "_update")
	
	if !network_node_b.is_connected("network_node_updated", self, "_update"):
		network_node_b.connect("network_node_updated", self, "_update")

	# draw_line()
	# update_material()
	generate_lanes()
	generate_collision_shape()

	if is_snappable:
		add_snap_points()
		$Gizmos.visible = is_hovering


# NOTE: the line is rendered underneath the lanes so it's not visible.
# If we don't use it in the next few feature implementations we should remove it.
#
# func draw_line():
# 	# Draw line between nodes
# 	var debug_line = $Draw3D
# 	debug_line.material_override = material_staged
# 	debug_line.clear()
# 	debug_line.begin(Mesh.PRIMITIVE_LINE_STRIP)
#
# 	var network_node_a_position = network_node_a_origin
# 	var network_node_b_position = network_node_b_origin
#
# 	debug_line.add_vertex(network_node_a_position)
# 	debug_line.add_vertex(network_node_b_position)
#
# 	$Path.curve.add_point(network_node_a_position)
# 	$Path.curve.add_point(network_node_b_position)
#
# 	debug_line.end()


# FIXME: instead of changing the material of the Draw3D we might want to change
# the material of all the `$Lanes`.
#
# func update_material():
# 	if is_staged:
# 		$Draw3D.material_override = material_staged
# 	elif is_hovering and is_removable:
# 		$Draw3D.material_override = material_removable
# 	else:
# 		$Draw3D.material_override = material_default


func generate_collision_shape():
	if network_node_a_origin != network_node_b_origin:
		var shape_width = width * HALF
		var shape_length = (network_nodes_distance * HALF) - shape_width
		var middle_point = lerp_network_nodes(HALF)

		$CollisionShape.shape = BoxShape.new()
		$CollisionShape.shape.extents = Vector3(COLLISION_SHAPE_HEIGHT, shape_width, shape_length)
		$CollisionShape.look_at_from_position(middle_point, network_node_a_origin, network_node_b_origin)


func get_intersecting_network_ways() -> Array:
	# HACK: resetting the position re-calculates the overlapping collisions
	# It appears as if this is fixed in Godot 3.5.
	# https://www.reddit.com/r/godot/comments/v2km8v/sorting_an_array_of_vector3s_between_2_known/
	transform.origin = Vector3.ZERO

	var intersecting_network_ways: Array = []

	for node in get_overlapping_areas():
		if node.get_parent().name == "Ways":
			intersecting_network_ways.append(node)

	return intersecting_network_ways


func add_snap_points():
	remove_snap_points()

	var snap_point_count = int(network_nodes_distance / MAX_SNAPPING_LENGTH) # Ignore the first and last segments

	if snap_point_count > 0:
		var weight = 1.0 / float(snap_point_count) # Distance between the NetworkNodes
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

			var gizmo = gizmo_snap_to.instance()
			gizmo.transform.origin = snap_point
			gizmo.look_at_from_position(gizmo.transform.origin, network_node_a_origin, network_node_b_origin)
			$Gizmos.add_child(gizmo)


func remove_snap_points():
	snap_points = []

	for gizmo in $Gizmos.get_children():
		gizmo.queue_free()


func lerp_network_nodes(weight: float):
	return network_node_a_origin.linear_interpolate(network_node_b_origin, weight)


func remove_network_way():
	network_node_a.disconnect("network_node_updated", self, "_update")
	network_node_a.remove_from_network_way()

	network_node_b.disconnect("network_node_updated", self, "_update")
	network_node_b.remove_from_network_way()

	queue_free()


# NetworkWayLanes

var lane_points_a = []
var lane_points_b = []

var lanes = [
	Lane.LaneType.SIDEWALK,
	Lane.LaneType.ROAD,
	Lane.LaneType.ROAD,
	Lane.LaneType.SIDEWALK
]

func generate_lanes():
	# FIXME: maybe it doesn't have to create and destroy the lanes every time,
	# only update `point_a` and `point_b`


	if network_node_a_origin == network_node_b_origin:
		return

	reset_network_way_lanes()
	set_network_way_width(lanes)

	var lane_offset = 0.0
	for lane in lanes:
		var lane_length = (network_nodes_distance * HALF) - (width * HALF)
		var point_a = Vector3(0.0, lane_offset, -lane_length)
		var point_b = Vector3(0.0, lane_offset, lane_length)

		# Gather all lane path points
		lane_points_a.append(point_a)
		lane_points_b.append(point_b)
		
		# Create NetworkWayLane
		var new_network_way_lane = network_way_lane_scene.instance()
		new_network_way_lane.init(point_a, point_b, lane)
		$Lanes.add_child(new_network_way_lane)

		# Increase offset counter by the lane's width
		lane_offset = lane_offset + new_network_way_lane.width

	# Center lanes in relation to the NetworkWay
	for lane in $Lanes.get_children():
		lane.translation.y = -lane_offset * HALF

	# Orient all lanes between `network_node_a_origin` and `network_node_b_origin`
	var middle_point = lerp_network_nodes(HALF)
	$Lanes.look_at_from_position(middle_point, network_node_a_origin, network_node_b_origin)

	# Force `$Lanes.rotation.z to always be negative, otherwise the lanes will be
	# generated upside down.
	$Lanes.rotation.z = -abs($Lanes.rotation.z)


func reset_network_way_lanes():
	# Reset existing lanes
	for lane in $Lanes.get_children():
		lane.queue_free()

	# Reset existing NetworkWay width
	width = 0.0

	# Clear existing lane points
	lane_points_a.clear()
	lane_points_b.clear()


func set_network_way_width(lane_types: Array):
	for lane_type in lane_types:
		width = width + Lane.atlas[lane_type]["width"]

# NOT GOOD
# func get_closest_lane_points(network_node_position: Vector3) -> Array:
# 	if network_node_position == network_node_a_origin:
# 		return lane_points_a
# 	else:
# 		return lane_points_b.invert() # MAYBE


# func get_lane_points_by_type(network_node_position: Vector3, lane_type: int) -> Array:
# 	var lane_points = []

# 	for lane in $Lanes.get_children():
# 		if lane.type == lane_type:
# 			if network_node_position == network_node_a_origin:
# 				lane_points.append(lane.point_a)
# 			else:
# 				lane_points.append(lane.point_b)

# 	return lane_points


func get_connection_points(network_node_position: Vector3) -> Array:
	var connection_points = []
	var unique_lane_types = []

	for lane_type in lanes:
		if !unique_lane_types.has(lane_type):
			unique_lane_types.append(lane_type)

	for lane_type in unique_lane_types:
		var lane_connections = []

		for lane in $Lanes.get_children():
			if lane.type == lane_type:
				if network_node_position == network_node_a_origin:
					lane_connections.append(lane.point_a)
				else:
					lane_connections.append(lane.point_b)

		connection_points.append({
			"lane_type": lane_type,
			"connections": lane_connections
		})

	print("children", $Lanes.get_children().size())
	print("........")
	return connection_points # FIXME: this is returning more connnection points than it should
