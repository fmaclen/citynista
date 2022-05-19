extends CheckButton


signal is_building_mode_active(state)


func _input(event):
	if pressed:
		if event is InputEventKey and event.is_action_released("ui_cancel"):
			pressed = false
			_on_Button_pressed()

func _on_Button_pressed():
	if pressed:
		emit_signal("is_building_mode_active", true)
	else:
		emit_signal("is_building_mode_active", false)
