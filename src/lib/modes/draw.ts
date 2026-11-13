import type { ModeHandlers } from './types';
import type { Editor } from '../editor.svelte';
import type { Segment } from '../core/segment.svelte';
import type { Node } from '../core/node.svelte';
import type { Graph } from '../core/graph.svelte';
import type { GraphData, Lane } from '../core/types';
import { cloneLanes, reverseLanes } from '../core/lane-template';
import { splitSegment } from '../core/crossings';
import { getQuadraticBezierTangent } from '../geometry/bezier';
import { closestOnRoad, nodePoint, roadAt } from '../core/road-line';
import { attachShift, roadwayOf, sideToward } from '../core/attach';
import { attachDots, ghostCursor, roadGhost } from './ghost';

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
type Way = 'leave' | 'arrive';

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

type SnapResult =
	| { kind: 'node'; nodeId: string; x: number; y: number; edge: Edge | null; attach: Attach | null }
	| {
			kind: 'segment';
			snap: SegmentSnap;
			x: number;
			y: number;
			edge: Edge | null;
			attach: Attach | null;
	  }
	| { kind: 'free'; x: number; y: number };

// Near either edge of a road (its outer quarter on that side), a new road
// attaches at that edge; in between, at its middle.
const EDGE_REACH = 0.25;
// A roadway narrower than this on screen puts its edges too close to tell
// apart: only its middle attaches until you zoom in.
const EDGE_MIN_PX = 16;

const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const unit = (from: Pt, to: Pt) => {
	const l = Math.hypot(to.x - from.x, to.y - from.y);
	return l > 1e-9 ? { x: (to.x - from.x) / l, y: (to.y - from.y) / l } : null;
};

// The way a new road's traffic must run at an edge to go with the lane
// there, `out` being its direction out of the node; null if the lane runs
// both ways. At a road's end: away from the node if the lane runs out of
// the road there, toward it if the lane runs in. Along a road (a node it
// carries on through): leaving the way the lane runs (a diverge), arriving
// against it (a merge).
const wayAt = (edge: Edge, out: Pt): Way | null => {
	if (!edge.flow) return null;
	const k = edge.inward ? -dot(edge.flow, edge.inward) : dot(edge.flow, out);
	return k >= 0 ? 'leave' : 'arrive';
};

