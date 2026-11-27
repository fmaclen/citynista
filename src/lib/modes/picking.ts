import type { Editor } from '../editor.svelte';
import type { Segment } from '../core/segment.svelte';
import type { Node } from '../core/node.svelte';
import {
	closestOnRoad,
	END_IN,
	endsAt,
	type Bend,
	nodePoint,
	type Pt,
	roadAt,
	shiftedAt,
	shownAt,
	shownOffs
} from '../core/road-line';
import { type Bends, bentAfter, farOf, placedBy } from '../core/drag';
import { controlFrame, type Frame, fromFrame } from '../core/segment-curve';
import { type OnWalkway, segmentAtEnd } from '../core/place';
import type { Description } from '../road-model/description';
import type { RoadGeo } from '../road-model/ends';
import { crossSection, frameAt, offsetPoint } from '../road-model/geometry';
import { type Box, nearestOf } from '../road-model/overlay';
import { carries } from '../core/lane-types';

// A node's hit area is its ring, a fixed size on screen, so zooming in
// uncovers the roads between close nodes. A road's is its own half width
// with a screen-pixel floor: zoomed in, the whole road body is hoverable;
// zoomed out, it keeps a clickable minimum.
const SEGMENT_HIT_PX = 14;

// How near two points must lie to be at one spot (m): two nodes showing
// there, or a footpath's end landing on a footpath node (modes/draw.ts,
// clipboard.ts).
export const AT_ONE_SPOT = 0.01;

// The node whose ring is nearest a point, of those `keep` takes among
// `among` (every node, unless given). Where a
// footpath's node and a car node show at one spot (a node holds one kind,
// core/separate.ts), every gesture picks the same one (`preferred`).
export function nodeHitAt(
	editor: Editor,
	worldX: number,
	worldZ: number,
	keep: (node: Node) => boolean = () => true,
	among: Iterable<Node> = editor.graph.nodes.values()
) {
	const radius = editor.nodeRingRadius();
	let best: { node: Node; p: { x: number; y: number } } | null = null;
	let bestScore = 1;
	const tied: Node[] = [];
	for (const node of among) {
		if (!keep(node)) continue;
		const p = nodePoint(editor.graph, node);
		const score = Math.hypot(p.x - worldX, p.y - worldZ) / radius;
		if (best && Math.hypot(p.x - best.p.x, p.y - best.p.y) < AT_ONE_SPOT && score < 1) {
			tied.push(node);
			if (score < bestScore) bestScore = score;
		} else if (score < bestScore) {
			bestScore = score;
			best = { node, p };
			tied.length = 0;
		}
	}
	if (!best) return { node: null, score: bestScore };
	const node = tied.reduce((a, b) => preferred(editor, a, b), best.node);
	return { node, score: bestScore };
}

// Of two nodes at one spot, the one a click, a double-click or a drag
// picks: of a footpath's node and a car node, the footpath's where the car
// node is a cut its road is drawn whole through (Derived.through), which
// has nothing of its own to edit, and the car node anywhere else.
function preferred(editor: Editor, a: Node, b: Node) {
	const car = (n: Node) => {
		const s = editor.graph.segments.get(n.connectedSegments[0] ?? '');
		return s ? carries(s.lanes) : null;
	};
	const [ka, kb] = [car(a), car(b)];
	if (ka === null || kb === null || ka === kb) return ka === null && kb !== null ? b : a;
	const [carNode, walkNode] = ka ? [a, b] : [b, a];
	return editor.roadRenderer.derived?.through(carNode.id) ? walkNode : carNode;
}

