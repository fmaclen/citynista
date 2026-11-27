import { CLICK_SLOP_PX, type ModeHandlers } from './types';
import type { Segment } from '../core/segment.svelte';
import type { Editor } from '../editor.svelte';
import type { JunctionCrossing, LaneRef } from '../core/types';
import type { LaneConnection } from '../core/lane-connections';
import { crossingAt, segmentAtEnd } from '../core/place';
import { CROSSING_DEPTH, CROSSING_FROM_END } from '../road-model/approach';
import { carries } from '../core/lane-types';
import { endsOf, type EndInfo } from '../road-model/ends';
import { kindOf } from '../road-model/connect';
import {
	endKey,
	isTravel,
	type Control,
	type LaneRef as ModelLaneRef,
	type Pt as Point
} from '../road-model/model';
import { crossSection, endFrame, frameAt, offsetPoint, project } from '../road-model/geometry';
import { CROSSING_HANDLE, hitsHandle } from '../rendering/handle-shapes';
import { HANDLE_HIT_SLACK_PX, LANE_DOT_PX } from '../rendering/editor-palette';
import { oneWalkway, pickAt, toSegment } from './picking';
import { roadLine } from '../core/road-line';
import { WALK } from '../core/footpaths';

// The lane connector: a transient mode scoped to one node (entered by
// double-clicking it). Each lane shows a dot at its mouth: a filled disc where
// traffic enters the node, a hollow ring where it leaves, and a filled disc on
// lanes that connect either way (medians, grass, sidewalks). Drag from a disc
// to a dot of the same kind on another road to add that connection, or to
// remove it if it is there; the drawing follows the connections. Every
// crossing at the node shows as a line straight across its road with a
// handle: drag the handle to slide it along the road, click it to switch
// the crossing off (a hollow handle) or on again. Dragging between
// the two sidewalk dots of one road adds a crossing there. A badge on each
// approach steps its control through none, stop, yield and signal. A
// crossing a footpath makes is paint and offers nothing. At a footpath node
// each footpath there shows a dot, joined to every other footpath's and to
// the sidewalk the node lies on: a footpath meets all it touches, and nothing
// there is edited.
//
// The mode is modal: while it's open nothing else hovers or selects. Clicking a
// road or node is ignored (so you can't accidentally grab the road next door);
// leave with Escape or a click on empty ground.

// A new crosswalk lands this far beyond the end of its road's taper.
const NEW_CROSSING_BEYOND = 3;
// Lane dots of two road ends that nearly meet sit at least this far apart.
const CONNECTOR_SPREAD = 10;

// A lane end in the lane connector: travel lanes are entered (`in`) or left
// (`out`); medians, grass and sidewalks connect either way (`both`).
export interface ConnectorEndpoint {
	ref: LaneRef;
	lane: ModelLaneRef;
	kind: string;
	point: Point;
	dir: Point;
	flow: 'in' | 'out' | 'both';
}

type Toggle = { from: ModelLaneRef; to: ModelLaneRef };

// Whether the connector opens on a node: one of two or more roads, or a
// footpath's end on a street's sidewalk (Derived.sidewalks).
export const opensConnector = (editor: Editor, nodeId: string) =>
	(editor.graph.nodes.get(nodeId)?.connectedSegments.length ?? 0) >= 2 ||
	!!editor.roadRenderer.derived?.sidewalks.has(nodeId);

// Opens the connector on a node (opensConnector). The node's taper, and with
// it every lane dot, holds still while its connections are edited; the
// editor lets it go when the connector closes (`closeConnector`).
export function openConnector(editor: Editor, nodeId: string) {
	if (!opensConnector(editor, nodeId)) return;
	editor.clearSelection();
	editor.roadRenderer.holdTaper(nodeId);
	editor.connectorNodeId = nodeId;
	editor.mode = 'connector';
}

const connectorNode = (editor: Editor) =>
	editor.connectorNodeId ? editor.graph.nodes.get(editor.connectorNodeId) : undefined;

// The connector's node where a road only carries on through it: drawn as
// one road, shown as a node of its two segments (Derived.through).
const connectorThrough = (editor: Editor) =>
	editor.connectorNodeId
		? (editor.roadRenderer.derived?.through(editor.connectorNodeId) ?? null)
		: null;

