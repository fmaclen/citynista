import type { ModeHandlers } from './types';
import type { Editor } from '../editor.svelte';
import type { Segment } from '../core/segment.svelte';
import type { Node } from '../core/node.svelte';
import { Graph } from '../core/graph.svelte';
import type { GraphData, Lane } from '../core/types';
import { cloneLanes, oneWay, reverseLanes } from '../core/lane-template';
import { splitSegment } from '../core/crossings';
import { outOf } from '../core/segment-curve';
import { closestOnRoad, nodePoint, roadAt, roadLine, shownOff, sideOf } from '../core/road-line';
import { carries } from '../core/lane-types';
import { attachShift, endAt, roadwayOf, sideToward } from '../core/attach';
import { attachDots, ghostCursor, roadGhost } from './ghost';
import type { OnWalkway } from '../core/place';
import { AT_ONE_SPOT, footpathScore, nodeHitAt, walkwayOf } from './picking';

const MIN_PREVIEW_LENGTH = 1;
// Snap radii are sized in screen pixels and converted to world units at the
// current zoom, so snapping feels the same at any zoom and zooming in lets
// clicks land between close nodes.
const SEGMENT_SNAP_PX = 17;
// Shift snaps the pending direction to 22.5° increments — or exactly onto
// the tangent of the road being extended when that is closer.
const ANGLE_SNAP_INCREMENT = Math.PI / 8;

interface SegmentSnap {
	segment: Segment;
	// On the segment's line, where the node it cuts goes.
	x: number;
	y: number;
	t: number;
	// On the road, where the cursor shows.
	shown: { x: number; y: number };
}

// A road's edge picked to attach a new road at (a ramp, a slip lane, one
// half of a split): where it is, and the road's direction there.
interface Edge {
	point: Pt;
	tangent: Pt;
	// The way across the road from its middle to this edge.
	across: Pt;
	// The way traffic runs in the road's outermost lane on this side; null
	// unless that lane is one-way.
	flow: Pt | null;
	// At a road's end (a node only it reaches), the way into the road.
	inward: Pt | null;
}

// Which way a new road's traffic runs at one of its nodes.
export type Way = 'leave' | 'arrive';

// The three places across a road a new road can attach at — one roadway
// edge, the middle, the other edge — and which one the cursor is over.
interface Attach {
	points: [Pt, Pt, Pt];
	live: 0 | 1 | 2;
	edges: [Edge, Edge];
}

interface Pt {
	x: number;
	y: number;
}

export type SnapResult =
	| { kind: 'node'; nodeId: string; x: number; y: number; edge: Edge | null; attach: Attach | null }
	| {
			kind: 'segment';
			snap: SegmentSnap;
			x: number;
			y: number;
			edge: Edge | null;
			attach: Attach | null;
	  }
	| { kind: 'free'; x: number; y: number }
	// A footpath's end put on a street's side: on the walkway under the
	// pointer as drawn (`walk`), a junction's corner included, or else the
	// street's walkway nearest or its curb (sideOf); a node of its own.
	| {
			kind: 'side';
			x: number;
			y: number;
			segmentId: string;
			walk?: Pick<OnWalkway, 'road' | 'lane' | 'corner'>;
	  };

// The edge a snap attaches at, if any.
export const edgeAt = (target: SnapResult) =>
	target.kind === 'node' || target.kind === 'segment' ? target.edge : null;

// Where a snap's marker stands: at the edge it attaches at, where a node
// it lands on shows, where a road it cuts shows, or at the point itself.
// The road laid still starts from the node itself.
export function markerAt(editor: Editor, target: SnapResult): Pt {
	const edge = edgeAt(target);
	if (edge) return edge.point;
	const node = target.kind === 'node' ? editor.graph.nodes.get(target.nodeId) : undefined;
	if (node) return nodePoint(editor.graph, node);
	return target.kind === 'segment' ? target.snap.shown : target;
}

// Near either edge of a road (its outer quarter on that side), a new road
// attaches at that edge; in between, at its middle.
const EDGE_REACH = 0.25;
// A roadway narrower than this on screen puts its edges too close to tell
// apart: only its middle attaches until you zoom in.
const EDGE_MIN_PX = 16;
// How far off the locked line (Shift) an end attached at an edge of a node
// may show and still end there (m).
const ON_LOCK = 0.001;

const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
export const unit = (from: Pt, to: Pt) => {
	const l = Math.hypot(to.x - from.x, to.y - from.y);
	return l > 1e-9 ? { x: (to.x - from.x) / l, y: (to.y - from.y) / l } : null;
};

// The way a new road's traffic must run at an edge to go with the lane
// there, `out` being its direction out of the node; null if the lane runs
// both ways. At a road's end: away from the node if the lane runs out of
// the road there, toward it if the lane runs in. Along a road (a node it
// carries on through): leaving the way the lane runs (a diverge), arriving
// against it (a merge). Meeting the lane square on, neither.
const wayAt = (edge: Edge, out: Pt): Way | null => {
	if (!edge.flow) return null;
	const k = edge.inward ? -dot(edge.flow, edge.inward) : dot(edge.flow, out);
	if (Math.abs(k) < 1e-9) return null;
	return k > 0 ? 'leave' : 'arrive';
};

// Intersection of ray (a + j·u) and ray (b + k·v), j,k > 0; null if parallel,
// behind a ray, or unreasonably far (a near-straight join curves gently instead).
const tangentIntersection = (
	ax: number,
	ay: number,
	ux: number,
	uy: number,
	bx: number,
	by: number,
	vx: number,
	vy: number
) => {
	const uv = ux * vy - uy * vx;
	if (Math.abs(uv) < 1e-6) return null;
	const ex = bx - ax;
	const ey = by - ay;
	const j = (ex * vy - ey * vx) / uv;
	const k = (ex * uy - ey * ux) / uv;
	if (j <= 0 || k <= 0) return null;
	const chord = Math.hypot(ex, ey);
	if (j > chord * 1.5 || k > chord * 1.5) return null;
	return { x: ax + ux * j, y: ay + uy * j };
};