// A road's score at a point is how far its shown line is, over its reach
// there (its half width, or the floor): under 1 it is hit, the least wins.
// A footpath scores as it shows (footpathScore).
export function segmentHitAt(editor: Editor, worldX: number, worldZ: number) {
	const floor = SEGMENT_HIT_PX * editor.sceneManager.worldPerPixel();
	const p = { x: worldX, y: worldZ };
	let best: Segment | null = null;
	let bestScore = 1;
	for (const segment of editor.graph.segments.values()) {
		// Where the road is drawn: its line moved by its offset.
		const dist = closestOnRoad(editor.graph, segment, worldX, worldZ).distance;
		const reach = Math.max(segment.totalWidth / 2, floor);
		const score = carries(segment.lanes)
			? dist / reach
			: footpathScore(editor, segment, p, dist / reach, reach);
		if (score !== null && score < bestScore) {
			bestScore = score;
			best = segment;
		}
	}
	return { segment: best, score: bestScore };
}

// A footpath is hit and snapped to where it shows, and nowhere it does not:
// on its paving (Scene.footpathPaving: its strip, stopped short of a bend,
// and the bend or joint at each of its nodes), so a bend's paving picks one
// of its two and the ground a bend leaves bare picks neither, and on a
// crossing it is part of (its zebra or refuge, which reach past its strip
// where it crosses at a slant or on a curve), but never elsewhere on a car
// road's lanes or median, where nothing of it is drawn (Networks.onOwnCrossing,
// Networks.onCarLanes).
// Select mode, split mode and draw mode's snap all read it here. Where it
// shows it is drawn over any car road there and outranks it, scoring below
// 0 (`shown`), the footpaths there ranked as their lines are far (`line`,
// over the reach); off its paving, as its paving's edge is far past its
// half width, so zoomed out the floor still reaches round it; null where it
// is hidden.
export function footpathScore(
	editor: Editor,
	segment: Segment,
	p: Pt,
	line: number,
	reach: number
) {
	const paving = editor.roadRenderer.scene?.footpathPaving(segment.id) ?? [];
	if (!paving.length) return line;
	if (editor.roadRenderer.onOwnCrossing(segment.id, p)) return shown(line);
	const off = offPaving(paving, p, reach);
	if (off < reach && editor.roadRenderer.onCarLanes(p)) return null;
	return off === 0 ? shown(line) : (segment.totalWidth / 2 + off) / reach;
}

// A footpath's score where it shows, its line `line` reaches off: from -1
// on its line to just under 0.
const shown = (line: number) => Math.min(line, 0.99) - 1;

// How far a point lies from some pieces' paving: 0 on it, and at least
// `reach` where no piece's box comes that near.
function offPaving(pieces: { description: Description; box: Box }[], p: Pt, reach: number) {
	let off = reach;
	for (const { description, box } of pieces) {
		if (p.x < box[0] - off || p.x > box[2] + off || p.y < box[1] - off || p.y > box[3] + off)
			continue;
		for (const s of description.surfaces) {
			const ring =
				'left' in s.shape ? [[...s.shape.left, ...[...s.shape.right].reverse()]] : s.shape;
			for (const r of ring) {
				if (onRing(r, p)) return 0;
				off = Math.min(off, toRing(r, p));
			}
		}
	}
	return off;
}

// Whether a point lies inside a ring (even-odd), and how far it lies from
// the ring's edge (toSegment).
function onRing(ring: Pt[], p: Pt) {
	let inside = false;
	for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
		const [a, b] = [ring[i], ring[k]];
		if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
			inside = !inside;
	}
	return inside;
}
function toRing(ring: Pt[], p: Pt) {
	let d = Infinity;
	for (let i = 0, k = ring.length - 1; i < ring.length; k = i++)
		d = Math.min(d, toSegment(p, ring[k], ring[i]));
	return d;
}

// How far a point lies from the segment from a to b.
export function toSegment(p: Pt, a: Pt, b: Pt) {
	const [dx, dy] = [b.x - a.x, b.y - a.y];
	const f = Math.max(
		0,
		Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))
	);
	return Math.hypot(a.x + dx * f - p.x, a.y + dy * f - p.y);
}

