extends Area


signal network_node_updated

const material_default: SpatialMaterial = preload("res://assets/theme/ColorDefault.tres")
const material_selected: SpatialMaterial = preload("res://assets/theme/ColorSelected.tres")
const material_active: SpatialMaterial = preload("res://assets/theme/ColorActive.tres")

var is_staged: bool = true
var is_dragging: bool = false
var previous_position: Vector3

var COLLISION_RADIUS_DEFAULT: float = 0.25
var COLLISION_RADIUS_DRAGGING: float = 8.0
var COLLISION_RADIUS_HEIGHT: float = 0.1


func _ready():
	$CollisionShape.shape = CylinderShape.new()
	$CollisionShape.shape.radius = COLLISION_RADIUS_DEFAULT
	$CollisionShape.shape.height = COLLISION_RADIUS_HEIGHT


func _update():
	if is_staged:
		$CollisionShape.disabled = true
	else:
		$CollisionShape.disabled = false

	if is_dragging:
		$Puck.set_surface_material(0, material_active)

	emit_signal("network_node_updated")


func _on_NetworkNode_mouse_entered():
	$Puck.set_surface_material(0, material_selected)
	_update()


func _on_NetworkNode_mouse_exited():
	$Puck.set_surface_material(0, material_default)
	_update()


func _on_NetworkNode_input_event(_camera:Node, event:InputEvent, position:Vector3, _normal:Vector3, _shape_idx:int):
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
