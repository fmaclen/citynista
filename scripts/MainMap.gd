extends CollisionObject


onready var toolbar: Node = get_parent().get_node("GUI").get_node("Toolbar")

var is_building: bool = false
var is_editing: bool = false
var is_removing: bool = false

onready var gizmos: Node = $Network.get_node("Gizmos")
onready var network_nodes_container: Node = $Network.get_node("Nodes")
onready var network_ways_container: Node = $Network.get_node("Ways")

const network_node_scene: PackedScene = preload("res://scenes/NetworkNode.tscn")
const network_way_scene: PackedScene = preload("res://scenes/NetworkWay.tscn")
const gizmo_intersection_scene: PackedScene = preload("res://scenes/GizmoIntersection.tscn")

var network_node_a: Area
var network_node_b: Area
var network_node_snap_to: Area
var network_node_collision: Area

var network_way: Spatial
var network_way_collided: Area

var network_way_intersections: Array


# MainMap ----------------------------------------------------------------------


func _ready():
	toolbar.connect("set_is_building", self, "set_network_state", ["build"])
	toolbar.connect("set_is_editing", self, "set_network_state", ["edit"])
	toolbar.connect("set_is_removing", self, "set_network_state", ["remove"])


func set_network_state(state: bool, mode: String):
	match(mode):
		"build":
			is_building = state
			if !is_building:
				remove_staged_network_way()
		"edit":
			is_editing = state
		"remove":
			is_removing = state

	if network_nodes_container.get_child_count() > 0:
		for node in network_nodes_container.get_children():
			match(mode):
				"build":
					node.is_snappable = state
				"edit":
					node.is_editable = state
				"remove":
					node.is_removable = state
			node._update()

		for node in network_ways_container.get_children():
			match(mode):
				"build":
					node.is_snappable = state
			node._update()


func _on_Map_input_event(_camera:Node, event:InputEvent, position:Vector3, _normal:Vector3, _shape_idx:int):
	if is_building:
		if network_node_a == null:
			network_node_a = add_network_node(position)

		elif network_node_a.is_staged:
			move_network_node(network_node_a, position)

			if event.is_action_released("ui_left_click"):
				commit_network_node(network_node_a, position)
				network_node_b = add_network_node(position)
				network_way = add_network_way()
				update_network_way_nodes()

		elif network_node_b.is_staged:
			move_network_node(network_node_b, position)

			if event.is_action_released("ui_left_click"):
				commit_network_node(network_node_b, position)
				commit_network()


func snap_to_position(should_snap: bool, snap_position: Vector3):
	if should_snap:
		if network_node_a != null and network_node_a.is_staged:
			move_network_node(network_node_a, snap_position)
		if network_node_b != null and network_node_b.is_staged:
			move_network_node(network_node_b, snap_position)


func commit_network():
	update_network_way_nodes()
	commit_network_way()
	commit_network_way_intersections()
	reset_network_variables()
	reset_gizmos()


func reset_network_variables():
	network_node_a = null
	network_node_b = null
	network_node_snap_to = null
	network_way = null
	network_way_collided = null


func reset_gizmos():
	if gizmos.get_child_count() > 0:
		for gizmo in gizmos.get_children():
			gizmo.queue_free()


# NetworkNodes -----------------------------------------------------------------


func move_network_node(node: Area, position: Vector3):
	node.transform.origin = position
	if network_way != null:
		update_network_way_nodes()


func commit_network_node(node: Area, position: Vector3):
	node.transform.origin = position
	node.is_staged = false
	node._update()


func add_network_node(position: Vector3) -> Area:
	var network_node = network_node_scene.instance()
	network_nodes_container.add_child(network_node)

	network_node.connect("network_node_snap_to", self, "handle_snap_to_network_node")
	network_node.connect("network_node_snapped_to", self, "handle_snapped_to_network_node", [network_node])
	network_node.transform.origin = position
	network_node.is_staged = true
	network_node.is_snappable = false

	return network_node


func handle_snap_to_network_node(should_snap: bool, snap_position: Vector3):
	snap_to_position(should_snap, snap_position)

	# Show or hide the staged NetworkNode
	if should_snap:
		if network_node_a != null and network_node_a.is_staged:
			network_node_a.visible = false
		if network_node_b != null and network_node_b.is_staged:
			network_node_b.visible = false
	else:
		if network_node_a != null and network_node_a.is_staged:
			network_node_a.visible = true
		if network_node_b != null and network_node_b.is_staged:
			network_node_b.visible = true