// Inside a node's ring the node wins outright — roads pass through their
// nodes, so any distance-based tiebreak hands the disc to the segment.
// The ring is the hit area, so the visible gap between two rings is exactly
// where the segment is picked.
export function pickAt(
	editor: Editor,
	worldX: number,
	worldZ: number
): { node: Node | null; segment: Segment | null } {
	const nodeHit = nodeHitAt(editor, worldX, worldZ);
	if (nodeHit.node) return { node: nodeHit.node, segment: null };
	return { node: null, segment: segmentHitAt(editor, worldX, worldZ).segment };
}

// Convex-quad containment: a point is inside when it sits on the same side of
// every edge. A degenerate (zero-area) quad has no consistent side and selects
// nothing, which is the right answer for a click that never dragged.
function pointInQuad(px: number, py: number, quad: { x: number; y: number }[]) {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const a = quad[i];
		const b = quad[(i + 1) % 4];
		const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
		if (cross === 0) continue;
		const s = cross > 0 ? 1 : -1;
		if (sign === 0) sign = s;
		else if (s !== sign) return false;
	}
	return sign !== 0;
}

// Everything inside the marquee quad: nodes where they show, segments when
// both endpoints fall inside. The quad is the marquee's on-screen rectangle
// projected onto the ground, so it tracks the camera instead of the world axes.
export function quadContents(
	editor: Editor,
	quad: { x: number; y: number }[]
): { nodeIds: string[]; segmentIds: string[] } {
	const nodeIds: string[] = [];
	const segmentIds: string[] = [];
	if (quad.length < 4) return { nodeIds, segmentIds };

	const inside = new Set<string>();
	for (const node of editor.graph.nodes.values()) {
		const p = nodePoint(editor.graph, node);
		if (pointInQuad(p.x, p.y, quad)) inside.add(node.id);
	}
	nodeIds.push(...inside);
	for (const segment of editor.graph.segments.values()) {
		if (inside.has(segment.startNodeId) && inside.has(segment.endNodeId))
			segmentIds.push(segment.id);
	}
	return { nodeIds, segmentIds };
}

// A walkway a footpath's end lies on (Derived.sidewalks): a street's
// sidewalk lane, or a junction's corner sidewalk.
type Walkway = Pick<OnWalkway, 'road' | 'lane' | 'corner'>;

// The street sidewalk lanes a walkway lies on: its own, or a corner's two.
export const lanesOf = (on: Walkway) =>
	on.corner ? [on.corner.a, on.corner.b] : [{ road: on.road, lane: on.lane }];

// Whether two footpath ends lie on one walkway: a street's sidewalk and the
// corner sidewalks it runs into at its ends are one (walkwayOf).
export const oneWalkway = (p: Walkway, q: Walkway) =>
	lanesOf(p).some((a) => lanesOf(q).some((b) => a.road === b.road && a.lane === b.lane));

