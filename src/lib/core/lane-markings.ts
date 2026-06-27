import type { Lane, LaneDirection } from './types';
import { getTotalWidth } from './lane-template';

// The single rubric for lane-edge markings, derived purely from a cross-section.
// One rule per boundary; everything else (double yellow, shoulder lines, buffer
// edges) is emergent — there is deliberately no "centre line" special case.
//
//   - the INNER edge of a travel-direction group (the side that faces opposing
//     traffic, possibly across a median/buffer) → a single SOLID YELLOW line;
//   - the OUTER edge (against a shoulder/verge/curb/road edge) → SOLID WHITE;
//   - boundaries INSIDE a group (between same-direction lanes) → DASHED WHITE;
//   - everything else (between non-vehicle lanes, or the road edge against one)
//     → no marking.
//
// Double yellow is just two opposing groups whose inner edges land on the same
// boundary, each inset toward its own side. Connectivity-dependent styling
// (turn-only bay solids, no-weave solids, taper continuity across a node) is a
// separate layer that consumes this base classification — not encoded here.

export type MarkColor = 'yellow' | 'white';

export interface LaneMark {
	// Boundary index 0..lanes.length: 0 is the left road edge, lanes.length the
	// right road edge, k the boundary between lane k-1 and lane k.
	boundaryIndex: number;
	color: MarkColor;
	dashed: boolean;
	// Which side the owning group sits on, so the renderer can inset the stroke
	// toward it: +1 = group is at higher offset, -1 = lower. Two opposing inner
	// edges on one boundary (undivided road) carry opposite sides → double yellow.
	side: -1 | 1;
}

interface Group {
	direction: 'forward' | 'backward';
	lo: number; // first lane index
	hi: number; // last lane index (inclusive)
}

function isTravel(lane: Lane): boolean {
	return lane.role === 'vehicle' && (lane.direction === 'forward' || lane.direction === 'backward');
}

export function boundaryOffsets(lanes: Lane[]): number[] {
	const bounds = [-getTotalWidth(lanes) / 2];
	for (const lane of lanes) bounds.push(bounds[bounds.length - 1] + lane.width);
	return bounds;
}

// Maximal contiguous runs of same-direction travel lanes.
function travelGroups(lanes: Lane[]): Group[] {
	const groups: Group[] = [];
	let i = 0;
	while (i < lanes.length) {
		if (!isTravel(lanes[i])) {
			i++;
			continue;
		}
		const direction = lanes[i].direction as 'forward' | 'backward';
		let j = i;
		while (j < lanes.length && isTravel(lanes[j]) && lanes[j].direction === direction) j++;
		groups.push({ direction, lo: i, hi: j - 1 });
		i = j;
	}
	return groups;
}

// An edge is INNER iff scanning outward from the group (skipping non-travel
// lanes — medians, buffers, verges) reaches an opposing-direction travel group.
// Reaching the road edge, or a same-direction group, makes it OUTER.
function edgeIsInner(lanes: Lane[], group: Group, step: 1 | -1): boolean {
	let k = step === 1 ? group.hi + 1 : group.lo - 1;
	while (k >= 0 && k < lanes.length) {
		if (isTravel(lanes[k])) return lanes[k].direction !== group.direction;
		k += step;
	}
	return false;
}

export function classifyCrossSection(lanes: Lane[]): LaneMark[] {
	const marks: LaneMark[] = [];
	for (const group of travelGroups(lanes)) {
		// Low edge belongs to a group sitting at higher offset (side +1); high
		// edge to a group at lower offset (side -1).
		marks.push({
			boundaryIndex: group.lo,
			color: edgeIsInner(lanes, group, -1) ? 'yellow' : 'white',
			dashed: false,
			side: 1
		});
		marks.push({
			boundaryIndex: group.hi + 1,
			color: edgeIsInner(lanes, group, 1) ? 'yellow' : 'white',
			dashed: false,
			side: -1
		});
		for (let k = group.lo + 1; k <= group.hi; k++) {
			marks.push({ boundaryIndex: k, color: 'white', dashed: true, side: 1 });
		}
	}
	return marks;
}

// Convenience for callers that want the marks keyed by boundary (a boundary can
// carry two — the double-yellow case).
export function marksByBoundary(lanes: Lane[]): Map<number, LaneMark[]> {
	const map = new Map<number, LaneMark[]>();
	for (const mark of classifyCrossSection(lanes)) {
		const list = map.get(mark.boundaryIndex) ?? [];
		list.push(mark);
		map.set(mark.boundaryIndex, list);
	}
	return map;
}

// Re-exported so the renderer and tests can share the travel-lane predicate.
export function isTravelLane(lane: Lane): boolean {
	return isTravel(lane);
}

export type { LaneDirection };
