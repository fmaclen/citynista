import type { LaneRef } from './types';

interface Point {
	x: number;
	y: number;
}

export function sameLaneRef(a: LaneRef, b: LaneRef): boolean {
	return a.segmentId === b.segmentId && a.laneIndex === b.laneIndex;
}

// A connection as the lane connector draws it: from one lane end to another,
// with the travel direction at each end so the arc leaves and arrives along
// its lanes.
export interface LaneConnection {
	from: LaneRef;
	to: LaneRef;
	fromPoint: Point;
	toPoint: Point;
	// Travel tangent entering the node (at `from`) and leaving it (at `to`).
	fromDir: Point;
	toDir: Point;
	active: boolean;
}
