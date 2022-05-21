extends GridContainer


signal set_is_building
signal set_is_editing

var button_ids: PoolIntArray


func _ready():
	button_ids = [$ButtonBuild.get_instance_id(),	$ButtonEdit.get_instance_id()]

	for id in button_ids:
		instance_from_id(id).connect("pressed", self, "handle_button", [instance_from_id(id)])


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
	for id in button_ids:
		instance_from_id(id).pressed = false

	emit_signal("set_is_building", false)
	emit_signal("set_is_editing", false)
