extends Node

class_name Intersection

var puck = MeshInstance.new()
var puck_mesh = CylinderMesh.new()
var puck_material = SpatialMaterial.new()

func _init():
	puck_material.albedo_color = Color.cyan
	puck_mesh.material = puck_material
	puck_mesh.top_radius = 0.25
	puck_mesh.bottom_radius = 0.25
	puck_mesh.height = 0.125
	puck.mesh = puck_mesh
	puck.translation.y = 0.05
