import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Scene } from '../src/lib/core/networks';
import type { GraphData, Lane } from '../src/lib/core/types';
import { check } from '../src/lib/road-model/checks';
import {
	area,
	fromPath,
	inside,
	intersect,
	offset,
	subtract,
	toPath,
	union,
	type Paths
} from '../src/lib/road-model/clip';
import type {
	Description,
	Marking,
	RoadDescription,
	Sign
} from '../src/lib/road-model/description';
import { frameAt, project } from '../src/lib/road-model/geometry';
import { signRoom } from '../src/lib/road-model/approach';
import { laneKey, type Pt } from '../src/lib/road-model/model';
import { shapeOf } from '../src/lib/road-model/overlay';
import { paintOf, signShapes } from '../src/lib/rendering/road-meshes';
import { describeRoad } from '../src/lib/road-model/road';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { buildModel, editorDrawing, liveShape, pieces, withoutFootpaths } from './model';

// The line a crossing puts across the car lanes coming towards it, and the
// paint it clears, whatever pieces it lies on: a footpath slid along a
// street from well short of a node, through the node or junction and out the
// other side, square across and at a slant, at a node of two sides (a
// widening, a bend, a street shifted sideways), a T and a four-way, plain and
// divided, the street stored either way round. At every step:
//
// - the drawing rules hold that say it (road-model/checks.ts): no lane
//   marked twice for one crossing, no line and no other paint on a crossing
//   or between a line and its crossing, no lane line ending out in the road;
// - every lane whose traffic meets the crossing first there (no lane
//   leading into it meets it before) and has room behind it for a line,
//   on ground its traffic drives (not past where it leaves a junction) and
//   clear of every other crossing, carries exactly one line for it, wherever
//   it lies: one standing across it in the stretch behind it;
// - no paint of any kind (lane and edge lines, hatching, arrows) lies
//   between a line and its crossing across that line's carriageway (the
//   lanes between the walkways either side of its lanes);
// - a lane line loses paint only on the crossing's ground, beside it in a
//   lane it lies over, or between a line and what it stands for (its
//   crossing; and the node too, for a line a node stands on a road coming
//   in) across that line's carriageway, or where a piece left at a road's
//   end or beside a cut is too short to keep.

const lane = (id: string, role: Lane['role'], width: number, direction: Lane['direction']) =>
	({
		id,
		role,
		width,
		direction,
		material: role === 'pedestrian' ? 'concrete' : 'asphalt'
	}) as Lane;
const walk = (id: string, width = 2) => lane(id, 'pedestrian', width, 'bidirectional');
const drive = (id: string, direction: Lane['direction']) => lane(id, 'vehicle', 3.5, direction);

const plain = [walk('L'), drive('B', 'backward'), drive('F', 'forward'), walk('R')];
const divided = [
	walk('L'),
	drive('B', 'backward'),
	drive('BB', 'backward'),
	walk('M', 4),
	drive('F', 'forward'),
	drive('FF', 'forward'),
	walk('R')
];
// Both carriageways running east.
const eastward = divided.map((l) =>
	l.id === 'B' || l.id === 'BB' ? { ...l, direction: 'forward' } : l
) as Lane[];
const wide = divided.filter((l) => l.id !== 'M');
// A two-way street with a hatched buffer down its middle (asphalt: painted).
const hatched = [
	walk('L'),
	drive('B', 'backward'),
	lane('H', 'buffer', 2, 'bidirectional'),
	drive('F', 'forward'),
	walk('R')
];
const bare = [drive('B', 'backward'), drive('F', 'forward')];
// A widening with a hatched buffer down its middle on both sides.
const hatchedWide = [
	walk('L'),
	drive('B', 'backward'),
	drive('BB', 'backward'),
	lane('H', 'buffer', 2, 'bidirectional'),
	drive('F', 'forward'),
	drive('FF', 'forward'),
	walk('R')
];

type Segment = GraphData['segments'][number];
const node = (id: string, x: number, y: number) => ({ id, x, y });
const segment = (id: string, a: string, b: string, lanes: Lane[], more: Partial<Segment> = {}) =>
	({ id, startNodeId: a, endNodeId: b, lanes, ...more }) as Segment;

// A street west to east through a node at the origin, and what meets it
// there. `from` is where the footpath across it starts, south of it, or on
// the walkway down its middle.
interface Fixture {
	graph: GraphData;
	from: number;
}
const street = (west: Lane[], east: Lane[], more: Partial<Segment> = {}, b = node('b', 50, 0)) => ({
	nodes: [node('a', -50, 0), node('j', 0, 0), b],
	segments: [segment('west', 'a', 'j', west, more), segment('east', 'j', 'b', east)]
});
const tee = (west: Lane[], east: Lane[], south = plain): GraphData => {
	const g = street(west, east);
	return {
		nodes: [...g.nodes, node('c', 0, 50)],
		segments: [...g.segments, segment('south', 'j', 'c', south)]
	};
};
// The streets a user draws: the lane presets (Street, Avenue with grass
// verges and a raised median, Highway with a raised median and no
// sidewalks, One-way lane).
const preset = (id: string) => createLanesFrom(id).map((l, i) => ({ ...l, id: `${id}${i}` }));
const [avenue, highway, streetPreset, oneWay] = ['avenue', 'highway', 'street', 'lane'].map(preset);
const fixtures: Record<string, Fixture> = {
	widening: { graph: street(wide, bare), from: -22 },
	'hatched widening': { graph: street(hatchedWide, hatched), from: -22 },
	bend: { graph: street(plain, plain, {}, node('b', 48, 14)), from: -22 },
	shifted: { graph: street(plain, bare, { offsetEnd: 2 }), from: -22 },
	tee: { graph: tee(plain, plain), from: -22 },
	'divided tee': { graph: tee(divided, divided), from: -22 },
	'divided tee, one carriageway crossed': { graph: tee(divided, divided), from: 0 },
	'divided tee, both carriageways eastward': { graph: tee(eastward, eastward), from: 0 },
	'four lanes to two at a tee': { graph: tee(wide, bare), from: -22 },
	'hatched tee': { graph: tee(hatched, hatched), from: -22 },
	// A sidewalk carried across the node into a walkway down the middle.
	'sidewalk into a median': { graph: street(plain, divided), from: -22 },
	'Avenue to Street': { graph: street(avenue, streetPreset), from: -26 },
	'Highway to Street': { graph: street(highway, streetPreset), from: -26 },
	'Street to One-way lane': { graph: street(streetPreset, oneWay), from: -26 },
	'Avenue with a Street teeing in': { graph: tee(avenue, avenue, streetPreset), from: -26 },
	'Avenue to Highway, a Street teeing in': {
		graph: tee(avenue, highway, streetPreset),
		from: -26
	},
	'four-way': {
		graph: {
			nodes: [...tee(plain, plain).nodes, node('d', 0, -50)],
			segments: [...tee(plain, plain).segments, segment('north', 'j', 'd', plain)]
		},
		from: -22
	}
};

