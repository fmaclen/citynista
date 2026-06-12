export type LaneType =
	| 'road'
	| 'concrete'
	| 'bike'
	| 'parking'
	| 'transit'
	| 'sidewalk'
	| 'grass'
	| 'median';
export type LaneDirection = 'forward' | 'backward' | 'bidirectional';

export interface Lane {
	type: LaneType;
	width: number;
	direction: LaneDirection;
}

export interface LaneTemplate {
	id: string;
	name: string;
	lanes: Lane[];
}

export interface NodeData {
	id: string;
	x: number;
	y: number;
}

export interface SegmentData {
	id: string;
	startNodeId: string;
	endNodeId: string;
	controlX?: number;
	controlY?: number;
	lanes?: Lane[];
	// Legacy saves referenced a shared template instead of owning lanes.
	laneTemplateId?: string;
}

export interface GraphData {
	nodes: NodeData[];
	segments: SegmentData[];
}
