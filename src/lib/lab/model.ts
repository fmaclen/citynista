// The map model under test (docs/road-model.md). A road is a line with
// stretches along it; a junction is a group of road ends with stored
// connections, walkways and approach controls. Nothing here names a kind of
// road or junction: the drawing only ever sees lanes, stretches, connections
// and the gaps between them.

export interface Pt {
	x: number;
	y: number;
}

// What a lane carries. Connections only ever join lanes of the same kind.
export type LaneKind = 'drive' | 'bus' | 'walk' | 'trail' | 'buffer';
export type Surface = 'asphalt' | 'concrete' | 'grass' | 'pavement' | 'hatch' | 'dirt';
// Travel relative to the road's drawing direction.
export type Dir = 'fwd' | 'back' | 'both' | 'none';

export interface Lane {
	// Stable across stretches: a lane begins where its id first appears and
	// ends where it stops appearing.
	id: string;
	kind: LaneKind;
	width: number;
	dir: Dir;
	surface: Surface;
}

// Which part of the cross-section sits on the drawn line.
export type Align = 'left' | 'centre' | 'right';

export interface Stretch {
	// Distance along the road where this stretch begins.
	at: number;
	// Metres over which lanes blend from the previous stretch into this one.
	taper: number;
	align: Align;
	// Metres the cross-section sits to the right of the drawn line (after
	// alignment), looking along the drawing direction.
	offset?: number;
	// Left to right, looking along the drawing direction.
	lanes: Lane[];
}

// A point on a road's line; c1/c2 are the cubic handles of the piece that
// ends here (a straight piece when absent).
export interface PathPoint extends Pt {
	c1?: Pt;
	c2?: Pt;
}

export interface Road {
	id: string;
	points: PathPoint[];
	stretches: Stretch[];
	// Height along the road, flat for now.
	height: number;
	// How far before each end a raised median stops in its rounded nose
	// (part of the road's last stretch). Absent means the default.
	noses?: { start?: number; end?: number };
	// Per-carriageway ends: lanes (by id) that stop this many metres short of
	// the road's start or end, so one side of a road can meet its junction
	// further back than the other.
	cuts?: { start?: Record<string, number>; end?: Record<string, number> };
	// Crosswalks across the road: where along it (metres from its start),
	// between which two sidewalks (lane ids), and of what kind.
	crossings?: RoadCrossing[];
}

export interface RoadCrossing {
	at: number;
	lanes: [string, string];
	type?: CrossingType;
}

// A placed island: a polygon, in world metres, or in the frame of a road end
// (x along the road away from the junction, y along its right normal) so it
// moves with that end.
export interface Island {
	shape: Pt[];
	surface: Surface;
	anchor?: string;
}

// One corner of a junction's curb outline: from one road end's curb to the
// next going round. `bulge` scales the default corner curve.
export interface Corner {
	a: string;
	b: string;
	bulge: number;
	// A hand-shaped corner: the curb runs straight through these points.
	via?: Pt[];
}

export type End = 'start' | 'end';

export interface EndRef {
	road: string;
	end: End;
}

export interface LaneRef extends EndRef {
	lane: string;
}

// How a crosswalk is built where a sidewalk connection crosses car lanes.
// Only painted ones for now; raised tables and other materials come later.
export type CrossingType = 'painted';

export interface Connection {
	from: LaneRef;
	to: LaneRef;
}

// A walking connection between two walk-lane ends of different roads: the
// sidewalk round a corner. Where it crosses a road's mouth (a driveway) it
// is drawn as a crossing there (zebra, or sidewalk paving when `paved`),
// and only while it is on. Crossings across a road itself are the road's
// own (`Road.crossings`).
export interface Walkway {
	id: string;
	a: LaneRef;
	b: LaneRef;
	on: boolean;
	paved: boolean;
	// No sidewalk of its own along the curb: only its crossings are drawn
	// (a bus station's grass runs up to the curb, crossed by ladders).
	bare?: boolean;
}

export type Control = 'none' | 'stop' | 'yield' | 'signal';

export interface Junction {
	id: string;
	ends: EndRef[];
	connections: Connection[];
	walkways: Walkway[];
	// Keyed by endKey.
	control: Record<string, Control>;
	// The curb outline, corner by corner, in order round the junction.
	// Asphalt is everything inside it.
	corners: Corner[];
	islands: Island[];
	// Approaches that get turn arrows though nobody stops (a roundabout's ring).
	arrows?: string[];
	// Road ends attached at the edge of the others (by end key): the lanes
	// carry on side by side across the node instead of turning at a
	// junction.
	sides?: string[];
	// Where each attached end meets the road it joins, before the node trims
	// it back. Its lanes are read across from here, so how far the taper
	// trims them never changes how they pair up or the taper they need.
	anchors?: Record<string, Pt>;
}

export interface Place {
	id: string;
	title: string;
	photo?: string;
	note?: string;
	roads: Road[];
	junctions: Junction[];
	// Islands that belong to no junction (a roundabout's centre).
	islands: Island[];
	// Links currently merged away (see merge.ts); kept so a merge holds until
	// the link is clearly long again.
	merged?: string[];
	// Roads a drag pushed aside, with the shape they had before: they go
	// back to it as soon as there is room again.
	rest?: Record<string, PathPoint[]>;
	// How far in and out from the road it joins each minor road's end has
	// been, so a drag can always take it back to where it once was.
	reach?: Record<string, { in: number; out: number }>;
	view: { x: number; y: number; zoom: number };
}

export const endKey = (ref: EndRef) => `${ref.road}:${ref.end}`;
export const laneKey = (ref: LaneRef) => `${ref.road}:${ref.end}/${ref.lane}`;
export const connectionKey = (c: Connection) => `${laneKey(c.from)}>${laneKey(c.to)}`;

export function parseLaneKey(key: string): LaneRef {
	const [endPart, lane] = key.split('/');
	const [road, end] = endPart.split(':');
	return { road, end: end as End, lane };
}

export function parseEndKey(key: string): EndRef {
	const [road, end] = key.split(':');
	return { road, end: end as End };
}