// The street stored the other way round: each of its segments reversed.
function reversed(graph: GraphData): GraphData {
	const flip = (d: Lane['direction']) =>
		d === 'forward' ? 'backward' : d === 'backward' ? 'forward' : d;
	return {
		...graph,
		segments: graph.segments.map((s) =>
			s.id === 'west' || s.id === 'east'
				? {
						...s,
						startNodeId: s.endNodeId,
						endNodeId: s.startNodeId,
						...(s.offsetEnd !== undefined && { offsetStart: -s.offsetEnd, offsetEnd: undefined }),
						lanes: [...s.lanes].reverse().map((l) => ({ ...l, direction: flip(l.direction) }))
					}
				: s
		)
	};
}

// The graph with footpaths across it, each from one point to another.
const withPaths = (graph: GraphData, paths: [Pt, Pt][]): GraphData => ({
	nodes: [
		...graph.nodes,
		...paths.flatMap(([from, to], i) => [node(`p${i}`, from.x, from.y), node(`q${i}`, to.x, to.y)])
	],
	segments: [
		...graph.segments,
		...paths.map((_, i) => segment(`path${i}`, `p${i}`, `q${i}`, [walk('P')]))
	]
});
const withPath = (graph: GraphData, from: Pt, to: Pt) => withPaths(graph, [[from, to]]);

const RULES = [
	'lane marked twice',
	' on a crossing',
	'lane line ends between',
	'paint between a line and its crossing',
	'line ends mid-road',
	'markings overlap'
];

type Piece = { id: string; road?: RoadDescription; d: Description };
const piecesOf = (scene: Scene): Piece[] => [
	...scene.place.roads.map((r) => ({ id: r.id, road: scene.road(r.id)!, d: scene.road(r.id)! })),
	...scene.place.junctions.map((j) => ({ id: j.id, d: scene.node(j.id)! }))
];
type Held = Extract<Sign, { kind: 'stop' | 'yield' }>;
// A line is its paint: one described with none is no line.
const linesOf = (d: Description) =>
	d.signs.filter(
		(s): s is Held =>
			(s.kind === 'stop' || s.kind === 'yield') &&
			signShapes(s).some((r) => Math.abs(area(toPath(r))) > 0.01)
	);
const add = (p: Pt, u: Pt, t: number) => ({ x: p.x + u.x * t, y: p.y + u.y * t });
const ringKey = (r: Pt[]) => JSON.stringify(r.slice(0, 3));
const groundOf = (scene: Scene) =>
	piecesOf(scene).flatMap(({ d }) =>
		d.crossings.flatMap((c) => [...c.body, ...c.runs.flatMap((r) => r.rings)])
	);

// Where the road is at `s` along it, edge `k` of its cross-section.
function edgeAt(d: RoadDescription, k: number, s: number) {
	const i = d.along.reduce((b, a, j) => (Math.abs(a - s) < Math.abs(d.along[b] - s) ? j : b), 0);
	return add(d.edges[k][i], frameAt(d.path, s).t, s - d.along[i]);
}

// Where paint may be lost with the footpath there (see the top).
function cleared(scene: Scene, crossed: Paths) {
	const quads: Pt[][] = [];
	// As far on as the crossing reaches across the line's lanes: where a
	// ray from the line leaves the crossing it meets.
	const hit = (p: Pt, u: Pt) => throughOf(crossed, p, u, 25);
	for (const piece of piecesOf(scene)) {
		for (const s of linesOf(piece.d)) {
			const ref = s.lanes[0];
			const road = scene.road(ref.road);
			const mid = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
			const along = road && project(road.path, mid).s;
			const ahead = aheadOf(scene, s);
			if (!ahead) continue;
			let reach = Math.max(
				...[0, 0.25, 0.5, 0.75, 1].map((f) =>
					hit(add(s.a, { x: s.b.x - s.a.x, y: s.b.y - s.a.y }, f), ahead!)
				)
			);
			if (road && along !== undefined && ref.end && (!reach || !piece.road)) {
				const left = ref.end === 'end' ? road.path.length - along : along;
				if (left <= 25) reach = Math.max(reach, left + 0.3);
			}
			if (!reach) continue;
			// Across its carriageway where it stands on its lanes' road;
			// standing on a node, a lane either side (no fixture parts a street
			// there).
			const [a, b] = acrossOf(scene, s);
			// Standing on a node, its carriageway is its car paths (no fixture
			// parts a street there), which may fan out ahead of the line (a
			// widening), their lines' width beyond their edges.
			if (!piece.road && 'paths' in piece.d) {
				const strips = piece.d.paths
					.filter((p) => p.kind === 'drive')
					.map((p) => toPath(stripOf(p.line, p.widths)));
				const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
				const e = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
				const slab = toPath([
					add(add(a, e, -20), ahead, -0.6),
					add(add(b, e, 20), ahead, -0.6),
					add(add(b, e, 20), ahead, reach),
					add(add(a, e, -20), ahead, reach)
				]);
				quads.push(...intersect(union(strips), [slab]).map(fromPath));
			}
			quads.push([
				add(a, ahead, -0.6),
				add(b, ahead, -0.6),
				add(b, ahead, reach),
				add(a, ahead, reach)
			]);
		}
		// A lane's stretch beside a crossing lying over it (one paving a
		// verge alone has no body).
		if (piece.road)
			for (const c of piece.road.crossings) {
				const ss = c.body.flat().map((q) => project(piece.road!.path, q).s);
				if (!ss.length) continue;
				const [s0, s1] = [Math.min(...ss), Math.max(...ss)];
				const k = piece.road.edges.length - 1;
				quads.push([
					edgeAt(piece.road, 0, s0),
					edgeAt(piece.road, 0, s1),
					edgeAt(piece.road, k, s1),
					edgeAt(piece.road, k, s0)
				]);
			}
	}
	return union([...offset(crossed, 0.6), ...offset(union(quads.map(toPath)), 0.45)]);
}

// The way a line's traffic drives, and the line run out across its
// carriageway: standing on its lanes' road, between the walkways either
// side of them; standing on a node (no fixture parts a street there), the
// line itself (what it clears there is read along the node's car paths:
// `cleared`).
function aheadOf(scene: Scene, s: Held): Pt | null {
	if (s.kind === 'yield') return { x: -s.toward.x, y: -s.toward.y };
	const ref = s.lanes[0];
	const road = scene.road(ref.road);
	if (!road) return null;
	const mid = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
	const t = frameAt(road.path, project(road.path, mid).s).t;
	return ref.end === 'end' ? t : { x: -t.x, y: -t.y };
}
function acrossOf(scene: Scene, s: Held): [Pt, Pt] {
	const ref = s.lanes[0];
	const road = scene.road(ref.road);
	const mid = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
	const along = road && project(road.path, mid).s;
	const ks = road
		? road.lanes.flatMap((sp, k) => (s.lanes.some((l) => l.lane === sp.lane.id) ? [k] : []))
		: [];
	if (road && along !== undefined && ks.length && along > 0.01 && along < road.path.length - 0.01) {
		const lanes = road.lanes.map((sp) => sp.lane);
		let [k0, k1] = [Math.min(...ks), Math.max(...ks)];
		while (k0 > 0 && lanes[k0 - 1].kind !== 'walk') k0--;
		while (k1 + 1 < lanes.length && lanes[k1 + 1].kind !== 'walk') k1++;
		return [edgeAt(road, k0, along), edgeAt(road, k1 + 1, along)];
	}
	const l = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) || 1;
	const e = { x: (s.b.x - s.a.x) / l, y: (s.b.y - s.a.y) / l };
	return [add(s.a, e, -0.3), add(s.b, e, 0.3)];
}

