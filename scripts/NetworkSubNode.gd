extends Area


signal network_sub_node_snap_to
signal network_sub_node_snapped

const material_default: SpatialMaterial = preload("res://assets/theme/ColorDefault.tres")
const material_selected: SpatialMaterial = preload("res://assets/theme/ColorSelected.tres")


func _ready():
	$Cube.set_surface_material(0, material_default)


func _on_NetworkSubNode_mouse_entered():
	$Cube.set_surface_material(0, material_selected)
	emit_signal("network_sub_node_snap_to", true)


func _on_NetworkSubNode_mouse_exited():
	emit_signal("network_sub_node_snap_to", false)
	$Cube.set_surface_material(0, material_default)


func _on_NetworkSubNode_input_event(_camera:Node, event:InputEvent, _position:Vector3, _normal:Vector3, _shape_idx:int):
	if event.is_action_pressed("ui_left_click"):
		emit_signal("network_sub_node_snapped")