// How a road of `lanes` snaps and connects, which drawing and a dead end
// dropped in select mode share, so the two connect alike: what lies under
// the pointer (a node or road of its kind, a street's side for a footpath,
// the edges a car road attaches at), turning that into a node (cutting a
// road there) and recording the edge an end attaches at, and whether a node
// takes one-way traffic arriving or leaving. `start`: the node the road
// leaves from, `free`: whether nothing snaps (Cmd or Ctrl held). `skip`: a
// node and road that snap to nothing (an end dragged and its own road),
// whose nodes and roads near the pointer are then found through the last
// build's grids (Networks.near), so a drag's snap costs what lies near it.
export function createSnapping(
	editor: Editor,
	lanes: () => readonly Lane[],
	start: () => string | null,
	free: () => boolean,
	skip: { node: string; segment: string } | null = null
) {
	const worldPerPixel = () => editor.sceneManager.worldPerPixel();
	// The nodes and roads a pointer at (x, y) may snap to.
	const around = (x: number, y: number) => {
		if (!skip)
			return { nodes: editor.graph.nodes.values(), segments: editor.graph.segments.values() };
		const r = Math.max(editor.nodeRingRadius(), SEGMENT_SNAP_PX * worldPerPixel());
		const found = editor.roadRenderer.near({ x0: x - r, y0: y - r, x1: x + r, y1: y + r });
		return {
			nodes: [...found.nodes].flatMap((id) => editor.graph.nodes.get(id) ?? []),
			segments: [...found.segments].flatMap((id) => editor.graph.segments.get(id) ?? [])
		};
	};
	// The road body under the cursor, or the node at its end when the cursor
	// is over the road's last stretch (within a node ring of the end, along
	// it): the whole width of a road's end reaches that node, so its edge
	// attach points are as easy to hit as its middle, and no sliver is cut.
	const findSegmentSnap = (worldX: number, worldZ: number) => {
		let best: SegmentSnap | null = null;
		let end: Node | null = null;
		// A footpath snaps to a street's side, never into it.
		let side: Segment | null = null;
		const car = brushCarries();
		// The road's whole width snaps, pixel-floored: a side road can start
		// anywhere on the road it joins.
		let bestScore = 1;
		const floor = SEGMENT_SNAP_PX * worldPerPixel();
		const endSnapDistance = editor.nodeRingRadius();

		for (const segment of around(worldX, worldZ).segments) {
			if (segment.id === skip?.segment) continue;
			const startNode = editor.graph.nodes.get(segment.startNodeId);
			const endNode = editor.graph.nodes.get(segment.endNodeId);
			if (!startNode || !endNode) continue;

			// Snapped where the road is drawn (offset and all); the node it
			// would cut goes on the segment's line, where nodes live.
			const near = closestOnRoad(editor.graph, segment, worldX, worldZ);
			const on = roadAt(editor.graph, segment, near.t);
			if (!on) continue;
			const closest = { ...on.line, t: near.t, distance: near.distance };
			const reach = Math.max(floor, segment.totalWidth / 2);
			const other = carries(segment.lanes) !== car;
			if (other && car) continue;
			// A footpath snaps where it shows (footpathScore), as it is picked.
			const score = carries(segment.lanes)
				? closest.distance / reach
				: footpathScore(editor, segment, { x: worldX, y: worldZ }, closest.distance / reach, reach);
			if (score === null || score >= bestScore) continue;

			bestScore = score;
			side = other ? segment : null;
			if (other) {
				best = null;
				end = null;
				continue;
			}
			// Its ends where it shows them (an end attached at an edge, there).
			const [a, b] = [0, 1].map((t) => roadAt(editor.graph, segment, t)?.line ?? closest);
			const toStart = Math.hypot(closest.x - a.x, closest.y - a.y);
			const toEnd = Math.hypot(closest.x - b.x, closest.y - b.y);
			if (Math.min(toStart, toEnd) < endSnapDistance) {
				best = null;
				end = toStart <= toEnd ? startNode : endNode;
				continue;
			}
			end = null;
			best = { segment, x: closest.x, y: closest.y, t: closest.t, shown: on.point };
		}

		return { snap: best, end, side };
	};

	// Whether the armed preset is a car road (core/lane-types.ts): it meets
	// only roads of its own kind.
	const brushCarries = () => carries(lanes());
	// Whether a node holds roads of the armed preset's kind only.
	const ownKind = (node: Node) => {
		const car = brushCarries();
		return node.connectedSegments.every(
			(id) => carries(editor.graph.segments.get(id)?.lanes ?? []) === car
		);
	};
	// A node of the armed preset's kind at a spot: one holding roads, or the
	// pending road's start.
	const ownNodeAt = (x: number, y: number) => {
		for (const node of around(x, y).nodes) {
			if (node.id === skip?.node) continue;
			const used = node.connectedSegments.length > 0 || node.id === start();
			if (used && ownKind(node) && Math.hypot(node.x - x, node.y - y) < AT_ONE_SPOT) return node;
		}
		return null;
	};
	// A footpath's end lands on a node of its own kind lying at the spot it
	// snapped to and showing there (the end shows where it lies; both within
	// AT_ONE_SPOT), whichever snap found it (a footpath put on that sidewalk
	// spot before, the start of the one pending, a Ctrl-click there), as on
	// any node: no two footpath nodes lie and show at one spot, and a path
	// drawn back to where it started closes. A node its footpaths show
	// shifted off keeps apart from the end.
	const landed = (target: SnapResult, x: number, y: number): SnapResult => {
		if (brushCarries() || (target.kind !== 'side' && target.kind !== 'free')) return target;
		const node = ownNodeAt(target.x, target.y);
		const off = node && shownOff(editor.graph, node);
		if (!node || !off || Math.hypot(off.x, off.y) >= AT_ONE_SPOT) return target;
		return nodeSnap(node, x, y);
	};

	// The attach points across a road at line parameter t, `middle` being
	// where its middle shows there; the live one is the part the cursor is
	// over (an edge within the outer quarter of the roadway on that side). A
	// footpath has none: it joins only at its line and nodes.
	const attachAt = (
		segment: Segment,
		t: number,
		middle: Pt,
		x: number,
		y: number,
		inward: Pt | null = null
	) => {
		if (!carries(segment.lanes)) return null;
		const at = roadAt(editor.graph, segment, t);
		if (!at) return null;
		const r = roadwayOf(segment.lanes);
		if (r.hi - r.lo < EDGE_MIN_PX * worldPerPixel()) return null;
		const vehicles = segment.lanes.filter((lane) => lane.role === 'vehicle');
		const edge = (o: number, k: 1 | -1, lane: Lane | undefined): Edge => ({
			point: { x: at.point.x + at.normal.x * o, y: at.point.y + at.normal.y * o },
			tangent: at.tangent,
			across: { x: at.normal.x * k, y: at.normal.y * k },
			flow:
				lane?.direction === 'forward'
					? at.tangent
					: lane?.direction === 'backward'
						? { x: -at.tangent.x, y: -at.tangent.y }
						: null,
			inward
		});
		const lo = edge(r.lo, -1, vehicles[0]);
		const hi = edge(r.hi, 1, vehicles.at(-1));
		const across = (x - at.point.x) * at.normal.x + (y - at.point.y) * at.normal.y;
		const reach = (r.hi - r.lo) * EDGE_REACH;
		const live = across <= r.lo + reach ? 0 : across >= r.hi - reach ? 2 : 1;
		const result: Attach = { points: [lo.point, middle, hi.point], live, edges: [lo, hi] };
		return result;
	};

	// The direction a road's shown line leaves one of its nodes in.
	const outOfNode = (segment: Segment, nodeId: string) => {
		const atStart = segment.startNodeId === nodeId;
		const at = roadAt(editor.graph, segment, atStart ? 0 : 1);
		if (!at) return null;
		return atStart ? at.tangent : { x: -at.tangent.x, y: -at.tangent.y };
	};

	const edgeOf = (attach: Attach | null) =>
		!attach || attach.live === 1 ? null : attach.edges[attach.live === 0 ? 0 : 1];

	// The attach points of the road a node ends or carries on; none at a
	// junction of three or more.
	const nodeAttach = (node: Node, x: number, y: number) => {
		const sides = node.junction?.sides ?? {};
		const mains = node.connectedSegments.filter((id) => !sides[id]);
		if (mains.length < 1 || mains.length > 2) return null;
		const segment = editor.graph.segments.get(mains[0]);
		if (!segment) return null;
		const t = segment.startNodeId === node.id ? 0 : 1;
		const inward = mains.length === 1 ? (outOfNode(segment, node.id) ?? null) : null;
		return attachAt(segment, t, nodePoint(editor.graph, node), x, y, inward);
	};

	// The snap onto a node, attaching at the edge of its road the pointer
	// at (x, y) is over, if any.
	const nodeSnap = (node: Node, x: number, y: number): SnapResult => {
		const attach = nodeAttach(node, x, y);
		return { kind: 'node', nodeId: node.id, x: node.x, y: node.y, edge: edgeOf(attach), attach };
	};
	// The snap cutting a road at `cut`, attaching at the edge `attach` picks.
	const segmentSnap = (cut: SegmentSnap, attach: Attach | null): SnapResult => ({
		kind: 'segment',
		snap: cut,
		x: cut.x,
		y: cut.y,
		edge: edgeOf(attach),
		attach
	});

	// `free`: Cmd (Ctrl elsewhere) held, nothing snaps.
	const resolveSnap = (worldX: number, worldZ: number, freeNow = free()): SnapResult => {
		if (freeNow) return landed({ kind: 'free', x: worldX, y: worldZ }, worldX, worldZ);

		// A node of the preset's kind snaps inside its ring, the same fixed
		// circle on screen that select mode clicks; outside it the road body
		// under the cursor snaps.
		const { node } = nodeHitAt(
			editor,
			worldX,
			worldZ,
			(n) => ownKind(n) && n.id !== skip?.node,
			around(worldX, worldZ).nodes
		);
		if (node) return nodeSnap(node, worldX, worldZ);

		// A footpath on a street's body, or off every road on a walkway a
		// street or its junction draws (a corner reaches past its streets'
		// bodies), snaps to the walkway under the pointer, else to the
		// street's walkway nearest or its curb.
		const { snap, end, side } = findSegmentSnap(worldX, worldZ);
		const under =
			side || (!brushCarries() && !snap && !end)
				? editor.roadRenderer.walkwayAt({ x: worldX, y: worldZ })
				: null;
		const segmentId = side?.id ?? under?.lane.road;
		const at =
			under?.middle ??
			(side &&
				sideOf(
					editor.graph,
					side,
					worldX,
					worldZ,
					editor.roadRenderer.derived?.spans.get(side.id)
				));
		// The walkway it lands on as drawn: the one under the pointer, or the
		// one drawn where the street's side puts it, which Shift's locked line
		// meets along its middle (onLockedLine).
		const walk = (under ?? (at && editor.roadRenderer.walkwayAt(at)))?.lane;
		if (segmentId && at) return landed({ kind: 'side', ...at, segmentId, walk }, worldX, worldZ);
		if (end) return nodeSnap(end, worldX, worldZ);
		if (snap) return segmentSnap(snap, attachAt(snap.segment, snap.t, snap.shown, worldX, worldZ));

		// Grid snap is the lowest-priority positional snap: nodes and segments win,
		// but on open ground the cursor lands on the nearest grid intersection.
		return landed({ kind: 'free', ...editor.gridPoint(worldX, worldZ) }, worldX, worldZ);
	};

	// Turn the snap into a node of `graph` to anchor the drawn segment:
	// existing node, a new node splitting the snapped segment (a T junction),
	// or a fresh node in open ground.
	const anchorIn = (graph: Graph, snap: SnapResult): string => {
		if (snap.kind === 'node') return snap.nodeId;

		const node = graph.createNode(snap.x, snap.y);
		if (graph === editor.graph) editor.nodeRenderer.createNode(node);

		if (snap.kind === 'segment') {
			const segment = graph.segments.get(snap.snap.segment.id);
			if (segment) splitSegment(graph, segment, snap.snap.t, node.id);
		}

		return node.id;
	};

	// Records a new road's end as attached at the edge picked there. The side
	// is stored against the road's own direction out of the node, curve and
	// all (core/attach.ts), so it is worked out once that curve is set.
	const attach = (graph: Graph, nodeId: string, segment: Segment, edge: Edge | null) => {
		const node = graph.nodes.get(nodeId);
		if (!edge || !node) return;
		const side = sideToward(graph, segment, nodeId, edge.across);
		if (!side) return;
		const sides = { ...(node.junction?.sides ?? {}), [segment.id]: side } as const;
		node.junction = { ...node.junction, sides };
	};

	// Whether a node can take a one-way road's traffic arriving at it (or
	// feed traffic leaving it): some vehicle lane there runs out of it (into
	// it), or both ways. A node with no vehicle lanes takes anything.
	const nodeTakes = (nodeId: string, way: Way) => {
		const node = editor.graph.nodes.get(nodeId);
		let any = false;
		for (const id of node?.connectedSegments ?? []) {
			const segment = editor.graph.segments.get(id);
			for (const lane of segment?.lanes ?? []) {
				if (lane.role !== 'vehicle') continue;
				any = true;
				if (lane.direction === 'bidirectional') return true;
				const out = (segment!.startNodeId === nodeId) === (lane.direction === 'forward');
				if (out === (way === 'arrive')) return true;
			}
		}
		return !any;
	};

	// Whether an end landing on `target`, its traffic there running `way`
	// (arriving or leaving) and the road leaving the target along `out`,
	// meets the traffic there head-on: at an edge, the lane it joins runs the
	// other way; at a node, no lane there takes it.
	const meetsHeadOn = (target: SnapResult, way: Way, out: Pt | null) => {
		const endEdge = edgeAt(target);
		return endEdge
			? !!out && (wayAt(endEdge, out) ?? way) !== way
			: target.kind === 'node' && !nodeTakes(target.nodeId, way);
	};

	// Whether an end landing on `target` would join two nodes a road of its
	// kind already joins from `from`: ending on a node such a road leads to,
	// or on such a road (cut there, its piece would be the one laid again).
	const retracesFrom = (from: string | null, target: SnapResult) =>
		from !== null &&
		(editor.graph.nodes.get(from)?.connectedSegments ?? []).some((id) => {
			const segment = editor.graph.segments.get(id);
			if (!segment || carries(segment.lanes) !== brushCarries()) return false;
			if (target.kind === 'segment') return target.snap.segment.id === id;
			const other = segment.startNodeId === from ? segment.endNodeId : segment.startNodeId;
			return target.kind === 'node' && target.nodeId === other;
		});

	return {
		brushCarries,
		ownKind,
		ownNodeAt,
		landed,
		attachAt,
		nodeSnap,
		segmentSnap,
		resolveSnap,
		anchorIn,
		attach,
		meetsHeadOn,
		retracesFrom
	};
}