// Points every quarter metre along a line.
function pointsOf(line: Pt[]) {
	const out: Pt[] = [];
	for (let i = 1; i < line.length; i++) {
		const [a, b] = [line[i - 1], line[i]];
		const l = Math.hypot(b.x - a.x, b.y - a.y);
		for (let t = 0; t < l; t += 0.25)
			out.push(add(a, { x: (b.x - a.x) / l, y: (b.y - a.y) / l }, t));
	}
	return out;
}
const onLine = (p: Pt, m: Marking) =>
	m.line.some((q, i) => {
		if (!i) return false;
		const a = m.line[i - 1];
		const e = { x: q.x - a.x, y: q.y - a.y };
		const t = Math.max(
			0,
			Math.min(1, ((p.x - a.x) * e.x + (p.y - a.y) * e.y) / (e.x * e.x + e.y * e.y || 1))
		);
		return Math.hypot(a.x + e.x * t - p.x, a.y + e.y * t - p.y) < 0.05;
	});

// Each lane's traffic as a line along its middle, the way it drives: on a
// road, each car lane; on a node, each car path. By the lane end it starts
// at and the one it reaches, as connections name them; a junction's paths
// marked, which the traffic is not traced back through (it comes from
// every approach).
interface Trace {
	pts: Pt[];
	start: string;
	end: string;
	junction: boolean;
	name: string;
	// On a road, how far from where the traffic enters it the node there
	// stops its paint: the ground its traffic drives begins there.
	stop: number;
	widths: number[];
}
function tracesOf(scene: Scene): Trace[] {
	const out: Trace[] = [];
	for (const { id, road, d } of piecesOf(scene)) {
		if (road)
			road.lanes.forEach(({ lane }, k) => {
				if (lane.kind !== 'drive' || (lane.dir !== 'fwd' && lane.dir !== 'back')) return;
				const mid = road.edges[k].map((p, i) => ({
					x: (p.x + road.edges[k + 1][i].x) / 2,
					y: (p.y + road.edges[k + 1][i].y) / 2
				}));
				const fwd = lane.dir === 'fwd';
				const [from, to] = fwd ? (['start', 'end'] as const) : (['end', 'start'] as const);
				out.push({
					pts: fwd ? mid : mid.reverse(),
					start: laneKey({ road: id, end: from, lane: lane.id }),
					end: laneKey({ road: id, end: to, lane: lane.id }),
					junction: false,
					name: `${id}/${lane.id}`,
					stop: road.cut[from].paint,
					widths: mid.map((_, i) => {
						const [l, r] = [road.edges[k][i], road.edges[k + 1][i]];
						return Math.hypot(r.x - l.x, r.y - l.y);
					})
				});
			});
		else if ('paths' in d)
			for (const p of d.paths)
				if (p.kind === 'drive')
					out.push({
						pts: p.line,
						start: laneKey(p.from),
						end: laneKey(p.to),
						junction: d.approaches.length > 0,
						name: `${id}:${laneKey(p.from)}`,
						stop: 0,
						widths: p.widths
					});
	}
	return out;
}

// Points every 0.1 m along a polyline, with how far along each is.
// (`i`: the point of the polyline it lies short of).
function stepsAlong(pts: Pt[]) {
	const out: { p: Pt; s: number; i: number }[] = [];
	let run = 0;
	for (let i = 1; i < pts.length; i++) {
		const [a, b] = [pts[i - 1], pts[i]];
		const l = Math.hypot(b.x - a.x, b.y - a.y);
		const u = { x: (b.x - a.x) / (l || 1), y: (b.y - a.y) / (l || 1) };
		for (let t = 0; t < l; t += 0.1) out.push({ p: add(a, u, t), s: run + t, i });
		run += l;
	}
	if (pts.length) out.push({ p: pts[pts.length - 1], s: run, i: pts.length - 1 });
	return out;
}

// The ways back up the traffic from point `i` of a trace (at `from`), each
// as far as REACH: its own line back to its start, then each trace leading
// into it there, through nodes of two sides, never a junction.
const REACH = 15;
function backFrom(t: Trace, i: number, from: Pt, traces: Trace[], reach = REACH): Pt[][] {
	const out: Pt[][] = [];
	const go = (line: Pt[], t: Trace, i: number, seen: Set<Trace>) => {
		let more = [...line, ...t.pts.slice(0, i).reverse()];
		const len = more.reduce(
			(s, p, k) => s + (k ? Math.hypot(p.x - more[k - 1].x, p.y - more[k - 1].y) : 0),
			0
		);
		const before = traces.filter((x) => x.end === t.start && !x.junction && !seen.has(x));
		// Where it leaves a junction, no nearer it than where that stops its
		// paint.
		if (!before.length && t.stop > 0) {
			const steps = stepsAlong(more);
			const keep = steps.filter(({ s }) => s <= len - t.stop).map(({ p }) => p);
			more = keep.length > 1 ? keep : more.slice(0, 1);
		}
		if (len >= reach || !before.length) out.push(more);
		else for (const x of before) go(more, x, x.pts.length, new Set([...seen, x]));
	};
	go([from], t, i, new Set([t]));
	return out;
}

