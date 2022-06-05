extends StaticBody


onready var toolbar: Node = get_parent().get_node("GUI").get_node("Toolbar")

onready var network_nodes_container: Node = $Network.get_node("Nodes")
onready var network_ways_container: Node = $Network.get_node("Ways")

const network_node_scene: PackedScene = preload("res://scenes/NetworkNode.tscn")
const network_way_scene: PackedScene = preload("res://scenes/NetworkWay.tscn")

var is_building: bool = false
var is_editing: bool = false
var is_removing: bool = false

var current_network_node_a: Area
var current_network_node_b: Area
var current_network_way: Area
var network_way_intersections: Array = []

var MIN_INTERSECTION_DISTANCE = 0.01


# World ------------------------------------------------------------------------


func _ready():
	toolbar.connect("set_is_building", self, "set_world_state", ["build"])
	toolbar.connect("set_is_editing", self, "set_world_state", ["edit"])
	toolbar.connect("set_is_removing", self, "set_world_state", ["remove"])


func set_world_state(state: bool, mode: String):
	match(mode):
		"build":
			is_building = state

			for node in network_ways_container.get_children():
				node.is_snappable = state
				node._update()

			if !is_building:
				stop_building()

		"edit":
			is_editing = state

			for node in network_nodes_container.get_children():
				node.is_editable = state
				node._update()

		"remove":
			is_removing = state

			for node in network_ways_container.get_children():
				node.is_removable = state
				node._update()


func _on_World_input_event(_camera: Node, event: InputEvent, position: Vector3, _normal: Vector3, _shape_idx: int):
	if !is_building:
		return

	move_current_network_node(position)

	if !current_network_node_a:
		current_network_node_a = add_network_node(position)

	if event.is_action_released("ui_left_click"):
		if current_network_node_a and !current_network_node_b:
			add_current_network_way()

		elif current_network_node_a and current_network_node_b:
			commit_current_network_way()
			continue_building()

	if event.is_action_released("ui_right_click"):
		stop_building()


func snap_to_position(should_snap: bool, snap_position: Vector3):
	if should_snap:
		move_current_network_node(snap_position)


func stop_building():
	remove_staged_nodes()
	reset_network_variables()
	reset_existing_network_node_intersections()


func continue_building():
	current_network_node_a = current_network_node_b
	add_current_network_way()


func remove_staged_nodes():
	for network_node in network_nodes_container.get_children():
		if network_node.is_staged:
			network_node.queue_free()

	for network_way in network_ways_container.get_children():
		if network_way.is_staged:
			network_way.queue_free()


func reset_network_variables():
	current_network_node_a = null
	current_network_node_b = null
	current_network_way = null


# NetworkNodes -----------------------------------------------------------------


func add_network_node(position: Vector3) -> Area:
	var new_network_node = network_node_scene.instance()
	new_network_node.connect("network_node_snap_to", self, "snap_to_position")
	new_network_node.connect("network_node_snapped_to", self, "handle_snapped_to_network_node", [new_network_node])
	new_network_node.transform.origin = position

	network_nodes_container.add_child(new_network_node)
	return new_network_node


func handle_snapped_to_network_node(node: Area):
	if current_network_node_a and !current_network_node_b:
		current_network_node_a.queue_free()
		current_network_node_a = node
		add_current_network_way()

	elif current_network_node_a and current_network_node_b:
		current_network_node_b.queue_free()
		current_network_node_b = node
		commit_current_network_way()
		stop_building()
		return

	update_current_network_way()


func move_current_network_node(position: Vector3):
	if current_network_node_a and !current_network_node_b:
		current_network_node_a.transform.origin = position
	elif current_network_node_a and current_network_node_b:
		current_network_node_b.transform.origin = position
	else:
		return

	update_current_network_way()


# NetworkWays ------------------------------------------------------------------


func add_network_way() -> Area:
	var new_network_way = network_way_scene.instance()
	new_network_way.connect("network_way_snap_to", self, "snap_to_position")
	new_network_way.connect("network_way_snapped_to", self, "handle_snapped_to_network_way")
	network_ways_container.add_child(new_network_way)
	return new_network_way


