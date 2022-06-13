extends MeshInstance


const material_road: SpatialMaterial = preload("res://assets/theme/ColorGround.tres")
const material_sidewalk: SpatialMaterial = preload("res://assets/theme/ColorStaged.tres")

enum lane_types { ROAD, SIDEWALK }

var point_a: Vector3
var point_b: Vector3
var width: float
var height: float
var length: float
var lane_type: int


func _ready():
	pass

func _update():
	mesh = CubeMesh.new()


	match(lane_type):
		lane_types.ROAD:
			width = 3.0
			height = 0.1
			mesh.material = material_road

		lane_types.SIDEWALK:
			width = 1.5
			height = 0.2
			mesh.material = material_sidewalk

	translation = point_a.linear_interpolate(point_b, 0.5)
	look_at_from_position(translation, point_a, point_b)

	length = point_a.distance_to(point_b)
	mesh.size = Vector3(height, width, length)