// Every lane whose traffic meets a footpath's crossing first there and has
// room behind it for a line, on ground it drives and clear of every other
// crossing, carries exactly one; none carries two. Room: signRoom behind
// where the stream it drives in (the lanes beside it running its way, on
// its carriageway) first meets the crossing, across the whole width of each
// of its lanes, as one line square across them stands.
function heldOnce(scene: Scene, crossed: Paths, all: Paths) {
	const out: string[] = [];
	const traces = tracesOf(scene);
	const lines = piecesOf(scene).flatMap(({ d }) => linesOf(d));
	const walks = union(
		piecesOf(scene).flatMap(({ d }) =>
			d.surfaces.filter((x) => x.role === 'walk').flatMap((x) => shapeOf(x))
		)
	);
	for (const ground of piecesOf_(crossed)) {
		const others = subtract(all, offset(ground, 0.05));
		const meets = traces.flatMap((t) => {
			const pts = stepsAlong(t.pts);
			const k = pts.findIndex(({ p }) => inside(ground, p));
			if (k < 0) return [];
			const at = pts[k].p;
			const ways = backFrom(t, pts[k].i, at, traces, REACH);
			// Not where traffic meets it first: it comes back onto it upstream.
			const steps = ways.map((w) => stepsAlong(w));
			if (steps.some((w) => w.some(({ p, s }) => s > 0.3 && inside(ground, p)))) return [];
			// The way it heads there, read back from the point before where
			// it meets the crossing at its last.
			const [p0, p1] = k + 1 < pts.length ? [at, pts[k + 1].p] : [pts[Math.max(0, k - 1)].p, at];
			const l = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
			const dir = { x: (p1.x - p0.x) / l, y: (p1.y - p0.y) / l };
			// Across the lane's width at its edges and middle: from a little
			// way past where it meets the crossing back up the traffic, where
			// it leaves the crossing (`a`; an edge running past it, level with
			// where the middle meets it) and where it next meets another
			// crossing or its ground ends (`b`).
			const ahead = pts.filter(({ s }) => s >= pts[k].s && s <= pts[k].s + 10).map(({ p }) => p);
			const half = Math.max(0, widthAt(t, at) / 2 - 0.15);
			const edges = ways.flatMap((w) =>
				[-half, 0, half].map((o) => {
					const line = shifted([...[...ahead].reverse(), ...w], o);
					const walk = stepsAlong(line);
					let i = walk.findIndex(({ p }) => inside(ground, p));
					while (i >= 0 && i + 1 < walk.length && inside(ground, walk[i + 1].p)) i++;
					if (i < 0 && o !== 0) {
						const level = line[ahead.length];
						i = walk.reduce(
							(b, { p }, x) =>
								Math.hypot(p.x - level.x, p.y - level.y) <
								Math.hypot(walk[b].p.x - level.x, walk[b].p.y - level.y)
									? x
									: b,
							0
						);
					}
					if (i < 0) return null;
					const j = walk.findIndex(({ p }, x) => x > i && inside(others, p));
					return { a: walk[i].p, b: walk[j < 0 ? walk.length - 1 : j].p };
				})
			);
			const found = edges.filter((e) => e !== null);
			return found.length ? [{ t, at, ways, dir, edges: found }] : [];
		});
		for (const m of meets) {
			const of = (p: Pt) => p.x * m.dir.x + p.y * m.dir.y;
			const side = { x: -m.dir.y, y: m.dir.x };
			// The lanes of its stream: running its way beside it, no walkway
			// between.
			const apart = (p: Pt, q: Pt) =>
				Array.from({ length: 11 }, (_, k) => add(p, { x: q.x - p.x, y: q.y - p.y }, k / 10)).some(
					(x) => inside(walks, x)
				);
			const stream = meets.filter(
				(o) =>
					o.dir.x * m.dir.x + o.dir.y * m.dir.y > 0.7 &&
					Math.abs((o.at.x - m.at.x) * side.x + (o.at.y - m.at.y) * side.y) < 12 &&
					!apart(o.at, m.at)
			);
			const first = Math.min(...stream.flatMap((o) => o.edges.map((e) => of(e.a))));
			const room = !stream.some((o) =>
				o.edges.some((e) => of(e.b) > first - signRoom('yield') - 0.2)
			);
			const count = lines.filter((s) =>
				m.ways.some((w) => {
					const near = stepsAlong(w).filter(({ s }) => s <= REACH);
					const clear = near.findIndex(({ p }, k) => k > 0 && inside(others, p));
					const upTo = clear < 0 ? near : near.slice(0, clear + 1);
					return upTo.some(({ p }, k) => k > 0 && segmentsMeet(upTo[k - 1].p, p, s.a, s.b));
				})
			).length;
			if (count > 1) out.push(`${count} lines for ${m.t.name}`);
			if (count === 0 && room) out.push(`no line for ${m.t.name}`);
		}
	}
	return out;
}

// A lane's width where a trace runs, at the point of it nearest `p`.
function widthAt(t: Trace, p: Pt) {
	let best = 0;
	t.pts.forEach((q, i) => {
		const [d, e] = [
			Math.hypot(q.x - p.x, q.y - p.y),
			Math.hypot(t.pts[best].x - p.x, t.pts[best].y - p.y)
		];
		if (d < e) best = i;
	});
	return t.widths[best];
}

// The ground along a path, as wide as its widths and a line's width more.
function stripOf(line: Pt[], widths: number[]) {
	const side = (sign: number) =>
		line.map((p, i) => {
			const [a, b] = [line[Math.max(0, i - 1)], line[Math.min(line.length - 1, i + 1)]];
			const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
			return add(p, { x: -(b.y - a.y) / l, y: (b.x - a.x) / l }, sign * (widths[i] / 2 + 0.15));
		});
	return [...side(-1), ...side(1).reverse()];
}

// A polyline moved `o` metres to its right.
function shifted(line: Pt[], o: number) {
	if (!o) return line;
	return line.map((p, i) => {
		const [a, b] = [line[Math.max(0, i - 1)], line[Math.min(line.length - 1, i + 1)]];
		const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
		return add(p, { x: -(b.y - a.y) / l, y: (b.x - a.x) / l }, o);
	});
}
// Whether two segments meet, an end on the other counting.
function segmentsMeet(a: Pt, b: Pt, c: Pt, d: Pt) {
	const side = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
	return side(c, d, a) * side(c, d, b) <= 0 && side(a, b, c) * side(a, b, d) <= 0;
}
const piecesOf_ = (paths: Paths) =>
	union(paths)
		.filter((p) => area(p) > 0.05)
		.map((p) => [p]);

// How far along a ray from `p` heading `u` it leaves the first crossing it
// meets within `max`, or 0.
function throughOf(crossed: Paths, p: Pt, u: Pt, max: number) {
	let t = 0;
	while (t <= max && !inside(crossed, add(p, u, t))) t += 0.1;
	if (t > max) return 0;
	while (inside(crossed, add(p, u, t))) t += 0.1;
	return t;
}

// No paint of any kind lies between a line and its crossing across its
// carriageway (acrossOf): rays from the line's front, every quarter metre
// across it, the way its traffic drives, up to the crossing they meet, and
// no further than the crossing reaches across the line's own lanes.
function clearAhead(scene: Scene, crossed: Paths) {
	const out: string[] = [];
	const paint = union(
		piecesOf(scene).flatMap(({ d }) => [
			...paintOf({ ...d, signs: d.signs.filter((x) => x.kind === 'arrow') })
				.flatMap((p) => p.rings)
				.map(toPath),
			...d.surfaces.flatMap((x) => (x.bars?.rings ?? []).map(toPath))
		])
	);
	const grounds = piecesOf_(crossed);
	for (const piece of piecesOf(scene))
		for (const s of linesOf(piece.d)) {
			const ahead = aheadOf(scene, s);
			if (!ahead) continue;
			// The crossing it stands for: the first its own lanes meet ahead.
			const span = [0, 0.25, 0.5, 0.75, 1].map((f) =>
				add(s.a, { x: s.b.x - s.a.x, y: s.b.y - s.a.y }, f)
			);
			const first = grounds
				.map((g) => ({ g, t: Math.min(...span.map((p) => firstIn(g, p, ahead, 12))) }))
				.sort((x, y) => x.t - y.t)[0];
			if (!first || !Number.isFinite(first.t)) continue;
			const g = first.g;
			const far = Math.max(...span.map((p) => throughOf(g, p, ahead, 12)));
			const [a, b] = acrossOf(scene, s);
			const l = Math.hypot(b.x - a.x, b.y - a.y);
			const e = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
			const back = { x: -ahead.x, y: -ahead.y };
			const rays = Array.from({ length: Math.ceil(l / 0.25) + 1 }, (_, k) => {
				const p = add(add(a, e, Math.min(l, k * 0.25)), ahead, 0.35);
				// Where the crossing lies behind the line, nothing of it is.
				if (Number.isFinite(firstIn(g, p, back, 12))) return null;
				// Only where the crossing lies straight ahead, up to it.
				const hit = firstIn(g, p, ahead, far);
				return Number.isFinite(hit) ? { p, t: hit - 0.35 } : null;
			});
			const strips = rays.flatMap((r, k) => {
				const q = rays[k - 1];
				return r && q && r.t > 0 && q.t > 0
					? [toPath([q.p, r.p, add(r.p, ahead, r.t), add(q.p, ahead, q.t)])]
					: [];
			});
			if (!strips.length) continue;
			const lying = intersect(offset(union(strips), -0.02), paint).reduce((t, p) => t + area(p), 0);
			if (lying > 0.02)
				out.push(`paint between ${piece.id}'s line and its crossing: ${lying.toFixed(2)} m²`);
		}
	return out;
}

