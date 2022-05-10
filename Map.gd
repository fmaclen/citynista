extends CollisionObject


func _on_StaticBody_input_event(_camera, event, click_position, _click_normal, _shape_idx):
	if event is InputEventMouseButton and event.pressed:
		$Marker.transform.origin = click_position