const connectorJunction = (editor: Editor) =>
	editor.connectorNodeId
		? (connectorThrough(editor)?.junction ??
			editor.roadRenderer.derived?.junctions.get(editor.connectorNodeId))
		: undefined;

// The road ends at the connector's node, as the drawing reads them.
function connectorEnds(editor: Editor): EndInfo[] {
	const junction = connectorJunction(editor);
	const scene = editor.roadRenderer.scene;
	const through = connectorThrough(editor);
	const geos = through && scene ? new Map([...scene.geos, ...through.geos]) : scene?.geos;
	return junction && geos ? endsOf(junction, geos) : [];
}

// The control badges: one for each approach of a junction, stored under the
// segment it comes along. None at a footpath's node, nor at a node a car road
// only carries on through.
function connectorBadges(editor: Editor) {
	const node = connectorNode(editor);
	const scene = editor.roadRenderer.scene;
	if (!node || !scene) return [];
	const roads = node.connectedSegments.flatMap((id) => editor.graph.segments.get(id) ?? []);
	if (!roads.some((s) => carries(s.lanes)) || connectorThrough(editor)) return [];
	const own = scene.node(node.id);
	// Each approach's control is stored under the segment that ends at the
	// node, which the drawing names by its road (segmentAtEnd).
	const units = editor.roadRenderer.derived?.units;
	const stored = (key: string) => {
		const at = key.lastIndexOf(':');
		const end = key.slice(at + 1) === 'start' ? 'start' : 'end';
		return units ? `${segmentAtEnd(units, key.slice(0, at), end)}:${end}` : key;
	};
	return (own?.approaches ?? []).map((a) => ({
		key: stored(a.end),
		control: a.control,
		x: a.badge.x,
		y: a.badge.y
	}));
}

// Where a road's shown line ends at one of its nodes.
function shownEnd(editor: Editor, segment: Segment, nodeId: string) {
	const line = roadLine(editor.graph, segment);
	return segment.startNodeId === nodeId ? line[0] : line.at(-1)!;
}

// At a node holding footpaths: a dot on each footpath's middle lane and one
// on each walkway a footpath's end there lies on (Derived.sidewalks); each
// footpath joined to every other its paving meets and to the walkway its own
// end lies on, each link drawn along the line a walker follows the model
// gives it. Between two footpaths that is the line the node's bend or joint
// holds (core/footpaths.ts), which paves between them; where their ends lie
// on walkways instead, each one's line onto its walkway, the one run on into
// the other, and only where both lie on one walkway or their ends meet.
// Each footpath's dot stands where its lines start. Null at any other node.
function footpathJoin(editor: Editor) {
	const node = connectorNode(editor);
	const derived = editor.roadRenderer.derived;
	const scene = editor.roadRenderer.scene;
	if (!node || !derived || !scene) return null;
	const walks = node.connectedSegments.flatMap((id) => editor.graph.segments.get(id) ?? []);
	if (!walks.length || walks.some((s) => carries(s.lanes))) return null;
	const middle = (s: Segment) => Math.floor((s.lanes.length - 1) / 2);
	const joint = scene.node(WALK + node.id)?.paths ?? [];
	const onWalk = derived.sidewalks.get(node.id) ?? [];
	// The line each footpath's links start on.
	const startOf = (id: string) =>
		joint.find((p) => p.from.road === id)?.line[0] ??
		joint.find((p) => p.to.road === id)?.line.at(-1) ??
		onWalk.find((on) => on.path === id)?.line[0];
	const dots = walks.map((s) => ({
		ref: { segmentId: s.id, laneIndex: middle(s) },
		point: startOf(s.id) ?? shownEnd(editor, s, node.id),
		flow: 'both' as const
	}));
	type Dot = (typeof dots)[number];
	const dotOf = (id: string) => dots.find((d) => d.ref.segmentId === id);
	const link = (a: Dot, b: Dot, line: Point[]): LaneConnection => ({
		from: a.ref,
		to: b.ref,
		fromPoint: a.point,
		toPoint: b.point,
		fromDir: { x: 0, y: 0 },
		toDir: { x: 0, y: 0 },
		line
	});
	const connections: LaneConnection[] = [];
	for (const p of joint) {
		const [a, b] = [dotOf(p.from.road), dotOf(p.to.road)];
		if (a && b) connections.push(link(a, b, p.line));
	}
	// Footpaths whose ends lie on a walkway, joined through it where their
	// paving meets: both on that one walkway (a street's sidewalk and the
	// corners it runs into are one: oneWalkway), or their ends' cross-sections
	// meeting. Two ending on different walkways apart (a street's two
	// sidewalks, say) are each joined to their own alone.
	const edgeOf = (id: string) => {
		const geo = scene.geos.get(id);
		const s = editor.graph.segments.get(id);
		if (!geo || !s) return null;
		const f = endFrame(geo.road, geo.path, s.startNodeId === node.id ? 'start' : 'end');
		const spans = crossSection(geo.road, f.distance);
		return [spans[0].left, spans.at(-1)!.right].map((d) => offsetPoint(f.p, f.n, d)) as [
			Point,
			Point
		];
	};
	const meet = (p: string, q: string) => {
		const [a, b] = [edgeOf(p), edgeOf(q)];
		return !!a && !!b && apart(a, b) <= MEET;
	};
	if (!joint.length)
		for (const [i, on] of onWalk.entries())
			for (const other of onWalk.slice(i + 1)) {
				const [a, b] = [dotOf(on.path), dotOf(other.path)];
				const one = oneWalkway(on, other);
				if (a && b && (one || meet(on.path, other.path)))
					connections.push(link(a, b, [...on.line, ...[...other.line].reverse()]));
			}
	// Each footpath with the sidewalk its end lies on: one dot on each
	// sidewalk, where the first footpath's line onto it ends.
	const sidewalkDots = new Map<string, Dot>();
	const lanes = new Set<string>();
	for (const on of onWalk) {
		const streetLane = editor.graph.segments.get(on.road)?.lanes.findIndex((l) => l.id === on.lane);
		const dot = dotOf(on.path);
		if (streetLane === undefined || streetLane < 0 || !dot) continue;
		const key = `${on.road}:${on.lane}`;
		if (!sidewalkDots.has(key))
			sidewalkDots.set(key, {
				ref: { segmentId: on.road, laneIndex: streetLane },
				point: on.line.at(-1)!,
				flow: 'both'
			});
		connections.push(link(dot, sidewalkDots.get(key)!, on.line));
		lanes.add(on.lane);
	}
	return { lanes: [...lanes], dots: [...dots, ...sidewalkDots.values()], connections };
}

