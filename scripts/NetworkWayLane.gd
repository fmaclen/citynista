extends MeshInstance


func set_lane(point_a: Vector3, point_b: Vector3, lane: Dictionary):
	# Draw line between nodes
	var debug_line = $Draw3D
	debug_line.clear()
	debug_line.begin(Mesh.PRIMITIVE_LINE_STRIP)
	debug_line.add_vertex(point_a)
	debug_line.add_vertex(point_b)
	debug_line.material_override = lane["material"]
	debug_line.end()

	$Path.curve = Curve3D.new()
	$Path.curve.add_point(point_a)
	$Path.curve.add_point(point_b)
	
	# FIXME: the lanes are oriented the wrong way, not sure why.
	var polygon: PoolVector2Array = []
	polygon.empty()
	polygon.append(Vector2(0, 0))
	polygon.append(Vector2(0, lane["height"]))
	polygon.append(Vector2(lane["width"], lane["height"]))
	polygon.append(Vector2(lane["width"], 0))

	$CSGPolygon.polygon = polygon
	$CSGPolygon.material_override = lane["material"]
