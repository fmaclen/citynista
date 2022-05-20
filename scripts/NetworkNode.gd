extends Area


var is_staged: bool = true


func _process(_delta):
	if is_staged:
		$CollisionShape.disabled = true
	else:
		$CollisionShape.disabled = false


func _on_NetworkNode_mouse_entered():
	$Puck.transform.origin.y = $Puck.transform.origin.y + 0.25


func _on_NetworkNode_mouse_exited():
	$Puck.transform.origin.y = $Puck.transform.origin.y - 0.25
