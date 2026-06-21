export type LaneType =
	| 'road'
	| 'concrete'
	| 'bike'
	| 'parking'
	| 'transit'
	| 'turn'
	| 'sidewalk'
	| 'grass'
	| 'median';
export type LaneDirection = 'forward' | 'backward' | 'bidirectional';

export type TurnMovement = 'left' | 'right';

export interface Lane {
	type: LaneType;
	width: number;
	direction: LaneDirection;
	// Which way a turn lane's arrow points, independent of the flow direction.
	// Absent falls back to the junction-derived bend.
	turn?: TurnMovement;
	// Omitted (and defaulted true) unless this lane's markings are disabled.
	// A boundary line is painted only where both adjacent lanes are marked.
	markings?: boolean;
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