// How near two footpaths' end cross-sections must come for their paving to
// meet (m).
const MEET = 0.05;

// How far apart two lines from a to b are: 0 where they cross.
function apart([a, b]: [Point, Point], [c, d]: [Point, Point]) {
	const side = (p: Point, q: Point, r: Point) =>
		(q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
	if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return 0;
	return Math.min(toSegment(a, c, d), toSegment(b, c, d), toSegment(c, a, b), toSegment(d, a, b));
}

// What the connector shows, for the page's `__editorLook`: its node and
// each connection drawn, as its two lanes (`segment:lane index`), and the
// line each is drawn along where it follows one (`lines`, in their order).
function shown(editor: Editor, connections: LaneConnection[]) {
	const key = (r: LaneRef) => `${r.segmentId}:${r.laneIndex}`;
	editor.connectorShown = editor.connectorNodeId
		? {
				node: editor.connectorNodeId,
				links: connections.map((c) => [key(c.from), key(c.to)]),
				lines: connections.map((c) => c.line ?? [])
			}
		: null;
}

// Lane dots and the connections between them. Where only two roads meet,
// every lane shows; at a junction of more, the travel lanes (its sidewalks
// are its corners and crosswalks).
function refreshConnectors(editor: Editor) {
	const junction = connectorJunction(editor);
	const ends = connectorEnds(editor);
	editor.controlBadges = connectorBadges(editor);
	const join = footpathJoin(editor);
	editor.connectorJoined = join?.lanes ?? [];
	if (join) {
		editor.connectorEndpoints = [];
		editor.connectionRenderer.show(join.connections, join.dots);
		shown(editor, join.connections);
		editor.crossingRenderer.clear();
		return;
	}
	if (!junction || ends.length === 0) {
		editor.connectorEndpoints = [];
		editor.connectionRenderer.clear();
		shown(editor, []);
		editor.crossingRenderer.clear();
		return;
	}
	const link = ends.length === 2;
	// Where two road ends nearly meet, their dots spread apart along the
	// roads so every lane's dot can be told apart and aimed at.
	const gap = link
		? Math.hypot(ends[0].frame.p.x - ends[1].frame.p.x, ends[0].frame.p.y - ends[1].frame.p.y)
		: Infinity;
	const spread = Math.max(0, (CONNECTOR_SPREAD - gap) / 2);
	const endpoints: ConnectorEndpoint[] = [];
	for (const end of ends) {
		const segment = editor.graph.segments.get(end.ref.road);
		if (!segment) continue;
		for (const l of end.lanes) {
			const travel = isTravel(l.lane);
			if (!travel && !link) continue;
			if (!travel && l.lane.kind !== 'walk' && l.lane.kind !== 'buffer') continue;
			const laneIndex = segment.lanes.findIndex((x) => x.id === l.ref.lane);
			if (laneIndex < 0) continue;
			endpoints.push({
				ref: { segmentId: end.ref.road, laneIndex },
				lane: l.ref,
				kind: kindOf(l.lane),
				point: {
					x: l.point.x + end.frame.out.x * spread,
					y: l.point.y + end.frame.out.y * spread
				},
				dir: { x: -end.frame.out.x, y: -end.frame.out.y },
				flow: !travel ? 'both' : l.flow === 'in' ? 'in' : 'out'
			});
		}
	}
	const find = (r: ModelLaneRef) =>
		endpoints.find((e) => endKey(e.lane) === endKey(r) && e.lane.lane === r.lane);
	const connections: LaneConnection[] = [];
	for (const c of junction.connections) {
		const from = find(c.from);
		const to = find(c.to);
		if (!from || !to) continue;
		connections.push({
			from: from.ref,
			to: to.ref,
			fromPoint: from.point,
			toPoint: to.point,
			fromDir: from.dir,
			toDir: { x: -to.dir.x, y: -to.dir.y }
		});
	}
	editor.connectorEndpoints = endpoints;
	editor.connectionRenderer.show(connections, endpoints);
	shown(editor, connections);
	// Each crossing: its handle across the road, on a straight line from
	// sidewalk to sidewalk while it is on.
	editor.crossingRenderer.show(
		connectorCrossings(editor).map((c) => ({
			at: c.mid,
			dir: c.dir,
			stem: c.crossing.on ? ([c.from, c.to] as [Point, Point]) : undefined,
			hollow: !c.crossing.on
		}))
	);
}

// The lane dot nearest the cursor, either flow — used for hover feedback and
// for picking both ends of a connector drag (direction-agnostic).
function endpointNear(editor: Editor, worldX: number, worldZ: number) {
	const threshold = (LANE_DOT_PX + HANDLE_HIT_SLACK_PX) * editor.sceneManager.worldPerPixel();
	let best: ConnectorEndpoint | null = null;
	let bestDistance = threshold;
	for (const endpoint of editor.connectorEndpoints) {
		const distance = Math.hypot(endpoint.point.x - worldX, endpoint.point.y - worldZ);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = endpoint;
		}
	}
	return best;
}

