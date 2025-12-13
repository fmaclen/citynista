export type LaneType = 'road' | 'sidewalk' | 'grass' | 'median';
export type LaneDirection = 'forward' | 'backward' | 'bidirectional';

export interface Lane {
	type: LaneType;
	width: number;
	color: string;
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
	laneTemplateId: string;
}

export interface GraphData {
	nodes: NodeData[];
	segments: SegmentData[];
}
