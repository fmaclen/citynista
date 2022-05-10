extends Spatial

export var MOVEMENT_SPEED: float = 25.0
export var ROTATION_SPEED: float = 75.0

var move_longitudinal = Vector3.ZERO
var move_lateral = Vector3.ZERO

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
