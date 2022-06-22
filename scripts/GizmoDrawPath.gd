extends Path

onready var debug_line = $Draw3D

var material: Material
var point_a: Vector3
var point_b: Vector3

func _update():
	curve.clear_points()
	curve.add_point(point_a)
	curve.add_point(point_b)

	debug_line.clear()
	debug_line.begin(Mesh.PRIMITIVE_LINE_STRIP)
	debug_line.material_override = material
	debug_line.add_vertex(point_a)
	debug_line.add_vertex(point_b)
	debug_line.end()
