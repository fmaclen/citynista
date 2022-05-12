extends CollisionObject


var intersection_scene = preload("res://scenes/Intersection.tscn")


func _on_Map_input_event(_camera, event, click_position, _click_normal, _shape_idx):
	if event is InputEventMouseButton and event.button_index == BUTTON_LEFT:
		var intersection = intersection_scene.instance()
		intersection.transform.origin = click_position
		print(_click_normal)
		$Network.add_child(intersection)


