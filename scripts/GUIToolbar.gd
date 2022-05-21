extends GridContainer


signal set_is_building
signal set_is_editing


func _ready():
	for button in get_children():
		button.connect("pressed", self, "handle_button", [button])


func handle_button(button: Button):
	unpress_buttons()
	button.pressed = true

	if button.text == "Build":
		emit_signal("set_is_building", true)
	elif button.text == "Edit":
		emit_signal("set_is_editing", true)


func _input(event):
	if event is InputEventKey and event.is_action_released("ui_cancel"):
		unpress_buttons()


func unpress_buttons():
	for button in get_children():
		button.pressed = false

	emit_signal("set_is_building", false)
	emit_signal("set_is_editing", false)
