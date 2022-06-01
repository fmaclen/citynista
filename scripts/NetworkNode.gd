extends Area


signal network_node_updated
signal network_node_snap_to
signal network_node_snapped_to

const material_default: SpatialMaterial = preload("res://assets/theme/ColorDefault.tres")
const material_selected: SpatialMaterial = preload("res://assets/theme/ColorSelected.tres")
const material_staged: SpatialMaterial = preload("res://assets/theme/ColorStaged.tres")
const material_removable: SpatialMaterial = preload("res://assets/theme/ColorRemovable.tres")

var is_staged: bool = false
var is_editable: bool = false
var is_dragging: bool = false
var is_snappable: bool = false
var is_removable: bool = false
var previous_position: Vector3

const COLLISION_RADIUS_DEFAULT: float = 1.0
const COLLISION_RADIUS_DRAGGING: float = 8.0
const COLLISION_RADIUS_HEIGHT: float = 0.15


func _ready():
	$CollisionShape.shape = CylinderShape.new()
	$CollisionShape.shape.radius = COLLISION_RADIUS_DEFAULT
	$CollisionShape.shape.height = COLLISION_RADIUS_HEIGHT


func _update():
	if is_staged:
		$CollisionShape.disabled = true
		$Puck.set_surface_material(0, material_staged)
	else:
		$CollisionShape.disabled = false

	emit_signal("network_node_updated")


func _on_NetworkNode_mouse_entered():
	if is_editable or is_snappable:
		$Puck.set_surface_material(0, material_selected)

	if is_removable:
		$Puck.set_surface_material(0, material_removable)

	if is_snappable:
		emit_signal("network_node_snap_to", true, transform.origin)

	_update()


func _on_NetworkNode_mouse_exited():
	_update()

	if !is_staged:
		$Puck.set_surface_material(0, material_default)

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

	elif is_removable:
		if event.is_action_pressed("ui_left_click"):
			queue_free()


func remove_from_network_way():
	# If the NetworkNode is not connected to any NetworkWay, remove it completely.
	if get_signal_connection_list("network_node_updated").empty():
		queue_free()
