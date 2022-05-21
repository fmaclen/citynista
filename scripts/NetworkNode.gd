extends Area


signal network_node_active(id)

var is_staged: bool = true
var is_selected: bool = true

const material_default: SpatialMaterial = preload("res://assets/theme/ColorDefault.tres")
const material_active: SpatialMaterial = preload("res://assets/theme/ColorActive.tres")


func _update():
	if is_staged:
		$CollisionShape.disabled = true
	else:
		$CollisionShape.disabled = false


func _on_NetworkNode_mouse_entered():
	$Puck.set_surface_material(0, material_active)
	emit_signal("network_node_active", true)
	_update()


func _on_NetworkNode_mouse_exited():
	$Puck.set_surface_material(0, material_default)
	emit_signal("network_node_active", false)
	_update()

