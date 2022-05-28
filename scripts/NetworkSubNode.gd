extends Area


const material_default: SpatialMaterial = preload("res://assets/theme/ColorDefault.tres")
# const material_selected: SpatialMaterial = preload("res://assets/theme/ColorSelected.tres")


func _ready():
	$Cube.set_surface_material(0, material_default)
	$CollisionShape.disabled = true