// Two different sidewalks at the same road end.
function crossingPair(a: ConnectorEndpoint, b: ConnectorEndpoint) {
	return (
		a.kind === 'walk' &&
		b.kind === 'walk' &&
		endKey(a.lane) === endKey(b.lane) &&
		a.lane.lane !== b.lane.lane
	);
}

// Whether a drag from one lane dot to another makes (or unmakes) a
// connection: same kind, different road ends, and for travel lanes from
// where traffic comes in to where it leaves.
function canConnect(from: ConnectorEndpoint, to: ConnectorEndpoint) {
	// Two sidewalks of one road end: a crosswalk across that road.
	if (crossingPair(from, to)) return true;
	if (from.kind !== to.kind || endKey(from.lane) === endKey(to.lane)) return false;
	if (from.flow === 'both' || to.flow === 'both') return from.flow === to.flow;
	return from.flow === 'in' && to.flow === 'out';
}

// Adds the connection between two lane dots, or removes it if it is there.
// The node keeps the edit (an addition or a removal against the defaults)
// for as long as both lanes exist.
function toggleConnection(editor: Editor, from: ConnectorEndpoint, to: ConnectorEndpoint) {
	if (!canConnect(from, to)) return;
	if (crossingPair(from, to)) {
		toggleCrossing(editor, from, to);
		return;
	}
	editConnections(editor, [{ from: from.lane, to: to.lane }]);
}

