extends CollisionObject


onready var toolbar: Node = get_parent().get_node("GUI").get_node("Toolbar")

var is_building: bool = false
var is_editing: bool = false
var is_removing: bool = false

onready var network_nodes_container: Node = $Network.get_node("Nodes")
onready var network_ways_container: Node = $Network.get_node("Ways")

const network_node_scene: PackedScene = preload("res://scenes/NetworkNode.tscn")
const network_way_scene: PackedScene = preload("res://scenes/NetworkWay.tscn")

var network_node_a: Area
var network_node_b: Area
var network_node_snap_to: Area
var network_node_collision: Area

var network_way: Spatial
var network_way_collided: Area


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
				add_network_way()

		elif network_node_b.is_staged:
			move_network_node(network_node_b, position)

			if event.is_action_released("ui_left_click"):
				commit_network_node(network_node_b, position)
				cleanup_network()


func cleanup_network():
	set_network_way_nodes()
	commit_network_way()

	if network_way_collided != null:
		update_collided_network_way()

	reset_network_variables()


func reset_network_variables():
	network_node_a = null
	network_node_b = null
	network_node_snap_to = null
	network_way = null
	network_way_collided = null


# NetworkNodes -----------------------------------------------------------------


func move_network_node(node: Area, position: Vector3):
	node.transform.origin = position
	if network_way != null:
		set_network_way_nodes()


func commit_network_node(node: Area, position: Vector3):
	node.transform.origin = position
	node.is_staged = false
	node._update()


func add_network_node(position) -> Node:
	var node = network_node_scene.instance()

	node.connect("network_node_snap_to", self, "handle_snap_to_network_node")
	node.connect("network_node_snapped", self, "handle_snapped_to", [node])

	node.transform.origin = position
	node.is_staged = true
	node.is_snappable = false

	network_nodes_container.add_child(node)

	return node


func handle_snap_to_network_node(should_snap: bool, snap_position: Vector3):
	handle_snap_to(should_snap, snap_position)

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


func handle_snap_to(should_snap: bool, snap_position: Vector3):
	if should_snap:
		if network_node_a != null and network_node_a.is_staged:
			move_network_node(network_node_a, snap_position)
		if network_node_b != null and network_node_b.is_staged:
			move_network_node(network_node_b, snap_position)


func handle_snapped_to(node: Node):
	if network_node_a != null and network_node_a.is_staged:
		network_node_a.queue_free()
		network_node_a = node
		network_node_a.is_staged = false
		network_node_a.is_snappable = false
		network_node_b = add_network_node(network_node_a.transform.origin)
		add_network_way()
	elif network_node_b != null and network_node_b.is_staged:
		network_node_b.queue_free()
		network_node_b = node
		network_node_b.is_staged = false
		network_node_b.is_snappable = false
		cleanup_network()


# NetworkWays ------------------------------------------------------------------


func add_network_way():
	network_way = network_way_scene.instance()
	network_way.monitoring = true
	network_ways_container.add_child(network_way)
	set_network_way_nodes()


func set_network_way_nodes():
	network_way.network_node_a = network_node_a
	network_way.network_node_b = network_node_b
	network_way._update()


func commit_network_way():
	network_way.connect("network_way_snap_to", self, "handle_snap_to")
	network_way.connect("network_way_collided", self, "handle_network_way_collided", [network_way])
	##############################################################################
	network_way.connect("network_way_intersected", self, "handle_network_way_intersected", [network_way])
	##############################################################################

	network_way.monitoring = false
	network_way.is_staged = false
	network_way.is_snappable = true

	network_node_a.is_staged = false
	network_node_a.is_snappable = true
	network_node_a._update()

	network_node_b.is_staged = false
	network_node_b.is_snappable = true
	network_node_b._update()


################################################################################

func handle_network_way_intersected(intersected_network_way: Area, current_network_way: Area):
	if network_way_collided == null:
		return

	network_way_collided = intersected_network_way
	var net_node_a1 = intersected_network_way.network_node_a
	var net_node_b1 = intersected_network_way.network_node_b

	print("intersected_network_way", net_node_a1.transform.origin)
	print("intersected_network_way", net_node_b1.transform.origin)

################################################################################


func handle_network_way_collided(collision_position: Vector3, collided_network_way: Area):
	network_way_collided = collided_network_way
	network_node_collision = add_network_node(collision_position)
	handle_snapped_to(network_node_collision)


# Split the collided NetworkWay into two NetworkWays at the collision point
func update_collided_network_way():

	# Create a new NetworkWay from Node A to the collision point
	add_network_way()
	network_way.network_node_a = network_node_collision
	network_way.network_node_b = network_way_collided.network_node_b
	commit_network_way()
	network_way._update()
	
	# Add a second NetworkWay from the collision point to the Node B
	add_network_way()
	network_way.network_node_a = network_way_collided.network_node_a
	network_way.network_node_b = network_node_collision
	commit_network_way()
	network_way._update()

	# Remove the old NetworkWay
	network_way_collided.queue_free()


func remove_staged_network_way():
	if network_node_a != null:
		network_node_a.queue_free()

	if network_way != null and network_way.is_staged:
		network_node_b.queue_free()
		network_way.queue_free()

	reset_network_variables()