func add_current_network_way():
	current_network_node_b = add_network_node(current_network_node_a.transform.origin)
	current_network_way = add_network_way()
	update_current_network_way()


func update_current_network_way():
	if current_network_way:
		current_network_way.network_node_a = current_network_node_a
		current_network_way.network_node_b = current_network_node_b
		current_network_way._update()
		add_network_way_intersections()


func commit_current_network_way():
	current_network_way.network_node_a.is_staged = false
	current_network_way.network_node_a.is_snappable = true
	current_network_way.network_node_a._update()

	current_network_way.network_node_b = current_network_node_b
	current_network_way.network_node_b.is_staged = false
	current_network_way.network_node_b.is_snappable = true
	current_network_way.network_node_b._update()

	current_network_way.is_staged = false
	current_network_way.is_snappable = true
	update_current_network_way()
	commit_network_way_intersections()


func handle_snapped_to_network_way():
	if current_network_node_a and !current_network_node_b:
		add_current_network_way()
	elif current_network_node_a and current_network_node_b:
		commit_current_network_way()
		stop_building()


# NetworkWayIntersections ------------------------------------------------------


func add_network_way_intersections():
	reset_existing_network_node_intersections()

	for intersected_network_way in current_network_way.get_intersecting_network_ways():
		var intersected_way_node_a = intersected_network_way.network_node_a.transform.origin
		var intersected_way_node_b = intersected_network_way.network_node_b.transform.origin

		var intersects_at = Geometry.get_closest_points_between_segments(
			current_network_node_a.transform.origin,
			current_network_node_b.transform.origin,
			intersected_way_node_a,
			intersected_way_node_b
		)[0]

		if !intersects_at:
			return

		var intersected_network_node: Area
		if intersects_at.distance_to(current_network_node_a.transform.origin) < MIN_INTERSECTION_DISTANCE:
			intersected_network_node = current_network_node_a
		elif intersects_at.distance_to(current_network_node_b.transform.origin) < MIN_INTERSECTION_DISTANCE:
			intersected_network_node = current_network_node_b
		else:
			intersected_network_node = add_network_node(intersects_at)
			intersected_network_node.is_intersection_gizmo = true

		network_way_intersections.append({
			"intersects_at": intersects_at,
			"intersected_network_way": intersected_network_way,
			"intersected_network_node": intersected_network_node
		})


func commit_network_way_intersections():
	if network_way_intersections.empty():
		return

	# Sort the intersections by distance from the `NetworkWay.network_node_a`
	network_way_intersections.sort_custom(self, "sort_network_way_intersections")

	for intersection in network_way_intersections:
		var intersected_network_way: Area = intersection["intersected_network_way"]
		var intersected_network_node: Area = intersection["intersected_network_node"]

		if current_network_node_a != intersected_network_node and current_network_node_b != intersected_network_node:
			split_network_way(
				current_network_way,
				intersected_network_node
			)

		split_network_way(
			intersected_network_way,
			intersected_network_node
		)


func split_network_way(existing_network_way: Area, intersection_network_node: Area):
	var new_network_way = add_network_way()
	new_network_way.network_node_a = existing_network_way.network_node_a
	new_network_way.network_node_b = intersection_network_node
	new_network_way.is_staged = false
	new_network_way._update()

	existing_network_way.network_node_a = intersection_network_node
	existing_network_way.is_staged = false
	existing_network_way._update()

	intersection_network_node.is_staged = false
	intersection_network_node.is_intersection_gizmo = false
	intersection_network_node.is_snappable = true
	intersection_network_node._update()


func sort_network_way_intersections(a: Dictionary, b: Dictionary):
	var current_network_node_a_position = current_network_node_a.transform.origin
	if a["intersects_at"].distance_to(current_network_node_a_position) < b["intersects_at"].distance_to(current_network_node_a_position):
		return true
	else:
		return false


func reset_existing_network_node_intersections():
	network_way_intersections = []

	for network_node in network_nodes_container.get_children():
		if network_node.is_intersection_gizmo:
			network_node.queue_free()
