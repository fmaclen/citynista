extends CollisionObject

var intersection = preload("res://scenes/Intersection.tscn")

func _on_StaticBody_input_event(_camera, event, click_position, _click_normal, _shape_idx):
	if event is InputEventMouseButton and event.pressed:
		var intersection_instance = intersection.instance()
		intersection_instance.transform.origin = click_position
		$Network.add_child(intersection_instance)
		
		
	
