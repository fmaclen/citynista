extends Spatial


var MOVEMENT_SPEED: float = 25.0
var ROTATION_SPEED: float = 100.0
var ZOOM_SENSITIVITY: float = 1.0
var ZOOM_MIN: float = 4.0
var ZOOM_MAX: float = 64.0

var space_state = null
var move_longitudinal = Vector3.ZERO
var move_lateral = Vector3.ZERO
onready var camera = $Camera


func _ready():
	space_state = get_world().direct_space_state


func _process(delta):
	if Input.is_action_pressed("ui_up"):
		move_longitudinal += transform.basis.z * MOVEMENT_SPEED * delta

	if Input.is_action_pressed("ui_down"):
		move_longitudinal -= transform.basis.z * MOVEMENT_SPEED * delta

	if Input.is_action_pressed("ui_left"):
		move_lateral += transform.basis.x * MOVEMENT_SPEED * delta

	if Input.is_action_pressed("ui_right"):
		move_lateral -= transform.basis.x * MOVEMENT_SPEED * delta

	if Input.is_action_pressed("camera_rotate_left"):
		rotation_degrees.y -= ROTATION_SPEED * delta

	if Input.is_action_pressed("camera_rotate_right"):
		rotation_degrees.y += ROTATION_SPEED * delta

	translation = move_longitudinal + move_lateral


func _input(event):
	if event is InputEventMouseButton:
		if event.button_index == BUTTON_WHEEL_UP:
			set_camera_zoom(-ZOOM_SENSITIVITY * 2)

		if event.button_index == BUTTON_WHEEL_DOWN:
			set_camera_zoom(ZOOM_SENSITIVITY * 2)

	if event is InputEventPanGesture:
		set_camera_zoom(event.delta.y * ZOOM_SENSITIVITY)


func set_camera_zoom(size):
	camera.size = clamp(camera.size + size, ZOOM_MIN, ZOOM_MAX)
