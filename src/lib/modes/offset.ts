// The lateral offset handle: with one road selected, a handle sits on the
// road as it shows, a quarter of the way along. Dragging it across slides
// the road sideways, parallel to where it was. Each end goes its own way:
// - at a node of one or two roads the node itself moves (as if the road were
//   dragged there, so a road carrying on bends to follow) and that end's
//   shift folds into it, leaving 0;
// - at a junction of three or more (or one attaching roads at an edge) the
//   node stays and that end keeps a shift (`offsetStart`/`offsetEnd`), so
//   the lanes still line up across the junction.
// With Shift held the drag snaps to where a junction end is centred, or to
// where its kerb or outer edge on one side lines up with a road carrying on
// from it there.

import type { Editor } from '../editor.svelte';
import type { Segment } from '../core/segment.svelte';
import { segmentEnds } from '../core/attach';
import { offsetAt, roadAt, shownAt, type Pt } from '../core/road-line';

export interface OffsetHandle {
	segmentId: string;
	// Where the handle shows, and the road's right normal there.
	point: Pt;
	normal: Pt;
}

type EndName = 'start' | 'end';

interface EndAtStart {
	end: EndName;
	nodeId: string;
	// Whether the node moves with the road (one or two roads there).
	free: boolean;
	node: Pt;
	shift: number;
	// The drawn line there: its point, its right normal, and the way it
	// heads into the road (toward the control point).
	at: Pt;
	n: Pt;
	into: Pt;
}

export interface OffsetDrag {
	segmentId: string;
	grab: Pt;
	normal: Pt;
	ends: EndAtStart[];
	control: Pt | null;
	// Other roads' control points at a moving node, kept in their own frame
	// (along and across from their start to their end) so they bend with it.
	frames: Map<string, { u: number; v: number }>;
	// Shifts of the drag worth snapping to.
	snaps: number[];
}

// Where along the line the handle sits (the curvature handle has the middle).
const AT = 0.25;
// A junction end's shift grows by 1 / cos of how far its road turned, so the
// road stays parallel; never by more than this.
const MAX_STRETCH = 2;

export function offsetHandle(editor: Editor): OffsetHandle | null {
	if (editor.selectedSegments.size !== 1 || editor.selectedNodes.size > 0) return null;
	const segment = editor.graph.segments.get([...editor.selectedSegments][0]);
	const at = segment && roadAt(editor.graph, segment, AT);
	if (!segment || !at) return null;
	return { segmentId: segment.id, point: at.point, normal: at.normal };
}

// A segment's outer edges and kerbs, across it from its own centre.
function edges(segment: Segment) {
	const total = segment.lanes.reduce((sum, l) => sum + l.width, 0);
	let x = -total / 2;
	let lo = Infinity;
	let hi = -Infinity;
	for (const lane of segment.lanes) {
		if (lane.role === 'vehicle') {
			lo = Math.min(lo, x);
			hi = Math.max(hi, x + lane.width);
		}
		x += lane.width;
	}
	const outer = { lo: -total / 2, hi: total / 2 };
	return { outer, kerb: lo <= hi ? { lo, hi } : outer };
}

// Shifts worth snapping one junction end to: centred, and those that line
// this road's kerb or outer edge up with the same edge of a road carrying on
// from it there, on either side.
function snapTargets(editor: Editor, segment: Segment, end: EndAtStart) {
	const targets = [0];
	const mine = edges(segment);
	const node = editor.graph.nodes.get(end.nodeId);
	if (!node) return targets;
	for (const id of node.connectedSegments) {
		if (id === segment.id) continue;
		const other = editor.graph.segments.get(id);
		const there = other && roadAt(editor.graph, other, other.startNodeId === node.id ? 0 : 1);
		if (!other || !there) continue;
		// Only roads carrying on from this one line up with it.
		const dot = end.n.x * there.normal.x + end.n.y * there.normal.y;
		if (Math.abs(dot) < 0.9) continue;
		const theirs = edges(other);
		const shift = offsetAt(other, other.startNodeId === node.id ? 'start' : 'end');
		// Their edges across this road, nearest-side first.
		const across = (lo: number, hi: number) => {
			const a = (lo + shift) * dot;
			const b = (hi + shift) * dot;
			return { lo: Math.min(a, b), hi: Math.max(a, b) };
		};
		for (const key of ['outer', 'kerb'] as const) {
			const e = across(theirs[key].lo, theirs[key].hi);
			targets.push(e.lo - mine[key].lo, e.hi - mine[key].hi);
		}
	}
	return targets;
}

// A node moves with the road unless it is a junction of three or more, or
// attaches roads at an edge.
function movesWithRoad(editor: Editor, nodeId: string) {
	const node = editor.graph.nodes.get(nodeId);
	if (!node) return false;
	const sides = Object.keys(node.junction?.sides ?? {}).length;
	return node.connectedSegments.length <= 2 && !sides;
}

