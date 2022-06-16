extends MeshInstance


var point_a: Vector3
var point_b: Vector3
var width: float
var height: float
var length: float
var type: int
var offset: float = 0.0


func _init():
	mesh = CubeMesh.new()
	visible = false


func _update():
	# Offsets the lane by the aggregate half-widths of all lanes before it
	translation.y = translation.y + offset

	# Set the length of the lane
	length = point_a.distance_to(point_b)
	mesh.size = Vector3(height, width, length)

	visible = true
