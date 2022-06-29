extends MeshInstance


const material_removable: SpatialMaterial = preload("res://assets/theme/ColorRemovable.tres")

var is_removable: bool

var type: int
var width: float
var height: float
var material: Material
var point_a: Vector3
var point_b: Vector3
# var network_way_width: float


func init(lane_index: int):
	$Path.curve = Curve3D.new()

	var lane = Lane.atlas[lane_index]
	type = lane["type"]
	width = lane["width"]
	height = lane["height"]
	material = lane["material"]

	# Center lane in relation to the `$Path`
	translation.y = -width * Globals.HALF


func _update():
	$Path.curve.clear_points()
	$Path.curve.add_point(point_a)
	$Path.curve.add_point(point_b)

	var polygon_width: float = width * Globals.HALF
	var polygon_height: float = height * Globals.HALF
	var polygon: PoolVector2Array = []

	polygon.empty()
	polygon.append(Vector2(-polygon_height, -polygon_width))
	polygon.append(Vector2(-polygon_height, polygon_width))
	polygon.append(Vector2(polygon_height, polygon_width))
	polygon.append(Vector2(polygon_height, -polygon_width))


	$CSGPolygon.polygon = polygon

	if is_removable:
		$CSGPolygon.material_override = material_removable
	else:
		$CSGPolygon.material_override = material
