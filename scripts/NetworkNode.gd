extends Area


var is_staged: bool = true
const material_default: SpatialMaterial = preload("res://assets/theme/ColorDefault.tres")
const material_active: SpatialMaterial = preload("res://assets/theme/ColorActive.tres")


func _process(_delta):
	if is_staged:
		$CollisionShape.disabled = true
	else:
		$CollisionShape.disabled = false


func _on_NetworkNode_mouse_entered():
	$Puck.set_surface_material(0, material_active)


func _on_NetworkNode_mouse_exited():
	$Puck.set_surface_material(0, material_default)