// How far along a ray from `p` heading `u` it first enters some ground
// within `max`, or Infinity.
function firstIn(ground: Paths, p: Pt, u: Pt, max: number) {
	for (let t = 0; t <= max; t += 0.05) if (inside(ground, add(p, u, t))) return t;
	return Infinity;
}

function faults(graph: GraphData, base: Scene, paths: [Pt, Pt][]) {
	const { scene } = buildModel(withPaths(graph, paths));
	const out = check(scene).filter((p) => RULES.some((k) => p.includes(k)));
	const own = new Set(groundOf(base).map(ringKey));
	const crossed = union(
		groundOf(scene)
			.filter((r) => !own.has(ringKey(r)))
			.map(toPath)
	);
	const all = union(groundOf(scene).map(toPath));
	out.push(...heldOnce(scene, crossed, all), ...clearAhead(scene, crossed));
	const on = cleared(scene, crossed);
	const now = piecesOf(scene);
	for (const piece of piecesOf(base))
		for (const m of piece.d.markings) {
			const mine = now.find((p) => p.id === piece.id)?.d.markings ?? [];
			const ends = [m.line[0], m.line.at(-1)!];
			const crumb = (p: Pt) =>
				ends.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1.3) ||
				(!!piece.road &&
					[0, piece.road.path.length].some(
						(s) => Math.abs(project(piece.road!.path, p).s - s) < 1.3
					));
			const lost = pointsOf(m.line).filter(
				(p) => !mine.some((k) => onLine(p, k)) && !crumb(p) && !inside(on, p)
			);
			if (lost.length >= 2)
				out.push(`paint lost on ${piece.id} at (${lost[0].x.toFixed(1)}, ${lost[0].y.toFixed(1)})`);
		}
	return out;
}

// Arrangements where a rule once failed, as further steps of the sweep: a
// footpath from `from` to `to` across the fixture named.
const reported: [string, Pt, Pt][] = [
	['widening', { x: -19.5, y: -22 }, { x: 20.5, y: 22 }],
	['widening', { x: -18, y: -22 }, { x: 2, y: 22 }],
	['widening', { x: -20.5, y: -22 }, { x: 19.5, y: 22 }],
	['widening', { x: -31, y: -22 }, { x: 9, y: 22 }],
	['hatched tee', { x: -14, y: -22 }, { x: -14, y: 22 }],
	['four lanes to two at a tee', { x: 11.5, y: -22 }, { x: 11.5, y: 22 }],
	['divided tee, one carriageway crossed', { x: -7, y: 0 }, { x: -7, y: 20 }],
	['divided tee, one carriageway crossed', { x: -12, y: 0 }, { x: -12, y: 20 }],
	['divided tee, both carriageways eastward', { x: -12, y: 0 }, { x: -12, y: 20 }],
	// Its westbound line falls on the node of two sides it is drawn off.
	['Avenue to Street', { x: -15.5, y: -26 }, { x: -15.5, y: 22 }],
	['Avenue to Street', { x: -15, y: -26 }, { x: -15, y: 22 }]
];

for (const [name, { graph: stored, from }] of Object.entries(fixtures))
	for (const [way, graph] of [
		['stored', stored],
		['reversed', reversed(stored)]
	] as const)
		test(`${name}, ${way}: a footpath slid along it holds each lane by one line, clearing only its carriageway`, () => {
			const { scene: base } = buildModel(graph);
			const found: string[] = [];
			const steps: [Pt, Pt][] = [
				...[0, -20, 40].flatMap((tilt) =>
					Array.from({ length: 11 }, (_, i) => -20 + 4 * i).map((x): [Pt, Pt] => [
						{ x: x - tilt / 2, y: from },
						{ x: x + tilt / 2, y: 22 }
					])
				),
				...reported.filter(([n]) => n === name).map(([, a, b]): [Pt, Pt] => [a, b])
			];
			for (const [a, b] of steps)
				for (const f of faults(graph, base, [[a, b]]))
					found.push(`(${a.x}, ${a.y}) to (${b.x}, ${b.y}): ${f}`);
			expect(found).toEqual([]);
		});

// Two footpaths crossing a straight four-lane street side by side, at a
// slant and square, a range of gaps apart: two crossings, each with its own
// line each way wherever there is room for it between them, and one line
// standing for both where there is none.
test('two crossings side by side each hold the traffic, one line each way where room allows', () => {
	const street = {
		nodes: [node('a', -60, 0), node('b', 60, 0)],
		segments: [segment('street', 'a', 'b', wide)]
	};
	const { scene: base } = buildModel(street);
	const found: string[] = [];
	for (const tilt of [44, 0, -30])
		for (let gap = 4; gap <= 16; gap += 1.5) {
			const paths: [Pt, Pt][] = [0, gap].map((x) => [
				{ x: x - tilt / 2, y: -22 },
				{ x: x + tilt / 2, y: 22 }
			]);
			for (const f of faults(street, base, paths)) found.push(`tilt ${tilt}, gap ${gap}: ${f}`);
		}
	expect(found).toEqual([]);
});

test('a crossing over a hatched buffer clears the hatching from its lines up to it', () => {
	const lanes = [
		walk('L'),
		drive('B', 'backward'),
		// Asphalt: a painted, hatched buffer.
		lane('M', 'buffer', 2, 'bidirectional'),
		drive('F', 'forward'),
		walk('R')
	];
	for (let x = -2; x <= 2; x += 0.25) {
		const { scene } = buildModel(
			withPath(
				{
					nodes: [node('a', -50, 0), node('b', 50, 0)],
					segments: [segment('road', 'a', 'b', lanes)]
				},
				{ x, y: -20 },
				{ x, y: 20 }
			)
		);
		const d = scene.road('road')!;
		const bars = d.surfaces.flatMap((s) => s.bars?.rings ?? []);
		const kept = [...d.crossings.flatMap((c) => c.body), ...(d.cleared ?? [])];
		expect(kept.length).toBeGreaterThan(0);
		const under = intersect(bars.map(toPath), kept.map(toPath)).reduce((t, p) => t + area(p), 0);
		expect([x, under]).toEqual([x, expect.closeTo(0, 2)]);
	}
});

test('a lane line ending beside a crossing of the other carriageway ends mid-road', () => {
	const lanes = divided;
	const graph: GraphData = {
		nodes: [node('a', -50, 0), node('b', 50, 0)],
		segments: [segment('car', 'a', 'b', lanes)]
	};
	for (const path of [false, true]) {
		const { scene } = buildModel(path ? withPath(graph, { x: 0, y: 0 }, { x: 0, y: 22 }) : graph);
		const d = scene.road('car')!;
		// The dashed line between the lanes of the carriageway the footpath
		// leaves alone, cut short of x = -2.
		const m = d.markings.find((k) => k.dashed && k.line[0].y < 0)!;
		const n = m.line.findIndex((p) => p.x > -2);
		const stub = { ...m, line: m.line.slice(0, n), along: m.along.slice(0, n) };
		const broken = { ...d, markings: d.markings.map((k) => (k === m ? stub : k)) };
		const found = check({ ...scene, road: (id) => (id === 'car' ? broken : scene.road(id)) });
		expect([path, found.filter((f) => f.startsWith('line ends mid-road'))]).toEqual([
			path,
			[expect.stringContaining('line ends mid-road: car')]
		]);
	}
});

