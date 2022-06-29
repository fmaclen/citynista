extends Spatial


var space_state = null
var move_longitudinal = Vector3.ZERO
var move_lateral = Vector3.ZERO
onready var camera = $Camera

const MOVEMENT_SPEED: float = 64.0
const ROTATION_SPEED: float = 128.0
const ZOOM_SENSITIVITY: float = 4.0
const ZOOM_MIN: float = 8.0
const ZOOM_MAX: float = 128.0


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
			set_camera_zoom(-ZOOM_SENSITIVITY)

		if event.button_index == BUTTON_WHEEL_DOWN:
			set_camera_zoom(ZOOM_SENSITIVITY)

	if event is InputEventPanGesture:
		set_camera_zoom(event.delta.y * ZOOM_SENSITIVITY * Globals.HALF)


func set_camera_zoom(size):
	camera.size = clamp(camera.size + size, ZOOM_MIN, ZOOM_MAX)
