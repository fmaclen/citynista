extends MeshInstance


func set_lane(point_a: Vector3, point_b: Vector3, lane: Dictionary):
	$Path.curve = Curve3D.new()
	$Path.curve.add_point(point_a)
	$Path.curve.add_point(point_b)

	var polygon: PoolVector2Array = []
	polygon.empty()
	polygon.append(Vector2(0, 0))
	polygon.append(Vector2(0, lane["width"]))
	polygon.append(Vector2(lane["height"], lane["width"]))
	polygon.append(Vector2(lane["height"], 0))

	$CSGPolygon.polygon = polygon
	$CSGPolygon.material_override = lane["material"]