// The one way a cross-section's vehicle lanes all run, if they all run one.
const oneWay = (lanes: Lane[]) => {
	const vehicles = lanes.filter((lane) => lane.role === 'vehicle');
	const dir = vehicles[0]?.direction;
	if (dir === 'bidirectional' || !vehicles.every((lane) => lane.direction === dir)) return null;
	return dir ?? null;
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

export function setupDrawMode(editor: Editor): ModeHandlers {
	// Continuing from an existing endpoint anchors the first segment there.
	let startNodeId: string | null = editor.takeDrawAnchor();
	// Whether the first click cut a road to start from (undone on cancel).
	let cutForStart = false;
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

	const worldPerPixel = () => editor.sceneManager.worldPerPixel();

	// The road body under the cursor, or the node at its end when the cursor
	// is over the road's last stretch (within a node ring of the end, along
	// it): the whole width of a road's end reaches that node, so its edge
	// attach points are as easy to hit as its middle, and no sliver is cut.
	const findSegmentSnap = (worldX: number, worldZ: number) => {
		let best: SegmentSnap | null = null;
		let end: Node | null = null;
		// The road's whole width snaps, pixel-floored: a driveway can start
		// anywhere on the road it joins.
		let bestScore = 1;
		const floor = SEGMENT_SNAP_PX * worldPerPixel();
		const endSnapDistance = editor.nodeRingRadius();

		for (const segment of editor.graph.segments.values()) {
			const startNode = editor.graph.nodes.get(segment.startNodeId);
			const endNode = editor.graph.nodes.get(segment.endNodeId);
			if (!startNode || !endNode) continue;

			// Snapped where the road is drawn (offset and all); the node it
			// would cut goes on the segment's line, where nodes live.
			const near = closestOnRoad(editor.graph, segment, worldX, worldZ);
			const on = roadAt(editor.graph, segment, near.t);
			if (!on) continue;
			const closest = { ...on.line, t: near.t, distance: near.distance };
			const score = closest.distance / Math.max(floor, segment.totalWidth / 2);
			if (score >= bestScore) continue;

			bestScore = score;
			const toStart = Math.hypot(closest.x - startNode.x, closest.y - startNode.y);
			const toEnd = Math.hypot(closest.x - endNode.x, closest.y - endNode.y);
			if (Math.min(toStart, toEnd) < endSnapDistance) {
				best = null;
				end = toStart <= toEnd ? startNode : endNode;
				continue;
			}
			end = null;
			best = { segment, x: closest.x, y: closest.y, t: closest.t, shown: on.point };
		}

		return { snap: best, end };
	};

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
			if (!adjacent) continue;
			const adjacentStart = editor.graph.nodes.get(adjacent.startNodeId);
			const adjacentEnd = editor.graph.nodes.get(adjacent.endNodeId);
			if (!adjacentStart || !adjacentEnd) continue;

			const atStart = adjacent.startNodeId === nodeId;
			const cx = adjacent.controlX ?? (adjacentStart.x + adjacentEnd.x) / 2;
			const cy = adjacent.controlY ?? (adjacentStart.y + adjacentEnd.y) / 2;
			const tangent = getQuadraticBezierTangent(
				adjacentStart.x,
				adjacentStart.y,
				cx,
				cy,
				adjacentEnd.x,
				adjacentEnd.y,
				atStart ? 0 : 1
			);
			const length = Math.hypot(tangent.x, tangent.y);
			if (length < 0.0001) continue;

			const outX = (atStart ? tangent.x : -tangent.x) / length;
			const outY = (atStart ? tangent.y : -tangent.y) / length;
			const dot = outX * chordX + outY * chordY;
			if (dot < bestDot) {
				bestDot = dot;
				best = { x: -outX, y: -outY };
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
		const endEdge = target.kind !== 'free' ? target.edge : null;
		const startTangent = startEdge
			? along(startEdge, target, startNode)
			: startNodeId
				? continuationTangentAt(startNodeId, target.x, target.y)
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

	// The attach points across a road at line parameter t, `middle` being
	// where its middle shows there; the live one is the part the cursor is
	// over (an edge within the outer quarter of the roadway on that side).
	const attachAt = (
		segment: Segment,
		t: number,
		middle: Pt,
		x: number,
		y: number,
		inward: Pt | null = null
	) => {
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

	// A node snaps inside its ring, the same fixed circle on screen that
	// select mode clicks; outside it the road body under the cursor snaps.
	const findNodeSnap = (worldX: number, worldZ: number) => {
		const radius = editor.nodeRingRadius();
		let best: Node | null = null;
		let bestScore = 1;
		for (const node of editor.graph.nodes.values()) {
			const p = nodePoint(editor.graph, node);
			const score = Math.hypot(p.x - worldX, p.y - worldZ) / radius;
			if (score < bestScore) {
				bestScore = score;
				best = node;
			}
		}
		return best;
	};

	const resolveSnap = (worldX: number, worldZ: number): SnapResult => {
		if (freeHeld) return { kind: 'free', x: worldX, y: worldZ };

		const node = findNodeSnap(worldX, worldZ);
		if (node) {
			const attach = nodeAttach(node, worldX, worldZ);
			return { kind: 'node', nodeId: node.id, x: node.x, y: node.y, edge: edgeOf(attach), attach };
		}

		const { snap, end } = findSegmentSnap(worldX, worldZ);
		if (end) {
			const attach = nodeAttach(end, worldX, worldZ);
			return { kind: 'node', nodeId: end.id, x: end.x, y: end.y, edge: edgeOf(attach), attach };
		}
		if (snap) {
			const attach = attachAt(snap.segment, snap.t, snap.shown, worldX, worldZ);
			return { kind: 'segment', snap, x: snap.x, y: snap.y, edge: edgeOf(attach), attach };
		}

		// Grid snap is the lowest-priority positional snap: nodes and segments win,
		// but on open ground the cursor lands on the nearest grid intersection.
		if (editor.gridEnabled) {
			const g = editor.gridSize;
			return { kind: 'free', x: Math.round(worldX / g) * g, y: Math.round(worldZ / g) * g };
		}

		return { kind: 'free', x: worldX, y: worldZ };
	};

	// Where the next click would land: positional snaps (nodes, segments)
	// win; otherwise shift applies the angle snap from the current anchor.
	const resolveTarget = (worldX: number, worldZ: number): SnapResult => {
		const snap = resolveSnap(worldX, worldZ);
		if (snap.kind !== 'free' || !shiftHeld || startNodeId === null) return snap;

		const startNode = editor.graph.nodes.get(startNodeId);
		if (!startNode) return snap;

		const tangent = continuationTangentAt(startNodeId, worldX, worldZ);
		const snapped = angleSnap(startNode.x, startNode.y, worldX, worldZ, tangent);
		return { kind: 'free', x: snapped.x, y: snapped.y };
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
		node.junction = { ...(node.junction ?? { connections: [] }), sides };
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
	// head-on, and the click lays nothing.
	const plan = (startNode: Node, target: SnapResult, control: Pt | null) => {
		const preset = editor.activeBrush?.lanes ?? [];
		const dir = oneWay(preset);
		if (!dir) return { lanes: cloneLanes(preset), forward: null, blocked: false };
		const outStart = unit(startNode, control ?? target);
		const outEnd = unit(target, control ?? startNode);
		const start = startEdge && outStart ? wayAt(startEdge, outStart) : null;
		const flow = start === null && chainForward === null ? nodeFlow(startNode.id) : null;
		const forward =
			start !== null
				? start === 'leave'
				: (chainForward ?? (flow ? flow === 'arrive' : dir === 'forward'));
		// At its end node, traffic arrives if it runs forward, else leaves.
		const way: Way = forward ? 'arrive' : 'leave';
		const endEdge = target.kind !== 'free' ? target.edge : null;
		const blocked = endEdge
			? !!outEnd && (wayAt(endEdge, outEnd) ?? way) !== way
			: target.kind === 'node' && !nodeTakes(target.nodeId, way);
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
		attach(graph, startId, segment, startEdge);
		attach(graph, endId, segment, target.kind !== 'free' ? target.edge : null);
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
	// ends at, the road it would cut, and every road at those nodes, so the
	// preview builds the joints there as the click will.
	const touched = (startId: string, target: SnapResult): GraphData => {
		const graph = editor.graph;
		const nodeIds = new Set([startId]);
		if (target.kind === 'node') nodeIds.add(target.nodeId);
		const segmentIds = new Set(target.kind === 'segment' ? [target.snap.segment.id] : []);
		for (const id of nodeIds)
			for (const s of graph.nodes.get(id)?.connectedSegments ?? []) segmentIds.add(s);
		const segments = [...segmentIds].flatMap((id) => graph.segments.get(id) ?? []);
		for (const s of segments) nodeIds.add(s.startNodeId).add(s.endNodeId);
		return {
			nodes: [...nodeIds].flatMap((id) => graph.nodes.get(id)?.toJSON() ?? []),
			segments: segments.map((s) => s.toJSON())
		};
	};

	const discardOrphanStart = () => {
		startEdge = null;
		chainForward = null;
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

		// On a node the cursor sits where the node shows; a new road still
		// starts from the node itself.
		const node = target.kind === 'node' ? editor.graph.nodes.get(target.nodeId) : undefined;
		const shown =
			target.kind !== 'free' && target.edge
				? target.edge.point
				: node
					? nodePoint(editor.graph, node)
					: target.kind === 'segment'
						? target.snap.shown
						: target;
		cursor.place(shown, target.kind !== 'free');
		// What the click attaches to: the node or road lit as if hovered, and
		// across the road the three attach points with the live one filled.
		editor.setHoveredNode(target.kind === 'node' ? target.nodeId : null);
		editor.setHoveredSegment(target.kind === 'segment' ? target.snap.segment.id : null);
		if (target.kind !== 'free' && target.attach) {
			dots.show(target.attach.points, target.attach.live);
		} else {
			dots.hide();
		}

		if (startNodeId === null) {
			ghost.clear();
			return;
		}

		const startNode = editor.graph.nodes.get(startNodeId);
		if (!startNode) return;

		if (Math.hypot(target.x - startNode.x, target.y - startNode.y) < MIN_PREVIEW_LENGTH) {
			ghost.clear();
			return;
		}

		const control = solveControl(startNode, target);
		const { lanes, forward, blocked } = plan(startNode, target, control);
		const startId = startNodeId;
		let arrow: { at: Pt; dir: Pt } | null = null;
		ghost.show(
			(graph) => {
				const { endId, segment } = layRoad(graph, startId, target, control, cloneLanes(lanes));
				const mid = segment && forward !== null ? roadAt(graph, segment, 0.5) : null;
				if (mid) {
					const k = forward ? 1 : -1;
					arrow = { at: mid.point, dir: { x: mid.tangent.x * k, y: mid.tangent.y * k } };
				}
				return { roads: segment ? [segment.id] : [], nodes: [startId, endId] };
			},
			touched(startId, target)
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
		const target = resolveTarget(worldPos.x, worldPos.z);

		if (startNodeId === null) {
			startNodeId = anchorIn(editor.graph, target);
			startEdge = target.kind !== 'free' ? target.edge : null;
			chainForward = null;
			cutForStart = target.kind === 'segment';
			if (cutForStart) {
				editor.rebuildRoads();
				editor.graph.save();
			}
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
			editor.graph.save();
			startNodeId = endNodeId;
			startEdge = null;
			chainForward = forward;
			cutForStart = false;
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

	// Escape unwinds one stage at a time: pending segment, then draw mode itself.
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Shift' && lastWorld) {
			shiftHeld = true;
			updatePreview(lastWorld.x, lastWorld.z);
			return;
		}
		if ((event.key === 'Meta' || event.key === 'Control') && lastWorld) {
			freeHeld = true;
			updatePreview(lastWorld.x, lastWorld.z);
			return;
		}
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

	return {
		onMouseDown,
		onMouseMove,
		onKeyDown,
		refresh,
		cleanup
	};
}