// To a footpath, a street's sidewalk and the corner sidewalks it runs into
// at its ends are one walkway: an end on the sidewalk slides on round onto
// a corner and back, and one on a corner lies on both streets' sidewalks it
// joins. The walkway an end lying on `on` is joined to, as the last build
// drew it: the middle of each street's sidewalk it lies on (lanesOf), along
// that street as drawn, and of each corner at that street's ends running
// into it, with the streets' segments (their roads', Derived.units). A
// street's sidewalk stops END_IN short of an end no corner runs on from, so
// an end on it lies on it. Null where none of it is drawn (its road gone,
// or the lane no sidewalk now).
export function walkwayOf(editor: Editor, on: Walkway) {
	const derived = editor.roadRenderer.derived;
	const scene = editor.roadRenderer.scene;
	if (!derived || !scene) return null;
	const lines: Pt[][] = [];
	const street = new Set<string>();
	for (const { road, lane } of lanesOf(on)) {
		const geo = derived.geos.get(road);
		const lanes = editor.graph.segments.get(road)?.lanes ?? [];
		const walk = lanes.find((l) => l.id === lane)?.role === 'pedestrian';
		if (!geo || !carries(lanes) || !walk) continue;
		for (const s of derived.units.get(road) ?? [road]) street.add(s);
		const corners = (['start', 'end'] as const).map((end) => {
			const segment = editor.graph.segments.get(segmentAtEnd(derived.units, road, end));
			const node = segment && (end === 'start' ? segment.startNodeId : segment.endNodeId);
			const junction = node ? editor.roadRenderer.junctionAt(node) : undefined;
			return (junction ? (scene.node(junction.id)?.walkways ?? []) : [])
				.filter((w) => [w.a, w.b].some((r) => r.road === road && r.end === end && r.lane === lane))
				.map((w) => w.line);
		});
		const from = corners[0].length ? 0 : END_IN;
		const to = geo.path.length - (corners[1].length ? 0 : END_IN);
		const along = from < to ? laneLine(geo, lane, from, to) : [];
		if (along.length > 1) lines.push(along);
		lines.push(...corners.flat());
	}
	return lines.length ? { lines, street: [...street] } : null;
}

// The middle of a road's lane along it as drawn, from `from` to `to` metres.
function laneLine(geo: RoadGeo, lane: string, from: number, to: number) {
	const stations = [from, ...geo.path.s.filter((s) => s > from && s < to), to];
	return stations.flatMap((s) => {
		const span = crossSection(geo.road, s).find((x) => x.lane.id === lane);
		const f = frameAt(geo.path, s);
		return span ? [offsetPoint(f.p, f.n, (span.left + span.right) / 2)] : [];
	});
}

// How far from its node a footpath's end shows with the node at a point
// (shownAt: its shift, square to the way it leaves the node toward its far
// node where that lies).
export function shownOffset(editor: Editor, path: Segment | undefined, nodeId: string, p: Pt) {
	const start = path?.startNodeId === nodeId;
	const far = path && editor.graph.nodes.get(start ? path.endNodeId : path.startNodeId);
	if (!path || !far || far.id === nodeId) return { x: 0, y: 0 };
	const q = start ? shownAt(path, p, far, 0).point : shownAt(path, far, p, 1).point;
	return { x: q.x - p.x, y: q.y - p.y };
}

// How a footpath lies now for placing its node by where its end shows
// (Bend in core/road-line.ts), its handle left where it is.
function bendNow(editor: Editor, path: Segment): Bend | null {
	const a = editor.graph.nodes.get(path.startNodeId);
	const b = editor.graph.nodes.get(path.endNodeId);
	if (!a || !b) return null;
	return {
		heading: { x: b.x - a.x, y: b.y - a.y },
		off: shownOffs(editor.graph, path),
		...(path.hasControlPoint && { handle: { x: path.controlX!, y: path.controlY! } })
	};
}

