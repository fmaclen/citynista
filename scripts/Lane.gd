class_name Lane

enum LaneType {
	SIDEWALK,
	ROAD
}

const atlas = [
	{
		"type": LaneType.SIDEWALK,
		"width": 1.5,
		"height": 0.2,
		"material": preload("res://assets/theme/ColorSidewalk.tres")
	},
	{
		"type": LaneType.ROAD,
		"width": 3.0,
		"height": 0.1,
		"material": preload("res://assets/theme/ColorRoad.tres")	
	}
]
