export type LaneRole = 'vehicle' | 'pedestrian' | 'buffer';
export type LaneMaterial = 'asphalt' | 'concrete' | 'pavement' | 'grass' | 'dirt';
export type LegacyLaneSurface = 'asphalt' | 'concrete' | 'grass' | 'curb' | 'paint';
export type LaneDirection = 'forward' | 'backward' | 'bidirectional';

export interface Lane {
	// Stable within its road, so junction connections can name it across
	// edits (assigned by the segment when missing).
	id?: string;
	role: LaneRole;
	material: LaneMaterial;
	width: number;
	// Direction of travel; only meaningful for vehicle lanes (others are bidirectional).
	direction: LaneDirection;
}

export interface Brush {
	name: string;
	lanes: Lane[];
}

// The legacy on-disk lane shape, accepted for migration on load. Old saves used
// `type` (+ optional `turn`); pre-material saves write `role` + `surface`.
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
	id?: string;
	type?: LegacyLaneType;
	turn?: 'left' | 'right';
	role?: LaneRole;
	surface?: LegacyLaneSurface;
	material?: LaneMaterial;
	width: number;
	direction: LaneDirection;
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

// A lane end at a junction: `road` is the id of the segment it belongs to.
export interface JunctionLaneRef {
	road: string;
	end: 'start' | 'end';
	lane: string;
}

// A crossing across one of a node's roads, between two of its sidewalks.
// `at` is how far from the node along that road it lies; absent, it sits at
// its default place just past the junction's corners. `on: false` switches a
// default crossing off.
export interface JunctionCrossing {
	road: string;
	end: 'start' | 'end';
	lanes: [string, string];
	at?: number;
	on?: boolean;
	crossing?: 'painted';
}

export interface JunctionConnection {
	from: JunctionLaneRef;
	to: JunctionLaneRef;
}

// What a node stores about the junction its segment ends form: every lane
// connection across it, of every kind, as the drawing uses them. They are
// the default ones plus the user's edits: connections `added` by hand and
// default ones `removed` by hand, each kept for as long as its lanes exist,
// so the defaults keep following the roads everywhere else.
export interface JunctionData {
	connections: JunctionConnection[];
	added?: JunctionConnection[];
	removed?: JunctionConnection[];
	// Where only two roads meet: the length the lanes take to find their way
	// across, set by hand (otherwise it follows how far they shift).
	taper?: number;
	// Crossings added by hand, and default ones moved or switched off.
	crossings?: JunctionCrossing[];
	// Each approach's control set by hand (keyed by road end), over the
	// default.
	control?: Record<string, 'none' | 'stop' | 'yield' | 'signal'>;
	// Roads attached at the edge of the others here (by segment id), and which
	// way they sit off them, looking out of the node along the attached road
	// (see core/attach.ts).
	sides?: Record<string, 'left' | 'right'>;
	islands?: { shape: { x: number; y: number }[]; surface: 'grass' | 'concrete' | 'pavement' }[];
}

export interface NodeData {
	id: string;
	x: number;
	y: number;
	// Optional debug annotation, drawn by the dev-only node label overlay.
	label?: string;
	junction?: JunctionData;
}

export interface SegmentData {
	id: string;
	startNodeId: string;
	endNodeId: string;
	controlX?: number;
	controlY?: number;
	lanes?: StoredLane[];
	// Metres the cross-section sits to the right of the drawn line.
	offset?: number;
	// Legacy saves referenced a shared template instead of owning lanes.
	laneTemplateId?: string;
}

export interface GraphData {
	nodes: NodeData[];
	segments: SegmentData[];
}

export interface CameraState {
	zoom: number;
	targetX: number;
	targetZ: number;
	azimuth: number;
	polar: number;
}

// A saved city: its road graph plus the camera you were looking through, stored
// in localStorage so a session reopens exactly where it was left.
export interface CityRecord {
	id: string;
	name: string;
	graph: GraphData;
	camera: CameraState | null;
}

export interface CitySummary {
	id: string;
	name: string;
}