// Double-clicking a lane dot removes every connection it has.
function toggleAllConnections(editor: Editor, endpoint: ConnectorEndpoint) {
	const hit = (r: ModelLaneRef) =>
		endKey(r) === endKey(endpoint.lane) && r.lane === endpoint.lane.lane;
	const mine = (connectorJunction(editor)?.connections ?? []).filter(
		(c) => hit(c.from) || hit(c.to)
	);
	if (mine.length) editConnections(editor, mine);
}

function editConnections(editor: Editor, toggles: Toggle[]) {
	const node = connectorNode(editor);
	const junction = connectorJunction(editor);
	if (!node || !junction) return;
	const key = (r: ModelLaneRef) => `${endKey(r)}/${r.lane}`;
	const same = (x: Toggle, y: Toggle) =>
		(key(x.from) === key(y.from) && key(x.to) === key(y.to)) ||
		(key(x.from) === key(y.to) && key(x.to) === key(y.from));
	const copy = (c: Toggle) => ({ from: { ...c.from }, to: { ...c.to } });
	let added = (node.junction?.added ?? []).map(copy);
	let removed = (node.junction?.removed ?? []).map(copy);
	for (const t of toggles) {
		const present = junction.connections.some((c) => same(c, t));
		if (present) {
			if (added.some((c) => same(c, t))) added = added.filter((c) => !same(c, t));
			else removed.push(copy(t));
		} else if (removed.some((c) => same(c, t))) removed = removed.filter((c) => !same(c, t));
		else added.push(copy(t));
	}
	node.junction = { ...node.junction, added, removed };
	editor.rebuildRoads();
	editor.graph.save();
	refreshConnectors(editor);
}

// The connector node's crossings, on and off, each straight across its
// road with a handle in the middle to slide it along the road.
function connectorCrossings(editor: Editor) {
	const id = editor.connectorNodeId;
	const list = id ? editor.roadRenderer.derived?.crossings.get(id) : undefined;
	const geos = editor.roadRenderer.scene?.geos;
	if (!list || !geos) return [];
	return list.flatMap((c, index) => {
		const geo = geos.get(c.road);
		if (!geo || c.place === undefined) return [];
		const f = frameAt(geo.path, c.place);
		const spans = crossSection(geo.road, c.place);
		const sides = c.lanes.map((lane) => spans.find((sp) => sp.lane.id === lane));
		if (!sides[0] || !sides[1]) return [];
		const [p, q] = sides.map((sp) => offsetPoint(f.p, f.n, (sp!.left + sp!.right) / 2));
		const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
		const l = Math.hypot(q.x - p.x, q.y - p.y) || 1;
		const dir = { x: (q.x - p.x) / l, y: (q.y - p.y) / l };
		return [{ index, crossing: c, from: p, to: q, mid, dir }];
	});
}

// The crossing whose handle is under the pointer, with its place among
// the handles shown (`shown`).
function crossingHandleAt(editor: Editor, worldX: number, worldZ: number) {
	const scale = editor.sceneManager.worldPerPixel();
	const list = connectorCrossings(editor);
	const shown = list.findIndex((c) =>
		hitsHandle(CROSSING_HANDLE, c.mid, c.dir, worldX, worldZ, scale)
	);
	return shown < 0 ? null : { ...list[shown], shown };
}

const sameCrossing = (c: JunctionCrossing) => (x: JunctionCrossing) =>
	x.road === c.road && x.end === c.end && x.lanes.every((l) => c.lanes.includes(l));

// Writes a crossing's stored edit on the connector's node: a default one
// moved or switched, or one added by hand.
function storeCrossing(editor: Editor, c: JunctionCrossing, patch: Partial<JunctionCrossing>) {
	const node = connectorNode(editor);
	if (!node) return;
	const stored = node.junction?.crossings ?? [];
	const same = sameCrossing(c);
	const next = stored.some(same)
		? stored.map((x) => (same(x) ? { ...x, ...patch } : x))
		: [...stored, { road: c.road, end: c.end, lanes: c.lanes, ...patch }];
	node.junction = { ...node.junction, crossings: next };
	editor.rebuildRoads();
	refreshConnectors(editor);
}

