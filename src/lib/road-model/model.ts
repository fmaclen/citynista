// The map model that gets drawn (docs/road-model.md). A road is a line with
// one cross-section along it; a junction is a group of road ends with stored
// connections, walkways and approach controls. Nothing here names a kind of
// road or junction: the drawing only ever sees lanes, connections and the
// gaps between them.

import type { JunctionConnection, JunctionLaneRef } from '../core/types';

export interface Pt {
	x: number;
	y: number;
}

// What a lane carries. Connections only ever join lanes of the same kind.
type LaneKind = 'drive' | 'walk' | 'buffer';
export type Surface = 'asphalt' | 'concrete' | 'grass' | 'pavement' | 'hatch' | 'dirt';
// Travel relative to the road's drawing direction.
type Dir = 'fwd' | 'back' | 'both' | 'none';

export interface Lane {
	// Stable across edits, so connections can name it.
	id: string;
	kind: LaneKind;
	width: number;
	dir: Dir;
	surface: Surface;
}

export const isTravel = (lane: Lane) =>
	lane.kind === 'drive' && (lane.dir === 'fwd' || lane.dir === 'back');
export const isRoadway = (lane: Lane) => lane.kind === 'drive' || lane.surface === 'hatch';
export const isRaised = (lane: Lane) =>
	lane.kind === 'buffer' && (lane.surface === 'grass' || lane.surface === 'concrete');
export const isWalk = (lane: Lane) => lane.kind === 'walk';

// A point on a road's line; c1/c2 are the cubic handles of the piece that
// ends here (a straight piece when absent).
export interface PathPoint extends Pt {
	c1?: Pt;
	c2?: Pt;
}

export interface Road {
	id: string;
	points: PathPoint[];
	// Left to right, looking along the drawing direction, centred on the
	// drawn line.
	lanes: Lane[];
	// Metres the cross-section sits to the right of the drawn line at the
	// road's start, looking along the drawing direction.
	offset: number;
	// Metres the whole cross-section moves further right for each metre
	// along, on top of `offset`: a road shifted differently at its two ends
	// runs straight between them.
	lean?: number;
	// Crosswalks across the road: where along it (metres from its start) and
	// between which two sidewalks (lane ids).
	crossings?: { at: number; lanes: [string, string] }[];
	// Set by core/place.ts: changes whenever anything the road's drawing
	// reads of it does.
	key?: string;
}

export type End = 'start' | 'end';

export interface EndRef {
	road: string;
	end: End;
}

// A lane end at a junction, and a connection between two: the saved types.
// Of nodes merged into one (merge.ts), a connection chained through roads
// merged away between them lists the lane it takes on each (`via`), from
// the end it enters by: its path follows them.
export type LaneRef = JunctionLaneRef;
export type Connection = JunctionConnection & { via?: LaneRef[] };

// A walking connection between two walk-lane ends of different roads: the
// sidewalk round a corner. Where it crosses a road's mouth it carries on as
// a crossing there, zebra stripes over the car lanes (crossingOver in
// corners.ts). Crossings across a road itself are the road's own
// (`Road.crossings`).
export interface Walkway {
	id: string;
	a: LaneRef;
	b: LaneRef;
}

export type Control = 'none' | 'stop' | 'yield' | 'signal';

// Of some controls, the one traffic is held at hardest: a signal, then a
// stop, then a give-way.
const RANK: Control[] = ['none', 'yield', 'stop', 'signal'];
export function strongest(held: Control[]): Control {
	return held.reduce((a, b) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a), 'none');
}

export interface Junction {
	id: string;
	ends: EndRef[];
	connections: Connection[];
	walkways: Walkway[];
	// Keyed by endKey.
	control: Record<string, Control>;
	// Road ends attached at the edge of the others (by end key): the lanes
	// carry on side by side across the node instead of turning at a
	// junction.
	sides?: string[];
	// Where each attached end meets the road it joins, before the node trims
	// it back. Its lanes are read across from here, so how far the taper
	// trims them never changes how they pair up or the taper they need.
	anchors?: Record<string, Pt>;
	// Set where the node's lanes find their way across it from one side to
	// the other instead of meeting at a junction (two roads, or roads
	// attached at an edge beside the ones they join): the road ends on each
	// side, by end key, each side's leading road first. core/place.ts decides
	// it from the roads as they leave the node, before any trim; the
	// connections and the drawing both read it here.
	link?: [string[], string[]];
	// Of nodes too close together merged into one (merge.ts): each node's own
	// road ends, the roads merged away between them included. The curb
	// outline is theirs, joined along those roads (joinedOutline in
	// outline.ts).
	parts?: EndRef[][];
	// Of nodes merged into one: where an approach's signs stand when that is
	// not its own end. An approach that goes on into a road merged away is
	// controlled where that road meets the next node, and gives way there:
	// by end key, the far end of each road merged away it goes on through, in
	// order (road ends in `parts`), the last where its signs stand.
	signsAt?: Record<string, string[]>;
	// Of nodes merged into one: each road that carries on through them by
	// way of roads merged away between them (by end key, the two ends it
	// leaves by; `via`, each road merged away from the end it comes in at),
	// and whether it has priority all along. Its lines follow those roads.
	runs?: { ends: [string, string]; via: EndRef[]; priority: boolean }[];
}

// A junction as drawn: one node's, or those of nodes too close together
// merged into one (merge.ts). `members` are the node ids it covers; `key`
// changes whenever anything its drawing reads does.
export interface DrawnJunction extends Junction {
	members: string[];
	key: string;
}

// What gets drawn: every road but those merged away inside a junction, and
// the junctions as drawn. The roads merged away (`hidden`) are kept for the
// curb outlines that follow them.
export interface Place {
	roads: Road[];
	hidden: Road[];
	junctions: DrawnJunction[];
}

export const endKey = (ref: EndRef) => `${ref.road}:${ref.end}`;
// A corner sidewalk's id, by the road ends it runs round from and to: its
// crossing over a road's mouth on the way takes the same id (cornersOf).
export const walkwayId = (a: EndRef, b: EndRef) => `${endKey(a)}~${endKey(b)}`;
// The other end of a road end's road.
export const farEnd = (ref: EndRef): EndRef => ({
	road: ref.road,
	end: ref.end === 'start' ? 'end' : 'start'
});
export const laneKey = (ref: LaneRef) => `${ref.road}:${ref.end}/${ref.lane}`;
