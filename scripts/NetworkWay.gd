extends Node


var network_node_ids: PoolIntArray


func add_network_node(id: int):
	network_node_ids.append(id)
	_update()


func _update():
	for i in network_node_ids:
		$Path.curve.add_point(instance_from_id(i).transform.origin)
		# print($Pathz.curve.get_baked_points())