// A crossing between two sidewalks of one road end: switched off if it is
// on, on if it is off; one that isn't there yet is added a little way
// past the node.
function toggleCrossing(editor: Editor, a: ConnectorEndpoint, b: ConnectorEndpoint) {
	const lanes: [string, string] = [a.lane.lane, b.lane.lane];
	const existing = connectorCrossings(editor).find(
		(c) =>
			c.crossing.road === a.lane.road &&
			c.crossing.end === a.lane.end &&
			c.crossing.lanes.every((l) => lanes.includes(l))
	);
	if (existing) {
		switchCrossing(editor, existing.index);
		return;
	}
	const span = editor.roadRenderer.derived?.spans.get(a.lane.road);
	if (!span) return;
	const place = a.lane.end === 'start' ? NEW_CROSSING_BEYOND : span.length - NEW_CROSSING_BEYOND;
	storeCrossing(
		editor,
		{ road: a.lane.road, end: a.lane.end, lanes },
		{ at: crossingAt(a.lane.end, place, span), on: true }
	);
	editor.graph.save();
}

// Slides a crossing along its road to where the pointer is: never past
// either end of the road, nor onto another crossing on it.
function moveCrossing(editor: Editor, index: number, worldX: number, worldZ: number) {
	const c = connectorCrossings(editor).find((x) => x.index === index)?.crossing;
	const geo = c && editor.roadRenderer.scene?.geos.get(c.road);
	const span = c && editor.roadRenderer.derived?.spans.get(c.road);
	if (!c || !geo || !span || c.place === undefined) return;
	const lo = CROSSING_FROM_END;
	const hi = span.length - CROSSING_FROM_END;
	let place = Math.max(lo, Math.min(hi, project(geo.path, { x: worldX, y: worldZ }).s));
	// Other crossings on the road block the way from where it is now.
	const gap = CROSSING_DEPTH + 1;
	for (const other of geo.road.crossings ?? []) {
		if (Math.abs(other.at - c.place) < 1e-6) continue;
		if (other.at > c.place) place = Math.min(place, other.at - gap);
		else place = Math.max(place, other.at + gap);
	}
	storeCrossing(editor, c, { at: crossingAt(c.end, place, span) });
}

// Switches a crossing off, or back on; one added by hand goes when
// switched off.
function switchCrossing(editor: Editor, index: number) {
	const node = connectorNode(editor);
	const c = connectorCrossings(editor).find((x) => x.index === index)?.crossing;
	if (!node || !c) return;
	if (!c.auto && c.on) {
		const same = sameCrossing(c);
		const crossings = (node.junction?.crossings ?? []).filter((x) => !same(x));
		node.junction = { ...node.junction, crossings };
		editor.rebuildRoads();
		refreshConnectors(editor);
	} else storeCrossing(editor, c, { on: !c.on });
	editor.graph.save();
}

// The control a badge steps on to from `control`: none, stop, yield,
// signal, and round. A junction's approach and a footpath's crossing step
// alike.
const CONTROL_ORDER: Control[] = ['none', 'stop', 'yield', 'signal'];
export const nextControl = (control: Control) =>
	CONTROL_ORDER[(CONTROL_ORDER.indexOf(control) + 1) % CONTROL_ORDER.length];

// Steps an approach's control on (nextControl).
export function cycleControl(editor: Editor, key: string) {
	const node = connectorNode(editor);
	const current = editor.controlBadges.find((b) => b.key === key)?.control;
	if (!node || !current) return;
	node.junction = {
		...node.junction,
		control: { ...(node.junction?.control ?? {}), [key]: nextControl(current) }
	};
	editor.rebuildRoads();
	editor.graph.save();
	refreshConnectors(editor);
}