export function setupDrawMode(editor: Editor): ModeHandlers {
	// Continuing from an existing endpoint anchors the first segment there.
	let startNodeId: string | null = editor.takeDrawAnchor();
	// Whether the first click cut a road to start from (undone on cancel).
	let cutForStart = false;
	// Where the start node was cut into a road, the click that cut it: a
	// footpath drawn from there with the brush switched starts on that road's
	// side nearest it (`startAt`).
	let cutAt: Pt | null = null;
	// Whether the start is a node the first click put on a street's side,
	// which Undo takes back alone (`undo`), and the editor offers Undo for
	// (Editor.holdsUndo).
	let sideStart = false;
	const holdSideStart = (on: boolean) => {
		sideStart = on;
		editor.holdsUndo(on);
	};
	// The edge the pending road starts from, if it attaches at one.
	let startEdge: Edge | null = null;
	// Whether the last road laid in this chain runs forward (one-way only):
	// the next one carries its traffic on.
	let chainForward: boolean | null = null;
	let shiftHeld = false;
	// Cmd (Ctrl elsewhere) held: no node, road or grid snapping.
	let freeHeld = false;
	// F mirrors the pending road's curve to the other side of its chord,
	// until the next click.
	let flipped = false;
	let lastWorld: { x: number; z: number } | null = null;

	const ghost = roadGhost(editor);
	const cursor = ghostCursor(editor);
	const dots = attachDots(editor);

	const {
		brushCarries,
		ownKind,
		ownNodeAt,
		landed,
		attachAt,
		nodeSnap,
		segmentSnap,
		resolveSnap,
		anchorIn,
		attach,
		meetsHeadOn,
		retracesFrom
	} = createSnapping(
		editor,
		() => editor.activeBrush?.lanes ?? [],
		() => startNodeId,
		() => freeHeld
	);

	// The brush switched to the other kind while the start is a node of the
	// first (a click on a street with the Street brush, then Path): the road
	// starts where a click of the brush armed now would have, the cut staying
	// where it is. Where the start cut a road, at the click that cut it (a
	// footpath on that street's sidewalk nearest it); else at the start node,
	// on a node of the brush's kind lying there, or one of its own.
	const switched = (): SnapResult | null => {
		const node = startNodeId !== null ? editor.graph.nodes.get(startNodeId) : undefined;
		if (!node || ownKind(node)) return null;
		if (cutAt) return resolveSnap(cutAt.x, cutAt.y, false);
		const own = ownNodeAt(node.x, node.y);
		if (!own) return { kind: 'free', x: node.x, y: node.y };
		return { kind: 'node', nodeId: own.id, x: own.x, y: own.y, edge: null, attach: null };
	};
	const startPoint = (): Pt | null =>
		switched() ?? (startNodeId !== null ? (editor.graph.nodes.get(startNodeId) ?? null) : null);
	const startEdgeNow = () => {
		const from = switched();
		return from ? edgeAt(from) : startEdge;
	};
	// The node the next click lays the pending road from: the start, or the
	// node of the brush's kind it starts at where the brush switched since,
	// none where that start is a node the click makes.
	const startNodeNow = () => {
		const from = switched();
		return from ? (from.kind === 'node' ? from.nodeId : null) : startNodeId;
	};

	// A footpath joins no two nodes a footpath already joins: ending on the
	// node a footpath from its start leads to, or on such a footpath (cut
	// there, its piece would be the one laid again), it lays nothing.
	const retraces = (target: SnapResult) => !brushCarries() && retracesFrom(startNodeNow(), target);

	// The direction a smooth continuation of the roads already attached to
	// the node would leave with, headed roughly toward the cursor. With
	// several neighbors the one closest to a straight-through continuation
	// of the pending chord wins.
	const continuationTangentAt = (
		nodeId: string,
		towardX: number,
		towardY: number
	): { x: number; y: number } | null => {
		const node = editor.graph.nodes.get(nodeId);
		// Only a road's free end carries on: a node in the middle of a road
		// (one just cut to start a side road) or a junction has no single way
		// to continue.
		if (!node || node.connectedSegments.length !== 1) return null;
		const chordLength = Math.hypot(towardX - node.x, towardY - node.y);
		if (chordLength < 0.0001) return null;
		const chordX = (towardX - node.x) / chordLength;
		const chordY = (towardY - node.y) / chordLength;

		let best: { x: number; y: number } | null = null;
		let bestDot = Infinity;
		for (const segmentId of node.connectedSegments) {
			const adjacent = editor.graph.segments.get(segmentId);
			const out = adjacent && outOf(editor.graph, adjacent, nodeId);
			if (!out) continue;
			const dot = out.x * chordX + out.y * chordY;
			if (dot < bestDot) {
				bestDot = dot;
				best = { x: -out.x, y: -out.y };
			}
		}
		return best;
	};

	const normalizeAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

	// Shift: snap the direction from the anchor to 22.5° steps, or exactly
	// onto the continuation tangent when that is the closer candidate.
	const angleSnap = (
		anchorX: number,
		anchorY: number,
		x: number,
		y: number,
		tangent: { x: number; y: number } | null
	) => {
		const dx = x - anchorX;
		const dy = y - anchorY;
		const distance = Math.hypot(dx, dy);
		if (distance < 0.0001) return { x, y };

		const angle = Math.atan2(dy, dx);
		let best = Math.round(angle / ANGLE_SNAP_INCREMENT) * ANGLE_SNAP_INCREMENT;
		if (tangent) {
			const tangentAngle = Math.atan2(tangent.y, tangent.x);
			if (Math.abs(normalizeAngle(angle - tangentAngle)) < Math.abs(normalizeAngle(angle - best))) {
				best = tangentAngle;
			}
		}
		return { x: anchorX + Math.cos(best) * distance, y: anchorY + Math.sin(best) * distance };
	};

	// Automatic curves put the control point on a continuation tangent ray
	// where it meets the chord's perpendicular bisector — an arc-like curve
	// that leaves the previous road without a kink. Too sharp an angle falls
	// back to straight.
	const smoothControl = (
		sx: number,
		sy: number,
		tangent: { x: number; y: number },
		ex: number,
		ey: number
	) => {
		const dx = ex - sx;
		const dy = ey - sy;
		const chord = Math.hypot(dx, dy);
		if (chord < 0.0001) return null;
		const along = dx * tangent.x + dy * tangent.y;
		if (along < chord * 0.1) return null;
		const reach = Math.min((chord * chord) / (2 * along), chord * 1.5);
		return { x: sx + tangent.x * reach, y: sy + tangent.y * reach };
	};

	// The curve's control point, mirrored across the chord when flipped.
	const solveControl = (startNode: { x: number; y: number }, target: SnapResult) => {
		const control = autoControl(startNode, target);
		if (!control || !flipped) return control;
		const dx = target.x - startNode.x;
		const dy = target.y - startNode.y;
		const k =
			((control.x - startNode.x) * dx + (control.y - startNode.y) * dy) / (dx * dx + dy * dy);
		const foot = { x: startNode.x + dx * k, y: startNode.y + dy * k };
		return { x: 2 * foot.x - control.x, y: 2 * foot.y - control.y };
	};

	function autoControl(startNode: { x: number; y: number }, target: SnapResult) {
		// The straight style lays every road straight, and so does Shift.
		if (shiftHeld || editor.drawStyle === 'straight') return null;
		// A road attached at an edge leaves it along the road it joins, the way
		// it is heading.
		const along = (
			edge: Edge,
			toward: { x: number; y: number },
			from: { x: number; y: number }
		) => {
			const k = (toward.x - from.x) * edge.tangent.x + (toward.y - from.y) * edge.tangent.y;
			return k >= 0 ? edge.tangent : { x: -edge.tangent.x, y: -edge.tangent.y };
		};
		const endEdge = edgeAt(target);
		const edge = startEdgeNow();
		const from = startNodeNow();
		const startTangent = edge
			? along(edge, target, startNode)
			: from
				? continuationTangentAt(from, target.x, target.y)
				: null;
		const endTangent = endEdge
			? along(endEdge, startNode, target)
			: target.kind === 'node'
				? continuationTangentAt(target.nodeId, startNode.x, startNode.y)
				: null;
		if (startTangent && endTangent) {
			const both = tangentIntersection(
				startNode.x,
				startNode.y,
				startTangent.x,
				startTangent.y,
				target.x,
				target.y,
				endTangent.x,
				endTangent.y
			);
			if (both) return both;
		}
		if (startTangent)
			return smoothControl(startNode.x, startNode.y, startTangent, target.x, target.y);
		if (endTangent) return smoothControl(target.x, target.y, endTangent, startNode.x, startNode.y);
		return null;
	}

	// Where the line from `a` along `d` meets the line `k` across a road's
	// shown line (right of it as drawn), curve and shift and all: the meeting
	// nearest `b`, and the road's line parameter there. Its distance from
	// the line is read along the road, each change of side narrowed down to
	// where it lies on the line.
	const offsetCrossing = (segment: Segment, k: number, a: Pt, d: Pt, b: Pt) => {
		const offset = (t: number) => {
			const on = roadAt(editor.graph, segment, t);
			return on && { x: on.point.x + on.normal.x * k, y: on.point.y + on.normal.y * k };
		};
		const side = (t: number) => {
			const p = offset(t);
			return p ? (p.x - a.x) * d.y - (p.y - a.y) * d.x : NaN;
		};
		const steps = segment.hasControlPoint ? 64 : 1;
		let best: { t: number; point: Pt; far: number } | null = null;
		for (let i = 0; i < steps; i++) {
			let [lo, hi] = [i / steps, (i + 1) / steps];
			let [slo, shi] = [side(lo), side(hi)];
			if (!(slo * shi <= 0)) continue;
			for (let n = 0; n < 48 && hi - lo > 1e-12; n++) {
				const mid = (lo + hi) / 2;
				const s = side(mid);
				if (slo * s <= 0) [hi, shi] = [mid, s];
				else [lo, slo] = [mid, s];
			}
			const t = Math.abs(slo) <= Math.abs(shi) ? lo : hi;
			const point = offset(t);
			if (!point) continue;
			const far = Math.hypot(point.x - b.x, point.y - b.y);
			if (!best || far < best.far) best = { t, point, far };
		}
		return best && { t: best.t, point: best.point };
	};

	// Where the pending road's start and end show laid to `target` (each
	// attached at its edge, core/attach.ts), read off a copy of the roads it
	// touches with the road laid there as a click lays it, straight as Shift
	// lays it.
	const laidTo = (target: SnapResult) => {
		const startNode = startPoint();
		if (startNodeId === null || !startNode) return null;
		const from = switched();
		const graph = new Graph();
		graph.fromJSON(touched(startNodeId, from, target));
		const start = from ? anchorIn(graph, from) : startNodeId;
		const { lanes } = plan(startNode, target, null);
		const { endId, segment } = layRoad(graph, start, target, null, lanes);
		const a = segment && endAt(graph, segment, start);
		const b = segment && endAt(graph, segment, endId);
		return a && b ? { a, b } : null;
	};

	// Where the locked line from `a` through `b` meets what a snap found: the
	// node it passes within the node ring of, the point it crosses a road's
	// line at (that road cut there, as its snap would), or the point it
	// crosses a street's sidewalk at. Null where it misses the target.
	const onLockedLine = (snap: SnapResult, a: Pt, b: Pt): SnapResult | null => {
		const l = Math.hypot(b.x - a.x, b.y - a.y);
		if (l < 1e-9) return null;
		const d = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
		// Where the locked line crosses the line through p along e.
		const meet = (p: Pt, e: Pt) => {
			const den = d.x * e.y - d.y * e.x;
			if (Math.abs(den) < 1e-9) return null;
			const k = ((p.x - a.x) * e.y - (p.y - a.y) * e.x) / den;
			return { x: a.x + d.x * k, y: a.y + d.y * k };
		};
		// Off the locked line by.
		const off = (p: Pt) => Math.abs((p.x - a.x) * d.y - (p.y - a.y) * d.x);
		if (snap.kind === 'node') {
			const node = editor.graph.nodes.get(snap.nodeId);
			if (!node || off(node) > editor.nodeRingRadius()) return null;
			// An end attached at an edge there shows off the node: the node
			// holds where that end lies on the locked line, and elsewhere the
			// line ends where it meets the road there, cut as its snap would.
			const end = snap.edge && laidTo(snap)?.b;
			if (!end || off(end) <= ON_LOCK) return snap;
			for (const id of editor.graph.nodes.get(snap.nodeId)?.connectedSegments ?? []) {
				const road = editor.graph.segments.get(id);
				const near = road && closestOnRoad(editor.graph, road, end.x, end.y);
				const on = road && near && roadAt(editor.graph, road, near.t);
				const attach = road && on && attachAt(road, near.t, on.point, end.x, end.y);
				if (!road || !on || !attach) continue;
				const cut = { segment: road, x: on.line.x, y: on.line.y, t: near.t, shown: on.point };
				const found = onLockedLine(segmentSnap(cut, attach), a, b);
				if (found) return found;
			}
			return null;
		}
		if (snap.kind === 'free') return null;
		const segmentId = snap.kind === 'segment' ? snap.snap.segment.id : snap.segmentId;
		const segment = editor.graph.segments.get(segmentId);
		if (!segment) return null;
		// On a walkway (the one the snap lands on as drawn, the pointer over
		// it or over the street's asphalt), where the line crosses the
		// walkway's own middle as drawn nearest `b`: a street's sidewalk and
		// the corners it runs into, or a corner and the streets' sidewalks it
		// joins (walkwayOf), so the end lies on the line and on the walkway,
		// straight or curved. Landing on no walkway, where it crosses the way
		// along the road the snap lies on, the curb (sideOf), at its way
		// across.
		if (snap.kind === 'side') {
			const lines = (snap.walk && walkwayOf(editor, snap.walk)?.lines) || [];
			let best: { p: Pt; far: number } | null = null;
			for (const line of lines)
				for (let k = 1; k < line.length; k++) {
					const [p, q] = [line[k - 1], line[k]];
					const e = { x: q.x - p.x, y: q.y - p.y };
					const hit = meet(p, e);
					const f =
						hit && ((hit.x - p.x) * e.x + (hit.y - p.y) * e.y) / (e.x * e.x + e.y * e.y || 1);
					if (!hit || f === null || f < 0 || f > 1) continue;
					const far = Math.hypot(hit.x - b.x, hit.y - b.y);
					if (!best || far < best.far) best = { p: hit, far };
				}
			if (lines.length) return best && landed({ ...snap, ...best.p }, best.p.x, best.p.y);
			const at = roadAt(
				editor.graph,
				segment,
				closestOnRoad(editor.graph, segment, snap.x, snap.y).t
			);
			const across =
				at && (snap.x - at.point.x) * at.normal.x + (snap.y - at.point.y) * at.normal.y;
			const hit = at && across !== null && offsetCrossing(segment, across, a, d, b);
			return hit ? landed({ ...snap, ...hit.point }, hit.point.x, hit.point.y) : null;
		}
		// The crossing of the road's shown line nearest the angle-snapped point.
		const line = roadLine(editor.graph, segment);
		let best: { t: number; p: Pt; far: number } | null = null;
		for (let k = 1; k < line.length; k++) {
			const [p, q] = [line[k - 1], line[k]];
			const e = { x: q.x - p.x, y: q.y - p.y };
			const hit = meet(p, e);
			if (!hit) continue;
			const f = ((hit.x - p.x) * e.x + (hit.y - p.y) * e.y) / (e.x * e.x + e.y * e.y || 1);
			if (f < 0 || f > 1) continue;
			const far = Math.hypot(hit.x - b.x, hit.y - b.y);
			if (!best || far < best.far) best = { t: p.t + (q.t - p.t) * f, p: hit, far };
		}
		if (!best) return null;
		// The snap there cut at t, attaching at the edge the pointer is over.
		// Within a node ring of a node the road is drawn ending at (any but
		// one it only carries on through, Derived.through) it is cut nowhere,
		// as an unlocked click there cuts nothing (findSegmentSnap): a piece
		// that short between two nodes is drawn as no road can be, so the
		// click joins that node of the road, as an unlocked click on the road
		// there does, its end off the locked line; never another road's node
		// lying by it.
		const cutThere = (t: number, at: Pt): SnapResult | null => {
			const on = roadAt(editor.graph, segment, t);
			if (!on) return null;
			const ring = editor.nodeRingRadius();
			const nearEnd = ([segment.startNodeId, segment.endNodeId] as const).find((id, k) => {
				const end = !editor.roadRenderer.derived?.through(id) && roadAt(editor.graph, segment, k);
				return !!end && Math.hypot(end.line.x - on.line.x, end.line.y - on.line.y) < ring;
			});
			const node = nearEnd !== undefined && editor.graph.nodes.get(nearEnd);
			if (node) return nodeSnap(node, at.x, at.y);
			const cut = { segment, x: on.line.x, y: on.line.y, t, shown: on.point };
			const attach = attachAt(segment, t, on.point, at.x, at.y);
			if (attach && snap.attach) attach.live = snap.attach.live;
			return segmentSnap(cut, attach);
		};
		if (!snap.edge || !snap.attach || snap.attach.live === 1) return cutThere(best.t, best.p);
		// Over an edge the snap attaches at, the end lands on the locked line
		// where it shows once attached there: a fixed way across from the
		// road's shown line (that edge, moved by how the end attaches, read off
		// the end laid at the last guess), found again until it holds.
		const r = roadwayOf(segment.lanes);
		let k = snap.attach.live === 0 ? r.lo : r.hi;
		let found: SnapResult | null = null;
		for (let pass = 0; pass < 4; pass++) {
			const hit = offsetCrossing(segment, k, a, d, b);
			const target = hit && cutThere(hit.t, hit.point);
			if (!hit || !target) return found;
			if (target.kind !== 'segment') return target;
			found = target;
			const end = laidTo(target)?.b;
			const on = roadAt(editor.graph, segment, hit.t);
			if (!end || !on) break;
			const across = (end.x - on.point.x) * on.normal.x + (end.y - on.point.y) * on.normal.y;
			if (Math.abs(across - k) < 1e-6) break;
			k = across;
		}
		return found;
	};

	// Where the next click would land: a positional snap (a node, a road),
	// or with Shift held from an anchor, the direction locked to the angle
	// snap and the end where that line meets the snap's target, a click
	// there connecting as the snap would; on open ground, along the line.
	const resolveTarget = (worldX: number, worldZ: number): SnapResult => {
		const snap = resolveSnap(worldX, worldZ);
		if (!shiftHeld || startNodeId === null) return snap;

		const startNode = startPoint();
		if (!startNode) return snap;

		// The lock runs from the start as drawn (attached at an edge, it shows
		// off its node, by how much the way the road leaves it decides), read
		// off the road laid to the last guess until it holds.
		const anchor = startNodeNow();
		const tangent = anchor ? continuationTangentAt(anchor, worldX, worldZ) : null;
		let from: Pt = startNode;
		let target: SnapResult = snap;
		for (let pass = 0; pass < 4; pass++) {
			const snapped = angleSnap(from.x, from.y, worldX, worldZ, tangent);
			const free: SnapResult = { kind: 'free', x: snapped.x, y: snapped.y };
			target = snap.kind === 'free' ? free : (onLockedLine(snap, from, snapped) ?? free);
			if (!startEdgeNow()) break;
			const drawn = laidTo(target)?.a;
			if (!drawn || Math.hypot(drawn.x - from.x, drawn.y - from.y) < 1e-6) break;
			from = drawn;
		}
		return target;
	};

	// Which way the traffic at a node runs: all of its vehicle lanes into it
	// ('arrive'), all out of it ('leave'), or null for both ways or none.
	const nodeFlow = (nodeId: string): Way | null => {
		let arrive = false;
		let leave = false;
		for (const id of editor.graph.nodes.get(nodeId)?.connectedSegments ?? []) {
			const segment = editor.graph.segments.get(id);
			for (const lane of segment?.lanes ?? []) {
				if (lane.role !== 'vehicle') continue;
				if (lane.direction === 'bidirectional') return null;
				if ((segment!.startNodeId === nodeId) === (lane.direction === 'forward')) leave = true;
				else arrive = true;
			}
		}
		return arrive === leave ? null : arrive ? 'arrive' : 'leave';
	};

	// The pending road's lanes and whether its traffic runs forward (null:
	// both ways). A one-way preset started at an edge runs with the lane it
	// starts on, turned round for this road if it must; one carrying a chain
	// on runs as the road before it; one started at a node whose traffic all
	// runs one way carries it on (away if it arrives, toward if it leaves);
	// anywhere else it runs the way it is drawn.
	// `blocked`: it ends at an edge or node whose traffic would meet it
	// head-on, or it retraces a footpath, and the click lays nothing.
	const plan = (startNode: Pt, target: SnapResult, control: Pt | null) => {
		const preset = editor.activeBrush?.lanes ?? [];
		const dir = oneWay(preset);
		if (!dir) return { lanes: cloneLanes(preset), forward: null, blocked: retraces(target) };
		const outStart = unit(startNode, control ?? target);
		const outEnd = unit(target, control ?? startNode);
		const edge = startEdgeNow();
		const start = edge && outStart ? wayAt(edge, outStart) : null;
		const anchor = startNodeNow();
		const flow = start === null && chainForward === null && anchor ? nodeFlow(anchor) : null;
		const forward =
			start !== null
				? start === 'leave'
				: (chainForward ?? (flow ? flow === 'arrive' : dir === 'forward'));
		// At its end node, traffic arrives if it runs forward, else leaves.
		const way: Way = forward ? 'arrive' : 'leave';
		const blocked = retraces(target) || meetsHeadOn(target, way, outEnd);
		const lanes = forward === (dir === 'forward') ? cloneLanes(preset) : reverseLanes(preset);
		return { lanes, forward, blocked };
	};

	// Lays the pending road into `graph` as a click lays it: its end node
	// (cutting a road under it), the road, the edges its ends attach at, and
	// its curve. Null for the road where it would start and end on one node.
	const layRoad = (
		graph: Graph,
		startId: string,
		target: SnapResult,
		control: Pt | null,
		lanes: Lane[]
	) => {
		const endId = anchorIn(graph, target);
		if (startId === endId) return { endId, segment: null };
		const segment = graph.createSegment(startId, endId, lanes);
		if (control) segment.setControlPoint(control.x, control.y);
		attach(graph, startId, segment, startEdgeNow());
		attach(graph, endId, segment, edgeAt(target));
		// An end moved to the edge it attaches at takes the curve's handle
		// with it, so the road still leaves that edge along it.
		if (control) {
			const a = attachShift(graph, segment, segment.startNodeId);
			const b = attachShift(graph, segment, segment.endNodeId);
			segment.setControlPoint(control.x + a.x + b.x, control.y + a.y + b.y);
		}
		return { endId, segment };
	};

	// The part of the map the pending road touches: the nodes it starts and
	// ends at (`from`, where the brush switched since), the roads it would
	// cut, and every road at those nodes, so the preview builds the joints
	// there as the click will.
	const touched = (startId: string, from: SnapResult | null, target: SnapResult): GraphData => {
		const graph = editor.graph;
		const ends = [from, target];
		const nodeIds = new Set([startId]);
		for (const t of ends) if (t?.kind === 'node') nodeIds.add(t.nodeId);
		const segmentIds = new Set(
			ends.flatMap((t) => (t?.kind === 'segment' ? [t.snap.segment.id] : []))
		);
		for (const id of nodeIds)
			for (const s of graph.nodes.get(id)?.connectedSegments ?? []) segmentIds.add(s);
		const segments = [...segmentIds].flatMap((id) => graph.segments.get(id) ?? []);
		for (const s of segments) nodeIds.add(s.startNodeId).add(s.endNodeId);
		return {
			nodes: [...nodeIds].flatMap((id) => graph.nodes.get(id)?.toJSON() ?? []),
			segments: segments.map((s) => s.toJSON())
		};
	};

	// The first click, or a click of the brush switched since (`switched`):
	// the pending road starts at `target`, a road under it cut there and saved,
	// as a cut always is.
	const startAt = (target: SnapResult, click: Pt) => {
		startNodeId = anchorIn(editor.graph, target);
		startEdge = edgeAt(target);
		chainForward = null;
		cutForStart = target.kind === 'segment';
		cutAt = cutForStart ? click : null;
		holdSideStart(target.kind === 'side');
		if (cutForStart) {
			editor.rebuildRoads();
			editor.graph.save();
		}
	};

	const discardOrphanStart = () => {
		startEdge = null;
		chainForward = null;
		cutAt = null;
		holdSideStart(false);
		if (startNodeId === null) return;
		// A road cut to start from, with nothing drawn from it: uncut it.
		if (cutForStart) {
			cutForStart = false;
			startNodeId = null;
			editor.discardLastEdit();
			return;
		}

		const node = editor.graph.nodes.get(startNodeId);
		if (node && node.connectedSegments.length === 0) {
			editor.nodeRenderer.removeNode(node.id);
			editor.graph.deleteNode(node.id);
			editor.graph.save();
		}
		startNodeId = null;
	};

	const updatePreview = (worldX: number, worldZ: number) => {
		const target = resolveTarget(worldX, worldZ);

		cursor.place(markerAt(editor, target), target.kind !== 'free');
		// What the click attaches to: the node or road lit as if hovered, and
		// across the road the three attach points with the live one filled.
		editor.setHoveredNode(target.kind === 'node' ? target.nodeId : null);
		editor.setHoveredSegment(
			target.kind === 'segment'
				? target.snap.segment.id
				: target.kind === 'side'
					? target.segmentId
					: null
		);
		if ((target.kind === 'node' || target.kind === 'segment') && target.attach) {
			dots.show(target.attach.points, target.attach.live);
		} else {
			dots.hide();
		}

		const startNode = startPoint();
		if (!startNode) {
			ghost.clear();
			return;
		}

		if (Math.hypot(target.x - startNode.x, target.y - startNode.y) < MIN_PREVIEW_LENGTH) {
			ghost.clear();
			return;
		}

		const control = solveControl(startNode, target);
		const { lanes, forward, blocked } = plan(startNode, target, control);
		const from = switched();
		const startId = startNodeId!;
		let arrow: { at: Pt; dir: Pt } | null = null;
		ghost.show(
			(graph) => {
				const start = from ? anchorIn(graph, from) : startId;
				const { endId, segment } = layRoad(graph, start, target, control, cloneLanes(lanes));
				const mid = segment && forward !== null ? roadAt(graph, segment, 0.5) : null;
				if (mid) {
					const k = forward ? 1 : -1;
					arrow = { at: mid.point, dir: { x: mid.tangent.x * k, y: mid.tangent.y * k } };
				}
				return { roads: segment ? [segment.id] : [], nodes: [start, endId] };
			},
			touched(startId, from, target)
		);
		ghost.point(arrow);
		ghost.block(blocked);
	};

	const onMouseDown = (event: MouseEvent) => {
		if (event.button !== 0) return;
		if (event.altKey) return;
		shiftHeld = event.shiftKey;
		freeHeld = event.metaKey || event.ctrlKey;

		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		lastWorld = { x: worldPos.x, z: worldPos.z };
		const click = { x: worldPos.x, y: worldPos.z };
		// The brush switched since the start: it starts anew where this brush
		// would have, and the road is laid from there.
		const from = switched();
		if (from) startAt(from, cutAt ?? click);
		const target = resolveTarget(worldPos.x, worldPos.z);

		if (startNodeId === null) {
			startAt(target, click);
		} else {
			const startNode = editor.graph.nodes.get(startNodeId);
			if (!startNode) return;
			const control = solveControl(startNode, target);
			const { lanes, forward, blocked } = plan(startNode, target, control);
			if (blocked) return;
			const { endId: endNodeId, segment } = layRoad(
				editor.graph,
				startNodeId,
				target,
				control,
				lanes
			);
			if (segment) editor.resolveSegmentCrossings([segment.id]);

			editor.rebuildRoads();
			// A start is no edit until a road is laid from it: a click laying
			// none (on the start itself) records nothing.
			if (segment) editor.graph.save();
			// A footpath laid over footpaths already there is taken out, and its
			// end with it where nothing else holds it: the chain ends there.
			startNodeId = editor.graph.nodes.has(endNodeId) ? endNodeId : null;
			startEdge = null;
			chainForward = forward;
			cutForStart = false;
			if (segment) {
				cutAt = target.kind === 'segment' ? click : null;
				holdSideStart(false);
			}
			ghost.clear();
		}
		flipped = false;

		updatePreview(worldPos.x, worldPos.z);
	};

	const onMouseMove = (event: MouseEvent) => {
		shiftHeld = event.shiftKey;
		freeHeld = event.metaKey || event.ctrlKey;
		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		lastWorld = { x: worldPos.x, z: worldPos.z };
		updatePreview(worldPos.x, worldPos.z);
	};

	// Shift (the angle lock) or Cmd/Ctrl (no snapping) pressed or let go
	// changes what the next click lays, which reads them off its own event:
	// the preview is drawn again from where the pointer last was.
	const modifiers = (event: KeyboardEvent) => {
		if (event.key !== 'Shift' && event.key !== 'Meta' && event.key !== 'Control') return false;
		shiftHeld = event.shiftKey;
		freeHeld = event.metaKey || event.ctrlKey;
		refresh();
		return true;
	};

	// Escape unwinds one stage at a time: pending segment, then draw mode itself.
	const onKeyDown = (event: KeyboardEvent) => {
		if (modifiers(event)) return;
		if (event.key.toLowerCase() === 'f' && !event.metaKey && !event.ctrlKey) {
			if (startNodeId === null || !lastWorld || editor.drawStyle === 'straight') return;
			flipped = !flipped;
			updatePreview(lastWorld.x, lastWorld.z);
			return;
		}
		if (event.key !== 'Escape') return;

		flipped = false;
		if (startNodeId !== null) {
			discardOrphanStart();
			ghost.clear();
		} else {
			editor.mode = 'select';
		}
	};

	const cleanup = () => {
		discardOrphanStart();
		ghost.destroy();
		cursor.destroy();
		dots.destroy();
	};

	const refresh = () => {
		if (lastWorld) updatePreview(lastWorld.x, lastWorld.z);
	};

	// Undo at a start put on a street's side takes back that start alone,
	// before anything in the history.
	const undo = () => {
		if (!sideStart) return false;
		discardOrphanStart();
		ghost.clear();
		refresh();
		return true;
	};

	return {
		onMouseDown,
		onMouseMove,
		onKeyDown,
		onKeyUp: modifiers,
		refresh,
		undo,
		cleanup
	};
}
