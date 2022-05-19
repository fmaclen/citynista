extends CollisionObject


onready var network = $Network
var intersection_scene = preload("res://scenes/Intersection.tscn")
var is_building_mode: bool = false
var staged_intersection


func _on_Button_is_building_mode_active(state):
	is_building_mode = state
	if !is_building_mode:
		staged_intersection.queue_free()


func _on_Map_input_event(_camera, event, click_position, _click_normal, _shape_idx):
	if is_building_mode:
		if event is InputEventMouseButton and event.button_index == BUTTON_LEFT:
			add_segment(click_position)
		else:
			stage_segment(click_position)


func create_segment(position):
	print("creating new segment")
	var intersection_instance = intersection_scene.instance()
	intersection_instance.transform.origin = position
	intersection_instance.is_staged = false
	network.add_child(intersection_instance)


func stage_segment(position):
	if network.get_child_count() > 1:
		staged_intersection = network.get_child(network.get_child_count() - 1)
		staged_intersection.is_staged = true
		staged_intersection.transform.origin = position
	else:
		create_segment(position)


func add_segment(position):
	print("adding segment")
	# Prevent adding multiple intersections when many click events are fired in the same position
	if is_click_debounced(position):
		create_segment(position)


func is_click_debounced(clicked_position):
	var last_clicked_position: Vector3
	if last_clicked_position == Vector3.ZERO || last_clicked_position != clicked_position:
		return true
	else:
		last_clicked_position = clicked_position
		return false

