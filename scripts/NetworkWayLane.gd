extends MeshInstance


var type: int
var width: float
var height: float
var material: Material
var point_a: Vector3
var point_b: Vector3


func init(lane_index: int):
	$Path.curve = Curve3D.new()

	var lane = Lane.atlas[lane_index]
	type = lane["type"]
	width = lane["width"]
	height = lane["height"]
	material = lane["material"]


func _update():
	$Path.curve.clear_points()
	$Path.curve.add_point(point_a)
	$Path.curve.add_point(point_b)

	var polygon: PoolVector2Array = []
	polygon.empty()
	polygon.append(Vector2(0, 0))
	polygon.append(Vector2(0, width))
	polygon.append(Vector2(height, width))
	polygon.append(Vector2(height, 0))

	$CSGPolygon.polygon = polygon
	$CSGPolygon.material_override = material