// What a press that moves nodes or roads may move (`nodes`: mayMove in
// core/drag.ts), the nodes it places itself (`placed`: those dragged and
// the riders), how each footpath at those nodes lay as it began (bendNow,
// `bends`), whether each footpath node a build of the press found on a
// walkway otherwise lay joined to one as the press began, the only ones the
// follower may move (`joined`, filled in by Editor.noteWalkwayChanges),
// where on its walkway each shifted node the follower may move was joined
// as it began, and where that node lay (`walked`), and the curves of the
// footpaths whose handle is placed after the follower (`frames`: bentAfter
// in core/drag.ts), each in the frame of its nodes as it began. The
// follower places a node and a handle by these alone (followWalkway), so
// where they go never depends on how many builds the press took. A setback
// or taper handle's press holds only `joined`. Any other edit
// (NOTHING_MOVING) is read as things lie at each build.
export type Moving = {
	nodes: ReadonlySet<string>;
	placed?: ReadonlySet<string>;
	joined?: Map<string, boolean>;
	bends: ReadonlyMap<string, Bend>;
	walked?: ReadonlyMap<string, { on: OnWalkway; at: Pt }>;
	frames?: Map<string, Frame>;
};
export const NOTHING_MOVING: Moving = { nodes: new Set(), bends: new Map() };
export function movingFrom(
	editor: Editor,
	nodes: ReadonlySet<string>,
	placed: ReadonlySet<string>
): Moving {
	const { graph } = editor;
	const bends = new Map<string, Bend>();
	const frames = new Map<string, Frame>();
	const walked = new Map<string, { on: OnWalkway; at: Pt }>();
	for (const id of nodes) {
		const on = editor.roadRenderer.derived?.sidewalks.get(id)?.[0];
		const node = graph.nodes.get(id);
		if (on && node && !placed.has(id) && shiftedAt(graph, id))
			walked.set(id, { on, at: { x: node.x, y: node.y } });
		for (const s of graph.nodes.get(id)?.connectedSegments ?? []) {
			const path = graph.segments.get(s);
			if (!path || carries(path.lanes) || bends.has(s)) continue;
			const bend = bendNow(editor, path);
			if (bend) bends.set(s, bend);
			const frame = bentAfter(graph, path, nodes, placed) && controlFrame(graph, path);
			if (frame) frames.set(s, frame);
		}
	}
	return { nodes, placed, joined: new Map(), bends, walked, frames };
}

// Where a footpath's node goes for its end to show at `w` (endsAt in
// core/road-line.ts): its far node staying where it lies, or, `together`,
// moved by the same gesture; the footpath as that gesture began (`bend`)
// where given, as it lies now otherwise.
export function placedAt(
	editor: Editor,
	path: Segment | undefined,
	nodeId: string,
	w: Pt,
	bend?: Bend | null,
	together = false
) {
	const start = path?.startNodeId === nodeId;
	const far = path && editor.graph.nodes.get(start ? path.endNodeId : path.startNodeId);
	const way = path && (bend ?? bendNow(editor, path));
	if (!path || !far || !way || far.id === nodeId) return w;
	return endsAt(path, way, start ? 'start' : 'end', w, together ? null : { x: far.x, y: far.y });
}

// A footpath node joined to a walkway: one its footpaths' ends lie on as
// last drawn (Derived.sidewalks), with the walkway it is joined to there
// (walkwayOf), whether that lies on a corner, and the streets' segments. It
// slides along that walkway (`slide`, where the node goes for a point a move
// takes it to: its footpath's end, shift and all, shows on the walkway's
// middle where that comes nearest where the move takes the end, so it
// follows the pointer however its shift turns; `keep`, where it goes to stay
// on the walkway nearest where its end shows with the node at a point), and
// comes off it only when deleted, or its street is. Read off the drawing,
// never stored: a node lies on the walkway it is joined to.
export function joinedTo(editor: Editor, nodeId: string) {
	const on = editor.roadRenderer.derived?.sidewalks.get(nodeId)?.[0];
	const walkway = on && walkwayOf(editor, on);
	if (!on || !walkway) return null;
	const path = editor.graph.segments.get(on.path);
	const onto = (at: Pt, off: Pt, bend?: Bend | null, together?: boolean) => {
		const w = nearestOf(walkway.lines, (l) => l, { x: at.x + off.x, y: at.y + off.y })?.at;
		return w ? placedAt(editor, path, nodeId, w, bend, together) : null;
	};
	// Moved, the end shows where the pointer took it: as far from the node
	// as it showed when joined, the footpath placed as it lay then.
	const node = editor.graph.nodes.get(nodeId);
	const from = node ? shownOffset(editor, path, nodeId, node) : { x: 0, y: 0 };
	const then = path && bendNow(editor, path);
	return {
		street: walkway.street,
		far: path ? farOf(path, nodeId) : null,
		slide: (at: Pt, bends?: Bends, together?: boolean) =>
			onto(at, from, (path && bends?.(path.id)) ?? then, together),
		keep: (at: Pt) => onto(at, shownOffset(editor, path, nodeId, at))
	};
}

