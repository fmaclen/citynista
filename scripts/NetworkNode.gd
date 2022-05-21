extends Area


signal network_node_updated

const material_default: SpatialMaterial = preload("res://assets/theme/ColorDefault.tres")
const material_active: SpatialMaterial = preload("res://assets/theme/ColorActive.tres")

var is_staged: bool = true
var is_dragging: bool = false
var previous_position: Vector3 = Vector3.ZERO


func _update():
	if is_staged:
		$CollisionShape.disabled = true
	else:
		$CollisionShape.disabled = false

	emit_signal("network_node_updated")


func _on_NetworkNode_mouse_entered(): # HOVER IN
	$Puck.set_surface_material(0, material_active)
	_update()


func _on_NetworkNode_mouse_exited(): # HOVER OUT
	$Puck.set_surface_material(0, material_default)
	_update()


func _on_NetworkNode_input_event(_camera:Node, event:InputEvent, position:Vector3, _normal:Vector3, _shape_idx:int):
	if event.is_action_pressed("ui_left_click"):
		is_dragging = true
		previous_position = position

	if !is_dragging:
		return

	if event.is_action_released("ui_left_click"):
		previous_position = Vector3.ZERO
		is_dragging = false

	if is_dragging and event is InputEventMouseMotion:
		translation += position - previous_position
		previous_position = position
		_update()