// A junction's own walkways across the mouths of roads whose lanes carry on
// through it (the neighbourhood's node-53, its two arms divided by a
// median): the roads' paint, lines round a median's nose and hatching
// alike, stops short of the zebras, and no more of it than the zebras and
// the gap a road's paint keeps behind one (0.3 m) is taken away.
test("a junction's walkways over carried roads clear their paint and nothing past it", () => {
	const raw = JSON.parse(readFileSync('static/examples/neighbourhood.json', 'utf8'));
	for (const median of ['concrete', 'asphalt'] as const) {
		const g = withoutFootpaths(raw.graph ?? raw);
		const ids = ['segment-110', 'segment-112', 'segment-114', 'segment-116'];
		g.segments = g.segments.filter((s) => ids.includes(s.id));
		g.nodes = g.nodes.filter((n) =>
			g.segments.some((s) => s.startNodeId === n.id || s.endNodeId === n.id)
		);
		for (const s of g.segments)
			if (s.id === 'segment-112' || s.id === 'segment-116') s.lanes[3].material = median;
		const { scene, derived } = buildModel(g);
		const zebras = union(scene.node('node-53')!.crossings.flatMap((c) => c.body.map(toPath)));
		expect(zebras.length).toBeGreaterThan(0);
		expect([median, check(scene).filter((p) => p.includes('on a crossing'))]).toEqual([median, []]);
		for (const id of ['segment-112', 'segment-116']) {
			const d = scene.road(id)!;
			const road = derived.place.roads.find((r) => r.id === id)!;
			const paintOn = (x: Description) =>
				union([
					...paintOf({ ...x, signs: [] })
						.flatMap((p) => p.rings)
						.map(toPath),
					...x.surfaces.flatMap((s) => (s.bars?.rings ?? []).map(toPath))
				]);
			const on = intersect(paintOn(d), offset(zebras, -0.01)).reduce((t, p) => t + area(p), 0);
			expect([median, id, on]).toEqual([median, id, expect.closeTo(0, 2)]);
			// The road as drawn with nothing at its ends: what the zebras
			// and their gap don't cover of it is all still drawn.
			const whole = describeRoad(road, d.path, {
				start: { ...d.cut.start, clear: undefined },
				end: { ...d.cut.end, clear: undefined }
			});
			const bars = (x: Description) =>
				union(x.surfaces.flatMap((s) => (s.bars?.rings ?? []).map(toPath)));
			const lost = subtract(bars(whole), union([...bars(d), ...offset(zebras, 0.35)])).reduce(
				(t, p) => t + area(p),
				0
			);
			expect([median, id, lost]).toEqual([median, id, expect.closeTo(0, 1)]);
		}
	}
});

// One owner per ground, read on a crossing: a crossing's refuge paving,
// drawn a centimetre wider under its own stripes, may lap them (a Highway's
// median crossed at a slant), and two crossings may meet so, but paving
// lapping paving, stripes lapping stripes, or one crossing lying on another
// is reported.
test("a crossing's paving under its own stripes is no double cover; lapping another crossing is", () => {
	const graph = street(avenue, highway);
	const found: string[] = [];
	// Of two crossings of one footpath meeting on a node, each paved a
	// centimetre wider where they meet, as for a crossing's own stripes.
	for (const [name, g] of [
		['Avenue to Highway', graph],
		['Highway to Avenue', street(highway, avenue)]
	] as const)
		for (const tilt of [0, 20, 40])
			for (let x = -8; x <= 24; x += 2) {
				const { scene } = buildModel(
					withPath(g, { x: x - tilt / 2, y: -26 }, { x: x + tilt / 2, y: 22 })
				);
				for (const f of check(scene).filter((p) => p.startsWith('double cover')))
					found.push(`${name}, tilt ${tilt}, x ${x}: ${f}`);
			}
	expect(found).toEqual([]);
	const { scene } = buildModel(withPath(graph, { x: -4, y: -26 }, { x: 36, y: 22 }));
	const road = scene.road('east')!;
	const crossing = road.crossings.find((c) => c.runs.some((r) => r.kind === 'paved'))!;
	const zebra = crossing.runs.find((r) => r.kind === 'zebra')!;
	const paved = crossing.runs.find((r) => r.kind === 'paved')!;
	const lapping = [
		// Another crossing paved over this one's stripes.
		[...road.crossings, { ...crossing, id: 'other', runs: [{ ...paved, rings: zebra.rings }] }],
		// Its paving drawn twice over.
		road.crossings.map((c) =>
			c === crossing ? { ...c, runs: [...c.runs, { ...paved, rings: paved.rings }] } : c
		),
		// Its stripes lapping each other.
		road.crossings.map((c) =>
			c === crossing ? { ...c, runs: [...c.runs, { ...zebra, rings: zebra.rings.slice(0, 1) }] } : c
		)
	];
	for (const crossings of lapping) {
		const wrong = { ...road, crossings };
		expect(
			check({ ...scene, road: (id) => (id === 'east' ? wrong : scene.road(id)) }).filter((f) =>
				f.startsWith('double cover: east crossings')
			)
		).toHaveLength(1);
	}
});

// The drawing rules hold the same statement (road-model/checks.ts): lane
// paint put back where a crossing was drawn over it is reported.
test('lane paint running across a zebra is reported', () => {
	const graph: GraphData = {
		nodes: [node('a', -50, 0), node('b', 50, 0)],
		segments: [segment('car', 'a', 'b', plain)]
	};
	const { scene: bare } = buildModel(graph);
	const { scene } = buildModel(withPath(graph, { x: 0, y: -22 }, { x: 0, y: 22 }));
	expect(check(scene)).toEqual([]);
	const road = scene.road('car')!;
	const wrong = { ...road, markings: bare.road('car')!.markings };
	const found = check({ ...scene, road: (id) => (id === 'car' ? wrong : scene.road(id)) });
	expect(found.filter((f) => f.startsWith('paint on a crossing: car'))).toHaveLength(1);
});

// The drawing kept from edit to edit, as the editor keeps it, is the one a
// fresh build of the same graph draws after every edit: a footpath laid
// across, slid along the street through the node or junction and out the
// other side, square and at a slant, a second laid beside it, one taken
// away, then the last (the lines and clearing a crossing gave every piece go
// with it), and one laid again.
const differ = (a: Map<string, unknown>, b: Map<string, unknown>) =>
	[...new Set([...a.keys(), ...b.keys()])].filter((id) => !Bun.deepEquals(a.get(id), b.get(id)));