// Whether a footpath node is joined to a junction's corner sidewalk, which
// it keeps to as the corner is drawn anew (followWalkway) rather than riding
// a road of the junction.
export const onCorner = (editor: Editor, nodeId: string) =>
	!!editor.roadRenderer.derived?.sidewalks.get(nodeId)?.[0]?.corner;

// Footpath nodes whose ends lay on a walkway as the build before the last
// drew it (`ends`: each node, `was`, and where its end shows now), the
// walkway drawn otherwise since and the node not moved itself, each go
// where the end keeps its place on that walkway as now drawn (walkwayTo).
// It follows that walkway and no other: where it is drawn no more (the
// corner gone, the street deleted, the lane retyped or removed), the end
// stays where it is, joined to nothing. Where every end goes is read before
// any node moves, and the curves placed after the follower are placed once
// every node has its place (`moving.frames`, in the frame of their nodes as
// the press began). Each node goes as placedBy in core/drag.ts says, all
// that may move being what the press in hand may (`moving`) and every node
// here, by its footpath as the press began (`moving.bends`, or as it lies
// now outside a press). In a press, only the nodes joined to a walkway as
// the press began are in `ends` (Editor.followWalkways): a footpath end a
// walkway reaches during the press (a street swung across it) stays where
// it lay. Whether a node moved itself is asked of the press
// (`moving.placed`: dragged, or riding), never read off where its
// end shows, which a shifted end changes as its far node moves; outside
// one, by its end showing elsewhere. A shifted node the press may move
// keeps its end at the place on the walkway it had as the press began
// (`moving.walked`). One whose far node may move is carried, as a rider is
// (ridersOf in core/drag.ts), never placed against that node: it moves as
// far as that place on the walkway has moved since the press began (from
// placeOn to walkwayTo),
// reading nothing of the other node or of how the footpath now lies. So a
// corner moved bodily carries it exactly, and where it goes never depends
// on how many builds the press took. The nodes moved, each with where it
// stood, and the curves placed, each with its handle before.
export function followWalkway(
	editor: Editor,
	ends: [string, OnWalkway, Pt][],
	moving: Moving = NOTHING_MOVING
) {
	const { graph } = editor;
	type Going = { path?: Segment; to: Pt; bend: Bend | null; began?: { on: OnWalkway; at: Pt } };
	const going = new Map<string, Going>();
	for (const [nodeId, was, end] of ends) {
		if (!graph.nodes.has(nodeId)) continue;
		const itself = moving.placed
			? moving.placed.has(nodeId)
			: Math.hypot(end.x - was.end.x, end.y - was.end.y) > MOVED;
		if (itself) continue;
		const began = moving.walked?.get(nodeId);
		const to = walkwayTo(editor, began?.on ?? was);
		const then = was.line.at(-1)!;
		if (!to || (!began && Math.hypot(to.x - then.x, to.y - then.y) <= MOVED)) continue;
		const path = graph.segments.get(was.path);
		const bend = path ? (moving.bends.get(path.id) ?? bendNow(editor, path)) : null;
		going.set(nodeId, { path, to, bend, began });
	}
	const moves = new Set([...moving.nodes, ...going.keys()]);
	const moved = new Map<string, Pt>();
	for (const [nodeId, { path, to, bend, began }] of going) {
		const node = graph.nodes.get(nodeId)!;
		const far = path && farOf(path, nodeId);
		const carried = placedBy(graph, nodeId, far, moves) === 'carried';
		const spot = began && placeOn(began.on);
		const at =
			carried && began && spot
				? { x: began.at.x + to.x - spot.x, y: began.at.y + to.y - spot.y }
				: placedAt(editor, path, nodeId, to, bend, carried);
		if (Math.hypot(at.x - node.x, at.y - node.y) <= MOVED) continue;
		moved.set(nodeId, { x: node.x, y: node.y });
		[node.x, node.y] = [at.x, at.y];
	}
	const curves = new Map<string, Pt | null>();
	for (const [id, frame] of moving.frames ?? []) {
		const segment = graph.segments.get(id);
		const a = segment && graph.nodes.get(segment.startNodeId);
		const b = segment && graph.nodes.get(segment.endNodeId);
		if (!segment || !a || !b) continue;
		const c = fromFrame(a, b, frame);
		const was = segment.hasControlPoint ? { x: segment.controlX!, y: segment.controlY! } : null;
		if (was && Math.hypot(c.x - was.x, c.y - was.y) <= MOVED) continue;
		curves.set(id, was);
		segment.setControlPoint(c.x, c.y);
	}
	return { moved, curves };
}

