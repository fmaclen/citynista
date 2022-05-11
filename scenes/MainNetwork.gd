extends Spatial


func add_child(child, legible = false):
	.add_child(child, legible)
	connect_network_nodes()


func connect_network_nodes():
	if get_child_count() > 3:
		var line = $DrawLine
		line.begin(Mesh.PRIMITIVE_LINE_STRIP)

		var intersections = get_children()
		intersections.erase(intersections[0])

		for intersection in intersections:
			line.add_vertex(intersection.transform.origin)
	
		line.end()

# TODO: replace DrawLine with a scene that has a path and a CSGMesh extruded
