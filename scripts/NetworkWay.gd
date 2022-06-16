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

var is_staged: bool = true
var is_snappable: bool = false
var is_hovering: bool = false
var is_removable: bool = false
var snap_points: PoolVector3Array = []
var snapped_point: Vector3
var collided_point: Vector3

const HALF: float = 0.5

const MAX_SNAPPING_DISTANCE: float = 1.5
const MAX_SNAPPING_LENGTH: int = 2

const COLLISION_SHAPE_HEIGHT: float = 0.1
const COLLISION_SHAPE_WIDTH: float = 1.0


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

	draw_line()
	update_material()
	update_collision_shape()
	generate_lanes()

	if is_snappable:
		add_snap_points()
		$Gizmos.visible = is_hovering


func draw_line():
	# Draw line between nodes
	var debug_line = $Draw3D
	debug_line.material_override = material_staged
	debug_line.clear()
	debug_line.begin(Mesh.PRIMITIVE_LINE_STRIP)

	var network_node_a_position = network_node_a_origin
	var network_node_b_position = network_node_b_origin

	debug_line.add_vertex(network_node_a_position)
	debug_line.add_vertex(network_node_b_position)

	$Path.curve.add_point(network_node_a_position)
	$Path.curve.add_point(network_node_b_position)

	debug_line.end()


func update_material():
	if is_staged:
		$Draw3D.material_override = material_staged
	elif is_hovering and is_removable:
		$Draw3D.material_override = material_removable
	else:
		$Draw3D.material_override = material_default


func update_collision_shape():
	if network_node_a_origin != network_node_b_origin:
		var shape_length = (network_nodes_distance * HALF) - (COLLISION_SHAPE_WIDTH)
		var current_position = lerp_network_nodes(HALF)

		$CollisionShape.shape = BoxShape.new()
		$CollisionShape.shape.extents = Vector3(COLLISION_SHAPE_HEIGHT, COLLISION_SHAPE_WIDTH, shape_length)
		$CollisionShape.look_at_from_position(current_position, network_node_a_origin, network_node_b_origin)


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

enum lane_types { ROAD, SIDEWALK }
const material_road: SpatialMaterial = preload("res://assets/theme/ColorGround.tres")
const material_sidewalk: SpatialMaterial = preload("res://assets/theme/ColorStaged.tres")

var lanes = [
	{
		"type": lane_types.ROAD,
		"width": 3.0,
		"height": 0.1,
		"material": material_road
	},
	{
		"type": lane_types.SIDEWALK,
		"width": 1.5,
		"height": 0.2,
		"material": material_sidewalk
	},
]


func generate_lanes():
	if network_node_a_origin == network_node_b_origin:
		return

	for lane in $Lanes.get_children():
		lane.queue_free()

	var offset: float = 0.0

	for lane in lanes:
		var new_network_way_lane = network_way_lane_scene.instance()

		new_network_way_lane.point_a = network_node_a_origin
		new_network_way_lane.point_b = network_node_b_origin
		new_network_way_lane.offset = offset
		new_network_way_lane.type = lane["type"]
		new_network_way_lane.width = lane["width"]
		new_network_way_lane.height = lane["height"]
		new_network_way_lane.mesh.material = lane["material"]

		new_network_way_lane._update()

		# Increase offset counter by —half— of the lane's width
		offset = offset + (lane["width"] * HALF)

		$Lanes.add_child(new_network_way_lane)

	# Orient all lanes between `network_node_a_origin` and `network_node_b_origin`
	var current_position = lerp_network_nodes(HALF)
	$Lanes.look_at_from_position(current_position, network_node_a_origin, network_node_b_origin)


func update_lanes():
	pass