// Where a footpath's end on a walkway as an earlier build drew it (`was`)
// keeps its place on that walkway as now drawn: on a corner, the corner now
// drawn in its place (roundAgain), found by where it lies and never by the
// ids of the roads beside it (a cut renames them), as far round as it was,
// by the fraction of the way round; on a street's sidewalk, that sidewalk
// lane of that road as now drawn, or of the pieces a cut put in its place
// (sidewalkNow), the corners it runs into included, where it comes nearest
// where it joined. Null where that walkway is drawn no more.
function walkwayTo(editor: Editor, was: OnWalkway) {
	const then = was.line.at(-1)!;
	const car = was.corner && editor.graph.nodes.get(was.corner.node.id);
	return was.corner
		? car && roundAgain(editor, was.corner, car, then)
		: nearestOf(sidewalkNow(editor, was, then), (l) => l, then)?.at;
}

// The point of its walkway as then drawn that walkwayTo carries a footpath
// end's place from (`was`): on a corner, the point of the corner's middle
// nearest where it joined, which is how far round it was; on a street's
// sidewalk, where it joined.
function placeOn(was: OnWalkway) {
	const then = was.line.at(-1)!;
	return (was.corner && nearestOf([was.corner.line], (l) => l, then)?.at) || then;
}

// The middle lines of the street sidewalk a footpath's end joined at
// `then` (`was`) as now drawn, the corners it runs into included
// (walkwayOf). That sidewalk is that lane of every car road now drawn that
// carries it on where the street did, found by where it lies, never by the
// ids of the roads beside it: the street itself where it still stands (a
// lane edit or a move redrew it), and each car road drawn near `then` whose
// lane of that id runs through `then` as its line carries it across
// (laneThrough), as every piece a cut leaves of the street does, whichever
// segment of it was cut and whatever its shift. Another road's lane passing
// exactly there is no part of the edit. None where nothing is drawn there.
function sidewalkNow(editor: Editor, was: OnWalkway, then: Pt) {
	const roads = new Set<string>();
	if (editor.graph.segments.has(was.road)) roads.add(was.road);
	const r = ON_LANE;
	const box = { x0: then.x - r, y0: then.y - r, x1: then.x + r, y1: then.y + r };
	for (const id of editor.roadRenderer.near(box).segments) {
		const segment = editor.graph.segments.get(id);
		if (segment && carries(segment.lanes) && laneThrough(editor, segment, was.lane, then))
			roads.add(editor.roadRenderer.derived?.units.get(id)?.[0] ?? id);
	}
	return [...roads].flatMap((road) => walkwayOf(editor, { road, lane: was.lane })?.lines ?? []);
}

