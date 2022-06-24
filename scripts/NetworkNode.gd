extends Area


signal network_node_updated
signal network_node_snap_to
signal network_node_snapped_to

const gizmo_draw_path_scene: PackedScene = preload("res://scenes/GizmoDrawPath.tscn")

const material_default: SpatialMaterial = preload("res://assets/theme/ColorDefault.tres")
const material_selected: SpatialMaterial = preload("res://assets/theme/ColorSelected.tres")
const material_staged: SpatialMaterial = preload("res://assets/theme/ColorStaged.tres")

var is_staged: bool = true
var is_editable: bool = false
var is_dragging: bool = false
var is_snappable: bool = false
var is_intersection_gizmo: bool = false
var is_hovering: bool = false
var previous_position: Vector3

const COLLISION_RADIUS_DEFAULT: float = 3.0
const COLLISION_RADIUS_DRAGGING: float = 8.0
const COLLISION_RADIUS_HEIGHT: float = 0.5


func _ready():
	$CollisionShape.shape = CylinderShape.new()
	$CollisionShape.shape.radius = COLLISION_RADIUS_DEFAULT
	$CollisionShape.shape.height = COLLISION_RADIUS_HEIGHT


func _update():
	$CollisionShape.disabled = is_staged
	update_material()
	get_lanes_from_network_ways()
	# new_gizmo_draw_path(Vector3.ZERO, Vector3(10,0,0))
	# new_gizmo_draw_path(Vector3(10,0,0), Vector3(10,0,10))
	# new_gizmo_draw_path(Vector3(10,0,10),Vector3(0,0,10))
	emit_signal("network_node_updated")


func _on_NetworkNode_mouse_entered():
	is_hovering = true
	_update()

	if is_snappable:
		emit_signal("network_node_snap_to", true, transform.origin)


func _on_NetworkNode_mouse_exited():
	is_hovering = false
	_update()

	if is_snappable:
		emit_signal("network_node_snap_to", false, transform.origin)


func _on_NetworkNode_input_event(_camera:Node, event:InputEvent, position:Vector3, _normal:Vector3, _shape_idx:int):
	if is_editable:
		# The Y value from the mouse position is different from the NetworkNode's Y
		# value so we combine both values into a new adjusted position.
		var adjusted_position = Vector3(position.x, translation.y, position.z)

		if event.is_action_pressed("ui_left_click"):
			is_dragging = true
			$CollisionShape.shape.radius = COLLISION_RADIUS_DRAGGING
			previous_position = adjusted_position

		if !is_dragging:
			return

		if event.is_action_released("ui_left_click"):
			previous_position = Vector3.ZERO
			is_dragging = false
			$CollisionShape.shape.radius = COLLISION_RADIUS_DEFAULT

		if is_dragging and event is InputEventMouseMotion:
			translation += adjusted_position - previous_position
			previous_position = adjusted_position
			_update()

	elif is_snappable:
		if event.is_action_pressed("ui_left_click"):
			emit_signal("network_node_snapped_to")


func update_material():
	if is_editable and is_hovering:
		$Puck.set_surface_material(0, material_selected)
	elif is_staged:
		$Puck.set_surface_material(0, material_staged)
	else:
		$Puck.set_surface_material(0, material_default)


func remove_from_network_way():
	# If the NetworkNode is not connected to any NetworkWay, remove it completely.
	if get_signal_connection_list("network_node_updated").empty():
		queue_free()


func get_lanes_from_network_ways():
	var network_ways = []

	for network_way_connected_to in get_signal_connection_list("network_node_updated"):
		network_ways.append(network_way_connected_to.target)

	# No need to connect NetworkWays when there is only one
	if network_ways.size() < 2:
		return

	# Clear existing paths
	for gizmo in $PathConnections.get_children():
		gizmo.queue_free()

	var lane_connections_type_1 = []
	var lane_connections_type_2 = []

	for network_way in network_ways:
		var network_way_lane_connections = network_way.get_connection_points(transform.origin)
		for network_way_lane_connection in network_way_lane_connections:

			if network_way_lane_connection["lane_type"] == 0:
				for connection in network_way_lane_connection["connections"]:
					lane_connections_type_1.append(connection)
			elif network_way_lane_connection["lane_type"] == 1:
				for connection in network_way_lane_connection["connections"]:
					lane_connections_type_2.append(connection)

	var index: int = 0
	for connection_a in lane_connections_type_1:
		index = index + 1

		if index <= lane_connections_type_1.size() - 1:
			for connection_b in lane_connections_type_1.slice(index,lane_connections_type_1.size()):
				new_gizmo_draw_path(connection_a, connection_b)


func new_gizmo_draw_path(point_a: Vector3, point_b: Vector3):
	var gizmo_draw_path = gizmo_draw_path_scene.instance()
	gizmo_draw_path.point_a = point_a
	gizmo_draw_path.point_b = point_b
	gizmo_draw_path._update()
	$PathConnections.add_child(gizmo_draw_path)