for (const [name, { graph: stored, from }] of Object.entries(fixtures))
	for (const [way, graph] of [
		['stored', stored],
		['reversed', reversed(stored)]
	] as const)
		test(`${name}, ${way}: kept from edit to edit, the drawing is a fresh build's`, () => {
			const across = (x: number, tilt = 0): [Pt, Pt] => [
				{ x: x - tilt / 2, y: from },
				{ x: x + tilt / 2, y: 22 }
			];
			const steps: [Pt, Pt][][] = [
				[],
				...[-16, -12, -9, -6, -3, 0, 3, 6, 9, 12, 16].map((x) => [across(x)]),
				[across(4, 20)],
				[],
				[across(-9)],
				[across(-9), across(-1)],
				[across(-1)],
				[],
				[across(-6, -20), across(6)],
				[across(6)],
				[]
			];
			const kept = editorDrawing();
			const found: string[] = [];
			steps.forEach((paths, i) => {
				const g = liveShape(withPaths(graph, paths));
				for (const id of differ(pieces(kept(g)), pieces(editorDrawing()(g))))
					found.push(`step ${i}: ${id} differs from a fresh build`);
			});
			expect(found).toEqual([]);
		});

// Room for a line is read on the lanes a crossing lies across: a street's
// own crosswalk of one carriageway of a street with a walkway down its
// middle blocks nothing on the other, so the lines a footpath across the
// other gets are those it gets with no crosswalk there, wherever along the
// street either lies, the street stored either way round. On its own
// carriageway it still blocks: there, no line stands in its room.
test("a street's crosswalk of one carriageway leaves the other's room alone", () => {
	const lines = (graph: GraphData) =>
		linesOf(buildModel(graph).scene.road('car')!)
			.map((s) => JSON.stringify([s.kind, s.lanes.map((l) => l.lane), s.a, s.b]))
			.sort();
	const found: string[] = [];
	for (const lanes of [divided, eastward]) {
		const base: GraphData = {
			nodes: [node('a', -50, 0), node('b', 50, 0)],
			segments: [segment('car', 'a', 'b', lanes)]
		};
		for (const flip of [false, true]) {
			const graph = flip
				? reversed({ ...base, segments: [{ ...base.segments[0], id: 'west' }] })
				: base;
			const g = flip
				? { ...graph, segments: graph.segments.map((s) => ({ ...s, id: 'car' })) }
				: graph;
			// The walkways each side of the carriageway at negative y, in the
			// street's own order.
			const order = g.segments[0].lanes.map((l) => l.id);
			const sides = flip ? ['M', 'L'] : ['L', 'M'];
			const joins = sides.map((id) => order[order.indexOf(id)]) as [string, string];
			for (const walkAt of [-6, 0, 6]) {
				const crosswalk = {
					...g,
					nodes: g.nodes.map((n) =>
						n.id === (flip ? 'b' : 'a')
							? {
									...n,
									junction: {
										crossings: [
											{ road: 'car', end: 'start', lanes: joins, at: 50 + walkAt, on: true }
										]
									}
								}
							: n
					)
				} as GraphData;
				for (let x = -8; x <= 8; x += 1) {
					const path = (graph: GraphData) => withPath(graph, { x, y: 0 }, { x, y: 22 });
					const alone = lines(path(g));
					expect(alone.length).toBeGreaterThan(0);
					const beside = lines(path(crosswalk));
					if (JSON.stringify(beside) !== JSON.stringify(alone))
						found.push(`${flip ? 'reversed' : 'stored'}, crosswalk at ${walkAt}, path at ${x}`);
				}
			}
		}
	}
	expect(found).toEqual([]);
	// On its own carriageway the crosswalk at x = 0 leaves no room for a
	// footpath's line standing 2 m beyond it.
	const own: GraphData = {
		nodes: [
			{
				...node('a', -50, 0),
				junction: {
					crossings: [{ road: 'car', end: 'start', lanes: ['M', 'R'], at: 50, on: true }]
				}
			},
			node('b', 50, 0)
		] as GraphData['nodes'],
		segments: [segment('car', 'a', 'b', divided)]
	};
	const eastbound = (g: GraphData) =>
		linesOf(buildModel(g).scene.road('car')!).filter((s) => s.lanes.some((l) => l.lane === 'F'));
	expect(
		eastbound(
			withPath(
				{ ...own, nodes: own.nodes.map((n) => ({ ...n, junction: undefined })) },
				{ x: 3.5, y: 0 },
				{ x: 3.5, y: 22 }
			)
		)
	).toHaveLength(1);
	expect(eastbound(withPath(own, { x: 3.5, y: 0 }, { x: 3.5, y: 22 }))).toHaveLength(0);
});

// A line needs its whole depth on the road its traffic comes in on: at a T
// whose west arm runs only some metres from its free end, a footpath across
// the arm just clear of the junction's mouth (wholly on the arm, so a
// crossing) holds the lanes coming in to the junction by one line where the
// arm has room behind it for one, and by none where it does not (takenOver
// in road-model/holds.ts). Swept over the arm's length and where the
// footpath lies, the arm stored either way round: the drawing rules hold at
// every step (no paint off the road), the line comes once the arm is long
// enough and stays as it grows, and the longest arm has it.
test('a crossing on a short arm near a junction gets the line it has room for, and none it has not', () => {
	const found: string[] = [];
	const reversed = (lanes: Lane[]) =>
		[...lanes].reverse().map((l) => ({
			...l,
			direction:
				l.direction === 'forward'
					? 'backward'
					: l.direction === 'backward'
						? 'forward'
						: l.direction
		})) as Lane[];
	const tee = (end: number, flip: boolean): GraphData => ({
		nodes: [node('a', end, 0), node('j', 0, 0), node('b', 50, 0), node('c', 0, 50)],
		segments: [
			flip ? segment('west', 'j', 'a', reversed(plain)) : segment('west', 'a', 'j', plain),
			segment('east', 'j', 'b', plain),
			segment('south', 'j', 'c', plain)
		]
	});
	const { scene: bare } = buildModel(tee(-30, false));
	const mouth = Math.min(
		...(bare.node('j')?.surfaces ?? [])
			.filter((x) => x.role === 'lane' || x.role === 'paving')
			.flatMap((x) => shapeOf(x).flat())
			.map((q) => q.X / 1000)
	);
	for (const flip of [false, true])
		for (const d of [1.5, 3, 5]) {
			const x = mouth - d;
			const held: number[] = [];
			for (let end = Math.ceil(x) - 2; end >= -26; end -= 1) {
				const { scene } = buildModel(withPath(tee(end, flip), { x, y: -8 }, { x, y: 8 }));
				const label = `${flip ? 'reversed' : 'stored'}, arm to ${end}, path at ${x.toFixed(2)}`;
				for (const p of check(scene).filter(
					(p) => p.startsWith('paint outside') || RULES.some((k) => p.includes(k))
				))
					found.push(`${label}: ${p}`);
				const crossings = scene.walking().runsOf('path0');
				if (crossings.length !== 1) found.push(`${label}: ${crossings.length} crossings`);
				// The lines across the west arm's lanes coming in to the junction.
				const lines = piecesOf(scene)
					.flatMap(({ d }) => linesOf(d))
					.filter((s) => s.lanes.some((l) => l.road === 'west' && l.lane === 'F'));
				held.push(lines.length);
			}
			const label = `${flip ? 'reversed' : 'stored'}, path ${d} m out`;
			const first = held.indexOf(1);
			if (held.some((k) => k > 1)) found.push(`${label}: two lines`);
			if (first <= 0) found.push(`${label}: lines ${held.join('')}`);
			else if (held.slice(first).some((k) => k !== 1))
				found.push(`${label}: lines ${held.join('')}`);
		}
	expect(found).toEqual([]);
});

