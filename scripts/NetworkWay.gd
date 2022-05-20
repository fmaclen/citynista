extends Node


var nodes: PoolIntArray


func add_network_node(index: int):
  nodes.append(index)
  _update()


func last_node_position():
  return get_parent().get_node_position(nodes[-1]).position


func _update():
  # $Path.curve.add_point(last_node_position())
  $Path.curve.add_point(Vector3.ZERO)
  $Path.curve.add_point(Vector3(10, 0, 0))
