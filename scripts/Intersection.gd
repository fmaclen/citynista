extends CollisionObject


func _on_Intersection_mouse_entered():
	$Puck.transform.origin.y = $Puck.transform.origin.y + 0.25

func _on_Intersection_mouse_exited():
	$Puck.transform.origin.y = $Puck.transform.origin.y - 0.25
