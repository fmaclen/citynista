export type LaneRole = 'vehicle' | 'pedestrian' | 'buffer';
export type LaneSurface = 'asphalt' | 'concrete' | 'grass' | 'curb' | 'paint';
export type LaneDirection = 'forward' | 'backward' | 'bidirectional';

export interface Lane {
	role: LaneRole;
	surface: LaneSurface;
	width: number;
	// Direction of travel; only meaningful for vehicle lanes (others are bidirectional).
	direction: LaneDirection;
	// Omitted (and defaulted true) unless this lane's markings are disabled.
	markings?: boolean;
}

// The legacy on-disk lane shape, accepted for migration on load. Old saves used
// `type` (+ optional `turn`); new saves write `role` + `surface`.
export type LegacyLaneType =
	| 'road'
	| 'concrete'
	| 'bike'
	| 'parking'
	| 'transit'
	| 'turn'
	| 'sidewalk'
	| 'grass'
	| 'median';

export interface StoredLane {
	type?: LegacyLaneType;
	turn?: 'left' | 'right';
	role?: LaneRole;
	surface?: LaneSurface;
	width: number;
	direction: LaneDirection;
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
	// Movements turned ON beyond the default set (U-turns, median breaks).
	enabledConnections?: LaneConnectionRef[];
}

export interface SegmentData {
	id: string;
	startNodeId: string;
	endNodeId: string;
	controlX?: number;
	controlY?: number;
	lanes?: StoredLane[];
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