export function setupConnectorMode(editor: Editor): ModeHandlers {
	refreshConnectors(editor);
	const canvas = editor.sceneManager.getCanvas();

	let dragStart: ConnectorEndpoint | null = null;
	// A crossing handle pressed (by its index on the node): it slides along
	// its road once the pointer moves past CLICK_SLOP_PX, else the release
	// switches it.
	let crossingDrag: { index: number; x: number; y: number; moved: boolean } | null = null;
	// A mousedown on empty ground becomes an exit on mouseup, dragged or not.
	let pendingExit = false;

	const setCursor = (cursor: string) => {
		canvas.style.cursor = cursor;
	};

	// Leaving the mode closes the connector (Editor.setupMode). A release
	// given while another tool is being armed (Editor.settlePress) leaves it
	// for that tool.
	const exit = () => {
		if (editor.mode === 'connector') editor.mode = 'select';
	};

	const onMouseDown = (event: MouseEvent) => {
		if (event.button !== 0) return;
		const world = editor.sceneManager.screenToWorld(event.clientX, event.clientY);

		const crossing = crossingHandleAt(editor, world.x, world.z);
		if (crossing) {
			crossingDrag = { index: crossing.index, x: event.clientX, y: event.clientY, moved: false };
			editor.lightHandle({ kind: 'crossing', index: crossing.shown }, 'active');
			pendingExit = false;
			setCursor('grabbing');
			return;
		}

		const near = endpointNear(editor, world.x, world.z);
		if (near) {
			// Only discs are grabbable; an outgoing ring is a passive target.
			dragStart = near.flow !== 'out' ? near : null;
			pendingExit = false;
			if (dragStart) setCursor('grabbing');
			return;
		}

		// No dot: leave only from empty ground; clicking a road or node is ignored.
		const { node, segment } = pickAt(editor, world.x, world.z);
		pendingExit = !node && !segment;
	};

	const onMouseMove = (event: MouseEvent) => {
		const world = editor.sceneManager.screenToWorld(event.clientX, event.clientY);

		if (crossingDrag !== null) {
			const travel = Math.hypot(event.clientX - crossingDrag.x, event.clientY - crossingDrag.y);
			if (travel > CLICK_SLOP_PX) crossingDrag.moved = true;
			if (crossingDrag.moved) {
				moveCrossing(editor, crossingDrag.index, world.x, world.z);
				// A crossing sliding is an edit Undo takes back.
				editor.holdsUndo(true);
			}
			return;
		}

		if (dragStart) {
			// Feedback: green over a lane it can connect to, red over anything
			// else under the cursor.
			const near = endpointNear(editor, world.x, world.z);
			const over = near && near !== dragStart ? near : null;
			const valid = !!over && canConnect(dragStart, over);
			editor.connectionRenderer.setDragFeedback(dragStart.ref, over ? over.ref : null, valid);
			editor.connectionRenderer.showRubberBand(
				dragStart.point,
				{ x: world.x, y: world.z },
				over ? (valid ? 'valid' : 'invalid') : 'neutral'
			);
			return;
		}

		const crossing = crossingHandleAt(editor, world.x, world.z);
		editor.lightHandle(crossing ? { kind: 'crossing', index: crossing.shown } : null);

		// Hovering ANY dot (incoming or outgoing) highlights it and every movement
		// that starts or ends there; only incoming dots are grabbable for a drag.
		const near = endpointNear(editor, world.x, world.z);
		editor.connectionRenderer.setHovered(near ? near.ref : null);
		setCursor(near ? (near.flow !== 'out' ? 'grab' : 'pointer') : 'default');
	};

	const onMouseUp = (event: MouseEvent) => {
		editor.connectionRenderer.hideRubberBand();

		if (crossingDrag !== null) {
			const { index, moved } = crossingDrag;
			crossingDrag = null;
			editor.holdsUndo(false);
			editor.lightHandle(null);
			setCursor('default');
			if (moved) editor.graph.save();
			else switchCrossing(editor, index);
			return;
		}

		if (dragStart) {
			const world = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
			const near = endpointNear(editor, world.x, world.z);
			if (near && near !== dragStart) toggleConnection(editor, dragStart, near);
			dragStart = null;
			setCursor('default');
			return;
		}

		if (pendingExit) {
			pendingExit = false;
			exit();
		}
	};

	// Double-clicking a lane dot drops all of its connections.
	const onDoubleClick = (event: MouseEvent) => {
		if (event.button !== 0) return;
		const world = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		if (crossingHandleAt(editor, world.x, world.z)) return;
		const near = endpointNear(editor, world.x, world.z);
		if (near) toggleAllConnections(editor, near);
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			exit();
		}
	};

	const cleanup = () => {
		dragStart = null;
		crossingDrag = null;
		pendingExit = false;
		setCursor('default');
		editor.connectionRenderer.clear();
	};

	return {
		onMouseDown,
		onMouseMove,
		onMouseUp,
		onDoubleClick,
		onKeyDown,
		refresh: () => refreshConnectors(editor),
		cleanup
	};
}