// Takes hold of the handle: what the road and its ends were at the start, so
// every pointer move is measured from there.
export function beginOffsetDrag(
	editor: Editor,
	handle: OffsetHandle,
	x: number,
	y: number
): OffsetDrag | null {
	const segment = editor.graph.segments.get(handle.segmentId);
	const drawn = segment && segmentEnds(editor.graph, segment);
	if (!segment || !drawn || segment.startNodeId === segment.endNodeId) return null;
	const control = segment.hasControlPoint ? { x: segment.controlX!, y: segment.controlY! } : null;
	const c = control ?? { x: (drawn.a.x + drawn.b.x) / 2, y: (drawn.a.y + drawn.b.y) / 2 };
	const ends: EndAtStart[] = [];
	for (const end of ['start', 'end'] as const) {
		const nodeId = end === 'start' ? segment.startNodeId : segment.endNodeId;
		const node = editor.graph.nodes.get(nodeId);
		if (!node) return null;
		const at = end === 'start' ? drawn.a : drawn.b;
		const frame = shownAt(segment, drawn.a, drawn.b, end === 'start' ? 0 : 1);
		const l = Math.hypot(c.x - at.x, c.y - at.y) || 1;
		ends.push({
			end,
			nodeId,
			free: movesWithRoad(editor, nodeId),
			node: { x: node.x, y: node.y },
			shift: offsetAt(segment, end),
			at,
			n: frame.normal,
			into: { x: (c.x - at.x) / l, y: (c.y - at.y) / l }
		});
	}
	const frames = new Map<string, { u: number; v: number }>();
	for (const end of ends) {
		if (!end.free) continue;
		for (const id of editor.graph.nodes.get(end.nodeId)?.connectedSegments ?? []) {
			const other = editor.graph.segments.get(id);
			const a = other && editor.graph.nodes.get(other.startNodeId);
			const b = other && editor.graph.nodes.get(other.endNodeId);
			if (!other || !a || !b || id === segment.id || !other.hasControlPoint) continue;
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const l2 = dx * dx + dy * dy;
			if (l2 < 1e-4) continue;
			const rx = other.controlX! - a.x;
			const ry = other.controlY! - a.y;
			frames.set(id, { u: (rx * dx + ry * dy) / l2, v: (dx * ry - dy * rx) / l2 });
		}
	}
	const snaps = ends
		.filter((e) => !e.free)
		.flatMap((e) => snapTargets(editor, segment, e).map((t) => t - e.shift));
	return {
		segmentId: segment.id,
		grab: { x, y },
		normal: handle.normal,
		ends,
		control,
		frames,
		snaps
	};
}

// Where two lines (a point and a direction each) cross, if they do.
function meet(p: Pt, d: Pt, q: Pt, e: Pt) {
	const det = d.x * e.y - d.y * e.x;
	if (Math.abs(det) < 1e-6) return null;
	const s = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / det;
	return { x: p.x + d.x * s, y: p.y + d.y * s };
}

// Moves the road `by` metres to the right of where it was when the drag
// began. Returns the nodes moved.
function shiftRoad(editor: Editor, drag: OffsetDrag, by: number) {
	const segment = editor.graph.segments.get(drag.segmentId);
	if (!segment) return [];
	const moved: string[] = [];
	// How far each end's drawn point moves across its road.
	const across = drag.ends.map((e) => (e.free ? e.shift + by : 0));
	for (const [i, e] of drag.ends.entries()) {
		const node = editor.graph.nodes.get(e.nodeId);
		if (!node || !e.free) continue;
		node.x = e.node.x + e.n.x * across[i];
		node.y = e.node.y + e.n.y * across[i];
		moved.push(node.id);
	}
	// The curve keeps the way it heads out of each end: its control point
	// goes where those two lines, each moved with its end, now cross.
	if (drag.control) {
		const [a, b] = drag.ends.map((e, i) => ({
			x: e.at.x + e.n.x * across[i],
			y: e.at.y + e.n.y * across[i]
		}));
		const c = meet(a, drag.ends[0].into, b, drag.ends[1].into) ?? {
			x: drag.control.x + (a.x - drag.ends[0].at.x + (b.x - drag.ends[1].at.x)) / 2,
			y: drag.control.y + (a.y - drag.ends[0].at.y + (b.y - drag.ends[1].at.y)) / 2
		};
		segment.setControlPoint(c.x, c.y);
	}
	for (const [id, f] of drag.frames) {
		const other = editor.graph.segments.get(id);
		const a = other && editor.graph.nodes.get(other.startNodeId);
		const b = other && editor.graph.nodes.get(other.endNodeId);
		if (!other || !a || !b) continue;
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		other.setControlPoint(a.x + f.u * dx - f.v * dy, a.y + f.u * dy + f.v * dx);
	}
	// A junction end keeps its shift, grown by the drag; where the road turned
	// (its far end moved and it is straight) it grows a little more, so the
	// road still shows parallel to where it was.
	const drawn = segmentEnds(editor.graph, segment);
	for (const e of drag.ends) {
		let shift = 0;
		if (!e.free) {
			const now = drawn && shownAt(segment, drawn.a, drawn.b, e.end === 'start' ? 0 : 1);
			const cos = now ? now.normal.x * e.n.x + now.normal.y * e.n.y : 1;
			shift = (e.shift + by) / Math.max(1 / MAX_STRETCH, cos);
		}
		if (e.end === 'start') segment.offsetStart = shift;
		else segment.offsetEnd = shift;
	}
	return moved;
}

// Follows the pointer: the road moves across by how far the pointer has
// moved across it since the drag began (to a tenth of a metre), or, with
// Shift, by the nearest snap. Returns the nodes moved.
export function dragOffset(editor: Editor, drag: OffsetDrag, x: number, y: number, snap: boolean) {
	const raw = (x - drag.grab.x) * drag.normal.x + (y - drag.grab.y) * drag.normal.y;
	const by =
		snap && drag.snaps.length
			? drag.snaps.reduce((best, t) => (Math.abs(t - raw) < Math.abs(best - raw) ? t : best))
			: Math.round(raw * 10) / 10;
	return shiftRoad(editor, drag, by);
}