// Whether a road's lane (by id) has its middle within ON_LANE of a point:
// the lane runs `o` across the road's shown line, square to the road at
// each place along it (roadAt), so where it passes nearest the point is
// found from the place along the line nearest the point moved back across
// by `o`, read again there (a shift changing along the road slants the
// line, not the way across).
function laneThrough(editor: Editor, segment: Segment, lane: string, p: Pt) {
	let left = -segment.totalWidth / 2;
	let o: number | null = null;
	for (const l of segment.lanes) {
		if (l.id === lane) o = left + l.width / 2;
		left += l.width;
	}
	if (o === null) return false;
	let at = roadAt(editor.graph, segment, closestOnRoad(editor.graph, segment, p.x, p.y).t);
	for (let k = 0; k < SETTLE && at; k++) {
		const q = { x: p.x - at.normal.x * o, y: p.y - at.normal.y * o };
		at = roadAt(editor.graph, segment, closestOnRoad(editor.graph, segment, q.x, q.y).t);
	}
	if (!at) return false;
	const m = { x: at.point.x + at.normal.x * o, y: at.point.y + at.normal.y * o };
	return Math.hypot(m.x - p.x, m.y - p.y) < ON_LANE;
}

// How near a point a lane's middle runs to run through it (m): within what
// two samplings of one curve put apart.
const ON_LANE = 0.05;

// How far round its junction's node (radians) each end of a corner may lie
// from where it lay and be that corner drawn anew: under the angle a
// street's width takes up seen from the node, so a corner with an end across
// a road from where the old one's lay is another corner.
const TURN = Math.PI / 6;

// The point as far round the corner now drawn in a corner's place as `then`
// was round it (followWalkway), or null where none is drawn there: of the
// corners of the junction now drawn at the car node the corner was drawn at
// (`car`, where it lies now), the one whose two ends each lie within TURN of
// where the old corner's did, seen from that node then and now, the nearest
// so.
function roundAgain(editor: Editor, corner: NonNullable<OnWalkway['corner']>, car: Pt, then: Pt) {
	const junction = editor.roadRenderer.junctionAt(corner.node.id);
	const drawn = junction ? (editor.roadRenderer.scene?.node(junction.id)?.walkways ?? []) : [];
	const bearing = (p: Pt, from: Pt) => Math.atan2(p.y - from.y, p.x - from.x);
	const turn = (p: Pt, q: Pt) => {
		const d = Math.abs(bearing(p, car) - bearing(q, corner.node)) % (2 * Math.PI);
		return Math.min(d, 2 * Math.PI - d);
	};
	const [a, b] = [corner.line[0], corner.line.at(-1)!];
	let best: { line: Pt[]; off: number } | null = null;
	for (const w of drawn)
		for (const line of [w.line, [...w.line].reverse()]) {
			const off = Math.max(turn(line[0], a), turn(line.at(-1)!, b));
			if (off <= TURN && (!best || off < best.off)) best = { line, off };
		}
	const near = nearestOf([corner.line], (l) => l, then);
	return best && near ? alongLine(best.line, near.length ? near.along / near.length : 0) : null;
}

// The point a fraction `f` of the way along a line.
function alongLine(line: Pt[], f: number) {
	const total = line
		.slice(1)
		.reduce((s, p, i) => s + Math.hypot(p.x - line[i].x, p.y - line[i].y), 0);
	let left = f * total;
	for (let i = 1; i < line.length; i++) {
		const l = Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
		if (left <= l && l > 0) {
			const t = left / l;
			return {
				x: line[i - 1].x + (line[i].x - line[i - 1].x) * t,
				y: line[i - 1].y + (line[i].y - line[i - 1].y) * t
			};
		}
		left -= l;
	}
	return line.at(-1) ?? null;
}

// How far (m) a footpath's end may lie from where it lay, or a walkway's
// middle from where the end joined it, and be where it was.
const MOVED = 1e-6;

// How many times laneThrough reads the way across a road again where the
// lane's middle comes nearest a point: each brings it within a fraction of
// how much the road turns over the last, so a few settle it well inside
// ON_LANE.
const SETTLE = 4;
