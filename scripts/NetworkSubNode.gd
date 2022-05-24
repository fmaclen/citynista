extends Area


signal network_node_snap_to
signal network_node_snapped

const material_default: SpatialMaterial = preload("res://assets/theme/ColorDefault.tres")
const material_selected: SpatialMaterial = preload("res://assets/theme/ColorSelected.tres")

var is_snappable: bool = false


func _ready():
	$Cube.set_surface_material(0, material_default)


func _on_NetworkNode_mouse_entered():
	if is_snappable:
		$Cube.set_surface_material(0, material_selected)
		emit_signal("network_node_snap_to", true)


func _on_NetworkNode_mouse_exited():
	if is_snappable or is_snappable:
		emit_signal("network_node_snap_to", false)

	$Cube.set_surface_material(0, material_default)


func _on_NetworkNode_input_event(_camera:Node, event:InputEvent, position:Vector3, _normal:Vector3, _shape_idx:int):
	if is_snappable:
		if event.is_action_pressed("ui_left_click"):
			emit_signal("network_node_snapped")