// A line is paint: on a street whose car lanes are narrower than a tooth of
// a give-way row, each lane meeting a crossing still has a line (as many
// teeth as fit, one at least), and the rules count a row described with no
// paint as no line.
test('a give-way row across a narrow lane is painted', () => {
	const found: string[] = [];
	for (const width of [0.6, 0.8, 1, 1.4, 2.5]) {
		const lanes = [
			walk('L'),
			lane('B', 'vehicle', width, 'backward'),
			lane('F', 'vehicle', width, 'forward'),
			walk('R')
		];
		const street: GraphData = {
			nodes: [node('a', -50, 0), node('b', 50, 0)],
			segments: [segment('car', 'a', 'b', lanes)]
		};
		const { scene: base } = buildModel(street);
		for (const f of faults(street, base, [
			[
				{ x: 0, y: -22 },
				{ x: 0, y: 22 }
			]
		]))
			found.push(`${width} m: ${f}`);
		const { scene } = buildModel(withPath(street, { x: 0, y: -22 }, { x: 0, y: 22 }));
		for (const p of check(scene)) found.push(`${width} m: ${p}`);
		expect([width, linesOf(scene.road('car')!).length]).toEqual([width, 2]);
	}
	expect(found).toEqual([]);
	// A row with nothing to paint is reported.
	const graph: GraphData = {
		nodes: [node('a', -50, 0), node('b', 50, 0)],
		segments: [segment('car', 'a', 'b', plain)]
	};
	const { scene } = buildModel(withPath(graph, { x: 0, y: -22 }, { x: 0, y: 22 }));
	const road = scene.road('car')!;
	const row = road.signs.find((s): s is Held => s.kind === 'yield')!;
	const empty = { ...road, signs: [...road.signs, { ...row, b: row.a }] };
	expect(check({ ...scene, road: (id) => (id === 'car' ? empty : scene.road(id)) })).toEqual([
		'yield line with no paint: car'
	]);
});

// No line lies anywhere on a crossing's ground, between its stripes too;
// and of the paint between a line and its crossing only what hugs a raised
// median's nose is let be: a median running on under the crossing has none
// there, so a line along it into that ground is reported.
test('paint on a crossing between its stripes, or beside a median that has no nose there, is reported', () => {
	const graph: GraphData = {
		nodes: [node('a', -50, 0), node('b', 50, 0)],
		segments: [segment('car', 'a', 'b', plain)]
	};
	const { scene } = buildModel(withPath(graph, { x: 0, y: -22 }, { x: 0, y: 22 }));
	expect(check(scene)).toEqual([]);
	const road = scene.road('car')!;
	const bar: Sign = {
		kind: 'stop',
		lanes: [{ road: 'car', end: 'end', lane: 'F' }],
		a: { x: 0, y: 0.2 },
		b: { x: 0, y: 0.45 }
	};
	const barred = { ...road, signs: [...road.signs, bar] };
	expect(
		check({ ...scene, road: (id) => (id === 'car' ? barred : scene.road(id)) }).filter((p) =>
			p.startsWith('stop on a crossing')
		)
	).toHaveLength(1);

	const median = [
		walk('L'),
		drive('B', 'backward'),
		lane('M', 'buffer', 2, 'bidirectional'),
		drive('F', 'forward'),
		walk('R')
	].map((l) => (l.id === 'M' ? { ...l, material: 'concrete' } : l)) as Lane[];
	const raised: GraphData = {
		nodes: [node('a', -50, 0), node('b', 50, 0)],
		segments: [segment('car', 'a', 'b', median)]
	};
	const { scene: split } = buildModel(withPath(raised, { x: 0, y: -22 }, { x: 0, y: 22 }));
	expect(check(split)).toEqual([]);
	const d = split.road('car')!;
	for (const y of [1.15, 1.2, 1.3]) {
		const line: Marking = {
			colour: 'white',
			dashed: false,
			line: [
				{ x: -50, y },
				{ x: -1.08, y }
			],
			along: [0, 48.92]
		};
		const marked = {
			...d,
			markings: [...d.markings.filter((m) => Math.abs(m.line[0].y - y) > 0.15), line]
		};
		expect([
			y,
			check({ ...split, road: (id) => (id === 'car' ? marked : split.road(id)) }).some((p) =>
				p.startsWith('paint between a line and its crossing')
			)
		]).toEqual([y, true]);
	}
});

// A crossing on a road holds the traffic meeting it with one line across
// every lane of the stream its paint lies across, or with none: the whole
// marking lies on the road or is not drawn. A footpath laid along a lane to
// the road's free end leaves that lane no room for a line, and then its
// neighbours have none either. Swept over the presets stored either way,
// footpaths 2, 4 and 8 m wide at slants either way, slid from the middle of
// the road out past its free end.
test('a crossing on a road holds every lane of a stream its paint lies across, or none of them', () => {
	const problems: string[] = [];
	for (const kind of ['street', 'avenue', 'highway', 'lane'])
		for (const flip of [false, true])
			for (const width of [2, 4, 8])
				for (const angle of [45, 135])
					for (let x = 20; x <= 80; x += 7.5) {
						const lanes = createLanesFrom(kind).map((l, i) => ({ ...l, id: `l${i}` }));
						const d = {
							x: Math.cos((angle * Math.PI) / 180),
							y: Math.sin((angle * Math.PI) / 180)
						};
						const graph: GraphData = {
							nodes: [
								node('a', 0, 0),
								node('b', 80, 0),
								node('p', x - d.x * 45, -d.y * 45),
								node('q', x + d.x * 45, d.y * 45)
							],
							segments: [
								flip
									? segment(
											'r',
											'b',
											'a',
											[...lanes].reverse().map((l) => ({
												...l,
												direction:
													l.direction === 'forward'
														? 'backward'
														: l.direction === 'backward'
															? 'forward'
															: l.direction
											}))
										)
									: segment('r', 'a', 'b', lanes),
								segment('w', 'p', 'q', [walk('w', width)], {
									controls: [{ roads: ['r'], control: 'stop' }]
								})
							]
						};
						const { scene } = buildModel(graph);
						const road = scene.road('r')!;
						const paint = union(
							road.crossings.filter((c) => c.of).flatMap((c) => c.body.map(toPath))
						);
						// The car lanes the paint lies across, by direction as stored.
						const dirOf = new Map(graph.segments[0].lanes.map((l) => [l.id, l.direction]));
						const covered = new Set(
							road.surfaces
								.filter(
									(s) =>
										s.role === 'lane' &&
										s.lane &&
										intersect(shapeOf(s), paint).reduce((n, p) => n + area(p), 0) > 0.05
								)
								.map((s) => s.lane!.lane)
						);
						for (const sign of road.signs.filter((s) => s.kind === 'stop')) {
							const held = new Set(sign.lanes.map((l) => l.lane));
							const dir = dirOf.get(sign.lanes[0].lane);
							const left = [...covered].filter((l) => dirOf.get(l) === dir && !held.has(l));
							if (left.length)
								problems.push(
									`${kind}${flip ? ' flipped' : ''}, ${width} m at ${angle}°, x ${x}: a line holds ${[...held].join(', ')} but not ${left.join(', ')}`
								);
						}
					}
	expect(problems).toEqual([]);
});
