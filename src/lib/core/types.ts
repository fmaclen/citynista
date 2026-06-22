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

// A lane addressed by its segment and its index in that segment's stack.
export interface LaneRef {
	segmentId: string;
	laneIndex: number;
}

// A movement through a node: an incoming lane routed to an outgoing lane.
export interface LaneConnectionRef {
	from: LaneRef;
	to: LaneRef;
}

export interface NodeData {
	id: string;
	x: number;
	y: number;
	// Movements turned OFF at this junction. Empty/omitted = every default
	// (permissive) movement is allowed.
	disabledConnections?: LaneConnectionRef[];
}

export interface SegmentData {
	id: string;
	startNodeId: string;
	endNodeId: string;
	controlX?: number;
	controlY?: number;
	lanes?: Lane[];
	// Manual per-end setback overrides (distance pulled back from each node).
	setbackStart?: number;
	setbackEnd?: number;
	// Legacy saves referenced a shared template instead of owning lanes.
	laneTemplateId?: string;
}

export interface GraphData {
	nodes: NodeData[];
	segments: SegmentData[];
}
