// What a drawer hands on: a description of a road or a node, not finished
// polygons. rendering/road-meshes.ts turns one into triangles, checks.ts
// reads it.

import type { Move } from './arrows';
import type { LaneSpan, PathSample } from './geometry';
import type { EndInfo } from './ends';
import type { Control, LaneRef, Pt } from './model';

// An open polyline, metres.
export type Line = Pt[];
// A closed polygon that never crosses itself and is wound to a positive
// area. It has nowhere to put a hole: toRings (clip.ts) slices holed
// polygons into rings, and where it cannot its caller's description says so
// (`faults`).
export type Ring = Pt[];
export type Material = 'asphalt' | 'concrete' | 'grass' | 'dirt';
// What a surface is for. With the material it sets where the surface sits in
// the stack (layerOf in rendering/road-meshes.ts).
export type Role = 'walk' | 'paving' | 'lane' | 'verge' | 'median';

// A strip between two lines of equal point count, never folded: neither
// triangle of any quad is turned over and its outline never crosses itself.
// ribbonOf (geometry.ts) makes ribbons and turns a folded strip into rings.
export interface Ribbon {
	left: Line;
	right: Line;
}

export interface Surface {
	role: Role;
	material: Material;
	shape: Ribbon | Ring[];
	// The lane it is, on a road; at a node, the lane a band carries on from.
	// By road and lane id, as a connection names it (less the end).
	lane?: { road: string; lane: string };
	// Hatching over it, already clipped, with stubs dropped.
	bars?: { colour: 'white' | 'yellow'; rings: Ring[] };
}

// A painted line's middle; `along` is how far along the road (on a road) or
// the line (at a node) each point is, which sets the dash rhythm. A piece
// cut from a longer line (by a crossing, a walkway) keeps that line's dashes:
// `rhythm` is the stretch of `along` they are fitted to, unless it is the
// piece's own.
export interface Marking {
	colour: 'white' | 'yellow';
	dashed: boolean;
	line: Line;
	along: number[];
	rhythm?: [number, number];
}

// `end` is the bar across a lane that goes nowhere; a stop or yield line
// lies across the lanes it names.
export type Sign =
	| { kind: 'end'; lane: LaneRef; a: Pt; b: Pt }
	| { kind: 'stop'; lanes: LaneRef[]; a: Pt; b: Pt }
	| { kind: 'yield'; lanes: LaneRef[]; a: Pt; b: Pt; toward: Pt }
	| { kind: 'arrow'; lane: LaneRef; at: Pt; dir: Pt; moves: Move[]; scale: number };

export interface Crossing {
	id: string;
	// Its middle, sidewalk to sidewalk.
	line: Line;
	// A zebra's rings are its stripes.
	runs: { kind: 'zebra' | 'paved' | 'refuge'; rings: Ring[] }[];
	// All of it: markings stop here, and it must stay one piece.
	body: Ring[];
}

export interface LanePath {
	from: LaneRef;
	to: LaneRef;
	kind: 'drive' | 'walk' | 'buffer' | 'grass';
	line: Line;
	widths: number[];
}

// Where a road's paint stops (metres back from the end), and where a median
// stops in its nose (null at a free end, 0 where it meets the outline).
export interface EndCut {
	paint: number;
	nose: number | null;
}

export interface RoadDescription {
	path: PathSample;
	// The cross-section at the road's start. Where each lane lies further
	// along is in `edges`.
	lanes: LaneSpan[];
	// The lanes.length + 1 lane boundaries.
	edges: Line[];
	// Distance along the road at each edge sample.
	along: number[];
	surfaces: Surface[];
	markings: Marking[];
	crossings: Crossing[];
	cut: { start: EndCut; end: EndCut };
	// A point of each ring left covering a hole that could not be sliced away
	// (toRings in clip.ts); empty when the drawing is sound.
	faults: Pt[];
}

export interface NodeDescription {
	ends: EndInfo[];
	// The curb outline: the ground it encloses, each corner's curb from one
	// road end to the next going round (across a node of two sides, the edge
	// of the lane beside it), and each road end's mouth across its roadway
	// through every lane edge, with the direction out along the road.
	outline: {
		rings: Ring[];
		corners: { a: string; b: string; line: Line }[];
		mouths: { end: string; line: Line; out: Pt }[];
	};
	// Each connection's path across the node, by the lanes it joins.
	paths: LanePath[];
	surfaces: Surface[];
	markings: Marking[];
	signs: Sign[];
	crossings: Crossing[];
	approaches: { end: string; control: Control; badge: Pt }[];
	// By end key: what the node asks of each road ending at it.
	cuts: Map<string, EndCut>;
	// As a road's.
	faults: Pt[];
}

export type Description = RoadDescription | NodeDescription;