func handle_snapped_to_network_node(node: Node):
	if network_node_a != null and network_node_a.is_staged:
		network_node_a.queue_free()
		network_node_a = node
		network_node_a.is_staged = false
		network_node_a.is_snappable = false
		network_node_b = add_network_node(network_node_a.transform.origin)
		network_way = add_network_way()

	elif network_node_b != null and network_node_b.is_staged:
		network_node_b.queue_free()
		network_node_b = node
		network_node_b.is_staged = false
		network_node_b.is_snappable = false
		commit_network()


# NetworkWays ------------------------------------------------------------------


func add_network_way() -> Area:
	var new_network_way = network_way_scene.instance()
	new_network_way.connect("network_way_snap_to", self, "snap_to_position")
	new_network_way.connect("network_way_snapped_to", self, "handle_snapped_to_network_way")
	network_ways_container.add_child(new_network_way)
	return new_network_way


func update_network_way_nodes():
	network_way.network_node_a = network_node_a
	network_way.network_node_b = network_node_b
	network_way._update()
	add_network_way_intersections()


func commit_network_way():
	network_way.is_staged = false
	network_way.is_snappable = true

	network_node_a.is_staged = false
	network_node_a.is_snappable = true
	network_node_a._update()

	network_node_b.is_staged = false
	network_node_b.is_snappable = true
	network_node_b._update()


func remove_staged_network_way():
	if network_node_a != null:
		network_node_a.queue_free()

	if network_way != null and network_way.is_staged:
		network_node_b.queue_free()
		network_way.queue_free()

	reset_network_variables()


func add_network_way_intersections():
	reset_gizmos()
	network_way_intersections = []
	
	for network_way_intersected in network_way.get_intersecting_network_ways():
		var intersected_way_node_a = network_way_intersected.network_node_a.transform.origin
		var intersected_way_node_b = network_way_intersected.network_node_b.transform.origin

		var intersects_at = Geometry.get_closest_points_between_segments(
			network_node_a.transform.origin,
			network_node_b.transform.origin,
			intersected_way_node_a,
			intersected_way_node_b
		)[0]

		if intersects_at != null:
			var gizmo = gizmo_intersection_scene.instance()
			gizmo.transform.origin = intersects_at
			gizmos.add_child(gizmo)
			network_way_intersections.append([intersects_at, network_way_intersected])


func commit_network_way_intersections():
	if network_way_intersections.empty():
		return

	network_way_intersections.sort_custom(self, "sort_network_way_intersections")

	for intersection in network_way_intersections:
		var intersected_at: Vector3 = intersection[0]
		var intersected_network_way: Area = intersection[1]

		if network_node_a.transform.origin == intersected_at:
			split_network_way(
				intersected_network_way,
				network_node_a
			)
		elif network_node_b.transform.origin == intersected_at:
			split_network_way(
				intersected_network_way,
				network_node_b
			)
		else:
			var new_network_node = add_network_node(intersected_at)
			split_network_way(
				network_way,
				new_network_node
			)
			split_network_way(
				intersected_network_way,
				new_network_node
			)


func sort_network_way_intersections(a: Array, b: Array):
	var network_node_a_position = network_node_a.transform.origin
	if a[0].distance_to(network_node_a_position) < b[0].distance_to(network_node_a_position):
		return true
	else:
		return false


func split_network_way(existing_network_way: Area, intersection_network_node: Area):
	var new_network_way = add_network_way()
	new_network_way.network_node_a = existing_network_way.network_node_a
	new_network_way.network_node_b = intersection_network_node
	new_network_way._update()

	existing_network_way.network_node_a = intersection_network_node
	existing_network_way.is_staged = false
	existing_network_way._update()
	
	# commit network node
	intersection_network_node.is_staged = false
	intersection_network_node.is_snappable = true
	intersection_network_node._update()


func handle_snapped_to_network_way(position: Vector3):
	if network_node_a != null and network_node_a.is_staged:
		network_node_a.name = "NoditoA"
		commit_network_node(network_node_a, position)
		network_node_b = add_network_node(position)
		network_way = add_network_way()
		update_network_way_nodes()

	elif network_node_b != null and network_node_b.is_staged:
		commit_network_node(network_node_b, position)
		network_node_b.name = "NoditoB"
		commit_network()
