import { expect, test } from 'bun:test';
import { copySegments, layPaste } from '../src/lib/clipboard';
import { resolveCrossings } from '../src/lib/core/crossings';
import { dragNodes, ridersOf } from '../src/lib/core/drag';
import { joinPlan } from '../src/lib/core/join';
import { Graph } from '../src/lib/core/graph.svelte';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { carries } from '../src/lib/core/lane-types';
import { Networks } from '../src/lib/core/networks';
import { closestOnRoad, roadAt, sideOf } from '../src/lib/core/road-line';
import { roadwayOf } from '../src/lib/core/attach';
import { splitSegment } from '../src/lib/core/crossings';
import {
	intersect,
	offset,
	piecesOf as piecesOfPaths,
	toPath,
	union
} from '../src/lib/road-model/clip';
import { bandOf, crossingsHeldBy } from '../src/lib/core/runs';
import type { GraphData, Lane } from '../src/lib/core/types';
import { STOP_ROOM } from '../src/lib/road-model/approach';
import { frameAt, project } from '../src/lib/road-model/geometry';
import type { Scene } from '../src/lib/core/networks';
import { buildModel, carDiff, carPart, groundOf, readScene } from './model';
import { openEditor } from './editor.svelte';

// A node holds car roads or footpaths, never both (Graph.createSegment), so
// no footpath operation changes a car road: after each operation the editor
// offers on a footpath, done with the editor's own graph operations, the
// car nodes and car segments are exactly as before it, and no node holds
// both kinds. Over streets straight, curved, shifted, unequally shifted,
// attached at an edge and next to a junction.

const preset = (id: string): Lane[] => createLanesFrom(id).map((l, i) => ({ ...l, id: `l${i}` }));
type Pt = { x: number; y: number };

// The car part of a graph: its car segments and the nodes they meet at, as
// saved, by id.
function carGraph(graph: Graph) {
	const data = graph.toJSON();
	const segments = data.segments.filter((s) => carries(s.lanes));
	const ids = new Set(segments.flatMap((s) => [s.startNodeId, s.endNodeId]));
	const byId = <T extends { id: string }>(list: T[]) =>
		[...list].sort((a, b) => (a.id < b.id ? -1 : 1));
	return { nodes: byId(data.nodes.filter((n) => ids.has(n.id))), segments: byId(segments) };
}

// The nodes holding both kinds of road.
const mixed = (graph: Graph) =>
	[...graph.nodes.values()]
		.filter((n) => {
			const kinds = new Set(n.connectedSegments.map((s) => carries(graph.segments.get(s)!.lanes)));
			return kinds.size > 1;
		})
		.map((n) => n.id);

const street = (offsetStart = 0, offsetEnd = offsetStart, control?: Pt): GraphData => ({
	nodes: [
		{ id: 'w', x: -60, y: 0 },
		{ id: 'e', x: 60, y: 0 }
	],
	segments: [
		{
			id: 'street',
			startNodeId: 'w',
			endNodeId: 'e',
			lanes: preset('street'),
			offsetStart,
			offsetEnd,
			...(control && { controlX: control.x, controlY: control.y })
		}
	]
});

// Two streets 30 m apart, side by side.
const pair: GraphData = {
	nodes: [...street().nodes, { id: 'w2', x: -60, y: 30 }, { id: 'e2', x: 60, y: 30 }],
	segments: [
		...street().segments,
		{ id: 'other', startNodeId: 'w2', endNodeId: 'e2', lanes: preset('street') }
	]
};

// A street whose roadway lies off its line: a 14 m sidewalk on its left, a
// 2 m one on its right, its car lanes between 2.5 and 9.5 m right of its
// line.
const lopsided: GraphData = {
	...street(),
	segments: [
		{
			...street().segments[0],
			lanes: preset('street').map((l, i) => (i === 0 ? { ...l, width: 14 } : l))
		}
	]
};

// Each street to lay footpaths on: its graph, the car segment they go to,
// where along it, how far past its sidewalks a footpath drawn across reaches
// (`far`: far enough to cross a second street), and how many roadways the
// footpaths drawn to its sides and across it cross (`crossed`, one unless
// given: beside a second street, the one drawn to its far side crosses that
// too).
const streets: {
	name: string;
	base: GraphData;
	id: string;
	t: number;
	far?: number;
	crossed?: number;
}[] = [
	{ name: 'a straight street', base: street(), id: 'street', t: 0.4 },
	{ name: 'a curved street', base: street(0, 0, { x: 0, y: 50 }), id: 'street', t: 0.6 },
	{ name: 'a street shifted 16 m off its line', base: street(16), id: 'street', t: 0.4 },
	{ name: 'a street with its roadway off its line', base: lopsided, id: 'street', t: 0.4 },
	{
		name: 'a street shifted 2 m at one end and 6 m at the other',
		base: street(2, 6),
		id: 'street',
		t: 0.4
	},
	{ name: 'two streets side by side', base: pair, id: 'street', t: 0.5, far: 40, crossed: 3 },
	{
		name: 'a ramp attached at the edge of an avenue',
		base: readScene('attached-ramp'),
		id: 'ramp',
		t: 0.6
	},
	{ name: 'a curved ramp attached at an edge', base: readScene('off-ramp'), id: 'ramp', t: 0.4 },
	{ name: 'a street next to its junction', base: readScene('curved-tee'), id: 'side', t: 0.2 },
	{
		name: 'both ramps of a roundabout split',
		base: readScene('roundabout'),
		id: 'entry-ramp-n-a',
		t: 0.3,
		far: 14,
		crossed: 2
	}
];

// Moves nodes as select mode drags them (core/drag.ts), in a few moves: a
// move joins nothing.
function drag(graph: Graph, nodes: string[], by: Pt) {
	const d = dragNodes(graph, nodes, groundOf(graph));
	for (let i = 0; i < 4; i++) d.move(by.x / 4, by.y / 4);
}

// Deletes nodes and segments as the editor's Delete does
// (editor.deleteSelected): a node takes its roads with it, and a node left
// holding nothing goes.
function remove(graph: Graph, nodes: string[], segments: string[]) {
	const ends = new Set<string>();
	for (const id of segments) {
		const s = graph.segments.get(id);
		if (s) ends.add(s.startNodeId).add(s.endNodeId);
		graph.deleteSegment(id);
	}
	for (const id of nodes)
		for (const s of [...(graph.nodes.get(id)?.connectedSegments ?? [])]) {
			const seg = graph.segments.get(s)!;
			ends.add(seg.startNodeId).add(seg.endNodeId);
			graph.deleteSegment(s);
		}
	for (const id of [...nodes, ...ends])
		if (graph.nodes.has(id) && !graph.nodes.get(id)!.connectedSegments.length) graph.deleteNode(id);
}

const footpaths = (graph: Graph) => [...graph.segments.values()].filter((s) => !carries(s.lanes));
// The new nodes two footpaths meet at: none, a crossing being paint.
const crossingNodes = (graph: Graph, was: Set<string>) =>
	[...graph.nodes.values()]
		.filter((n) => !was.has(n.id) && n.connectedSegments.length === 2)
		.map((n) => n.id);

// Every piece the car roads and footpaths are drawn as.
const piecesOf = (scene: Scene) => [
	...scene.place.roads.map((r) => scene.road(r.id)!),
	...scene.place.junctions.map((j) => scene.node(j.id)!)
];
// The crossings drawn with zebra stripes, on whichever car pieces.
const zebrasOf = (scene: Scene) =>
	piecesOf(scene).flatMap((d) =>
		d.crossings.filter((c) => c.runs.some((run) => run.kind === 'zebra'))
	);
// Each zebra drawn, whole: its parts on each car piece, laid by each piece
// of the footpath, joined.
const zebraGround = (scene: Scene) =>
	piecesOfPaths(offset(union(zebrasOf(scene).flatMap((z) => z.body.map(toPath))), 0.05));

for (const { name, base, id, t, far = 8 } of streets)
	test(`every footpath operation on ${name} leaves its car nodes and segments as they were`, () => {
		const graph = new Graph();
		graph.fromJSON(structuredClone(base));
		const before = carGraph(graph);
		const drawn = carPart(buildModel(graph.toJSON()).scene);
		const live = new Networks();
		live.build(graph);
		const states = [graph.toJSON()];
		const failures: string[] = [];
		const step = (label: string, apply: () => void) => {
			apply();
			if (JSON.stringify(carGraph(graph)) !== JSON.stringify(before))
				failures.push(`${label}: the car graph changed`);
			if (mixed(graph).length) failures.push(`${label}: nodes of both kinds ${mixed(graph)}`);
			const diff = carDiff(drawn, carPart(live.build(graph).scene));
			if (diff.length) failures.push(`${label}: drawn ${diff[0]}`);
			states.push(graph.toJSON());
		};
		const was = new Set(graph.nodes.keys());
		const segment = graph.segments.get(id)!;
		const at = roadAt(graph, segment, t)!;
		const reach = segment.totalWidth / 2 + far;
		// `k` metres right of the roadway's middle there, `along` on along it.
		const r = roadwayOf(segment.lanes);
		const point = (k: number, along = 0) => ({
			x: at.point.x + at.normal.x * (k + (r.lo + r.hi) / 2) + at.tangent.x * along,
			y: at.point.y + at.normal.y * (k + (r.lo + r.hi) / 2) + at.tangent.y * along
		});
		// A footpath from 12 m off to the street's side `k` (draw mode's snap:
		// its end on the near sidewalk, or at the curb).
		const toSide = (k: 1 | -1) => {
			const p = sideOf(graph, segment, point(k).x, point(k).y)!;
			const end = graph.createNode(p.x, p.y);
			const out = graph.createNode(point(k * (reach + 12)).x, point(k * (reach + 12)).y);
			resolveCrossings(graph, [graph.createSegment(out.id, end.id, preset('path')).id]);
		};

		step('drawn to its side', () => toSide(1));
		step('drawn to its other side at the same spot', () => toSide(-1));
		let across: string[] = [];
		step('drawn across', () => {
			const [a, b] = [point(reach, 10), point(-reach, 10)].map((p) => graph.createNode(p.x, p.y));
			across = [a.id, b.id];
			resolveCrossings(graph, [graph.createSegment(a.id, b.id, preset('path')).id]);
		});
		// No node in the roadway crossed: the crossing is paint.
		expect([name, crossingNodes(graph, was).length]).toEqual([name, 0]);
		step('pasted 8 m along', () => {
			const clipboard = copySegments({
				graph,
				selectedSegments: new Set(footpaths(graph).map((s) => s.id))
			})!;
			const { segmentIds } = layPaste(
				graph,
				clipboard,
				{ translation: { dx: at.tangent.x * 8, dy: at.tangent.y * 8 }, snap: null },
				true
			);
			resolveCrossings(graph, segmentIds.values());
		});
		step('an end dragged', () => drag(graph, [footpaths(graph)[0].startNodeId], { x: 3, y: -2 }));
		step('a piece dragged', () => {
			// Select mode moves a segment's nodes rigidly, footpath nodes on car
			// roads at them riding along.
			const piece = footpaths(graph).at(-1)!;
			const nodes = [piece.startNodeId, piece.endNodeId];
			const riders = ridersOf(
				graph,
				groundOf(graph),
				nodes.flatMap((n) => graph.nodes.get(n)!.connectedSegments),
				new Set(nodes)
			);
			for (const n of nodes) {
				graph.nodes.get(n)!.x += 2;
				graph.nodes.get(n)!.y -= 1;
			}
			riders.follow();
		});
		step('an end of the one across dragged', () => {
			drag(graph, [across[0]], { x: at.tangent.x * 3 + 1, y: at.tangent.y * 3 - 1 });
		});
		step('an end of the one across deleted', () => remove(graph, [across[1]], []));
		step('a piece deleted', () => remove(graph, [], [footpaths(graph)[0].id]));

		// Undone step by step to the start and redone to the end: each state as
		// it was saved.
		const order = [...states.keys()];
		for (const i of [...order.reverse(), ...order])
			step(`state ${i} restored`, () => {
				graph.fromJSON(structuredClone(states[i]));
				expect(graph.toJSON()).toEqual(states[i]);
			});

		// A footpath turned into a car road in the lane panel (a node of its
		// own at each end holding footpaths, Graph.setLanes): every car node and
		// segment there before is as it was. Then back.
		graph.fromJSON(structuredClone(states[3]));
		const piece = footpaths(graph)[0];
		const role = (r: Lane['role']) =>
			piece.lanes.map((l) => ({
				...l,
				role: r,
				direction: r === 'vehicle' ? ('forward' as const) : ('bidirectional' as const)
			}));
		graph.setLanes([[piece, role('vehicle')]]);
		const now = carGraph(graph);
		expect(now.segments.filter((s) => s.id !== piece.id)).toEqual(before.segments);
		expect(now.nodes.filter((n) => before.nodes.some((b) => b.id === n.id))).toEqual(before.nodes);
		expect(mixed(graph)).toEqual([]);
		step('a footpath turned into a car road and back', () => {
			graph.setLanes([[piece, role('pedestrian')]]);
		});
		expect(failures).toEqual([]);
	});

test('a street turned into a footpath and back leaves the other car roads as they were', () => {
	// A T (curved-tee), a footpath ended on the stem's sidewalk; the stem
	// turned into a footpath in the lane panel, then back.
	const graph = new Graph();
	graph.fromJSON(readScene('curved-tee'));
	const stem = graph.segments.get('side')!;
	const at = roadAt(graph, stem, 0.5)!;
	const p = sideOf(graph, stem, at.point.x + at.normal.x, at.point.y + at.normal.y)!;
	const end = graph.createNode(p.x, p.y);
	const out = graph.createNode(p.x + at.normal.x * 20, p.y + at.normal.y * 20);
	graph.createSegment(out.id, end.id, preset('path'));
	const before = carGraph(graph);
	const lanes = stem.lanes;
	graph.setLanes([[stem, stem.cloneLanes().map((l) => ({ ...l, role: 'pedestrian' as const }))]]);
	expect(mixed(graph)).toEqual([]);
	expect(carGraph(graph).segments).toEqual(before.segments.filter((s) => s.id !== 'side'));
	expect(graph.nodes.get(end.id)!.connectedSegments).toHaveLength(1);
	graph.setLanes([[stem, lanes]]);
	expect(mixed(graph)).toEqual([]);
	expect(graph.nodes.get(end.id)!.connectedSegments).toHaveLength(1);
});

// Where the street a footpath crosses shows off its line (shifted, curved
// and shifted, or a ramp of the roundabout), the footpath is cut nowhere and
// drawn where it was; each way the traffic runs on each roadway it crosses
// gives way just behind the zebra, on the side that traffic comes from, and
// with the footpath taken away again the car roads are as they were.
const across: [string, GraphData, Pt, Pt, number][] = [
	['a street shifted 16 m off its line', street(16), { x: -35, y: 6 }, { x: 35, y: 30 }, 1],
	[
		'a street leaning from 2 to 6 m off its line',
		street(2, 6),
		{ x: -20, y: -10 },
		{ x: 20, y: 30 },
		1
	],
	[
		'a curved street shifted 8 m',
		street(8, 8, { x: 0, y: 40 }),
		{ x: -10, y: -10 },
		{ x: 10, y: 40 },
		1
	],
	// Across both ramps of the north split, 22 m from it.
	['the roundabout', readScene('roundabout'), { x: -20, y: -28 }, { x: 20, y: -28 }, 2]
];

const walksOf = (data: GraphData) =>
	buildModel(data)
		.scene.place.roads.filter((r) => r.lanes.every((l) => l.kind !== 'drive'))
		.map((r) => r.points.map((p) => [Math.round(p.x * 1e4), Math.round(p.y * 1e4)]));

function removeFootpaths(graph: Graph) {
	remove(
		graph,
		[],
		footpaths(graph).map((s) => s.id)
	);
}

for (const [name, base, a, b, crossed] of across)
	test(`a footpath across ${name} is cut nowhere, each roadway giving way behind its zebra`, () => {
		const graph = new Graph();
		graph.fromJSON(structuredClone(base));
		const before = carPart(buildModel(base).scene);
		const was = new Set(graph.nodes.keys());
		const [na, nb] = [graph.createNode(a.x, a.y), graph.createNode(b.x, b.y)];
		graph.createSegment(na.id, nb.id, preset('path'));
		const uncut = walksOf(graph.toJSON());
		resolveCrossings(graph, [...graph.segments.keys()].slice(-1));

		const cuts = [...graph.nodes.values()].filter((n) => !was.has(n.id) && n !== na && n !== nb);
		expect(cuts).toHaveLength(0);
		expect(carDiff(before, carPart(buildModel(graph.toJSON()).scene))).toEqual([]);
		expect(walksOf(graph.toJSON())).toEqual(uncut);

		const { scene } = buildModel(graph.toJSON());
		const zebras = zebrasOf(scene);
		expect(zebras).toHaveLength(crossed);
		// The ways the traffic runs on each road crossed: on each road whose
		// roadway one of the zebras lies over.
		const bodies = zebras.flatMap((z) => z.body.flat());
		const ways = [...graph.segments.values()]
			.filter((s) => carries(s.lanes))
			.filter((s) =>
				bodies.some((p) => closestOnRoad(graph, s, p.x, p.y).distance < s.totalWidth / 2)
			)
			.map(
				(s) => new Set(s.lanes.filter((l) => l.role === 'vehicle').map((l) => l.direction)).size
			);
		// A give-way line for each way a lane runs, just behind a zebra: its
		// middle within STOP_ROOM of a zebra's outline.
		const outlines = zebras.flatMap((z) => z.body);
		const near = (p: Pt) =>
			outlines.some((ring) =>
				ring.some((q, i) => {
					const r = ring[(i + 1) % ring.length];
					const [dx, dy] = [r.x - q.x, r.y - q.y];
					const k = Math.max(
						0,
						Math.min(1, ((p.x - q.x) * dx + (p.y - q.y) * dy) / (dx * dx + dy * dy || 1))
					);
					return Math.hypot(p.x - q.x - k * dx, p.y - q.y - k * dy) < STOP_ROOM + 1;
				})
			);
		const yields = piecesOf(scene)
			.flatMap((d) => d.signs.flatMap((s) => (s.kind === 'yield' ? [s] : [])))
			.filter((s) => near({ x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 }));
		expect(ways.length).toBe(crossed);
		expect(yields).toHaveLength(ways.reduce((s, n) => s + n, 0));
		// Each stands on the side its traffic comes from: driving on along its
		// lanes (toward the end of the road they head for), the zebra's
		// nearest stripe lies ahead of the line, and the teeth point back at
		// the traffic.
		const stripes = zebras.flatMap((z) =>
			z.runs.flatMap((run) => (run.kind === 'zebra' ? run.rings.flat() : []))
		);
		const sides = yields.map((s) => {
			const m = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
			const { road, end } = s.lanes[0];
			const path = scene.geos.get(road)!.path;
			const t = frameAt(path, project(path, m).s).t;
			const drive = end === 'end' ? t : { x: -t.x, y: -t.y };
			const q = stripes.reduce((best, p) =>
				Math.hypot(p.x - m.x, p.y - m.y) < Math.hypot(best.x - m.x, best.y - m.y) ? p : best
			);
			return {
				zebraAhead: (q.x - m.x) * drive.x + (q.y - m.y) * drive.y > 0,
				teethBack: s.toward.x * drive.x + s.toward.y * drive.y < 0
			};
		});
		expect(sides).toEqual(yields.map(() => ({ zebraAhead: true, teethBack: true })));

		removeFootpaths(graph);
		expect(carDiff(before, carPart(buildModel(graph.toJSON()).scene))).toEqual([]);
	});

// The zebras drawn are the crossings' bands (core/runs.ts), and nothing in
// the graph marks them: each zebra drawn lies over some crossing's band, and
// each crossing's band lies under some zebra drawn.
function zebrasAreBands(graph: Graph) {
	const { scene } = buildModel(graph.toJSON());
	const zebras = zebraGround(scene);
	const cars = [...graph.segments.values()].filter((s) => carries(s.lanes));
	const bands = [...graph.segments.values()]
		.filter((s) => !carries(s.lanes))
		.flatMap((s) => crossingsHeldBy(graph, s, cars, new Set()))
		.map((c) => union(c.runs.map((run) => toPath(bandOf(c.road, run)))));
	const meets = (p: ReturnType<typeof zebraGround>[number], q: ReturnType<typeof union>) =>
		intersect(p, q).length > 0;
	return {
		bare:
			zebras.filter((z) => !bands.some((b) => meets(z, b))).length +
			bands.filter((b) => !zebras.some((z) => meets(z, b))).length,
		zebras: zebras.length
	};
}

// Footpaths' nodes dragged with whatever else is selected, from a street
// footpaths were drawn across: the car roads are drawn as the same drag of
// the selection's car nodes alone draws them, no node holds both kinds, the
// graph holds the nodes and segments it did, and the zebras are the
// crossings' bands.
const spur = (base: GraphData): GraphData => ({
	nodes: [...base.nodes, { id: 's', x: 20, y: 25 }, { id: 'n', x: 20, y: 3.5 }],
	segments: [
		...base.segments,
		{ id: 'spur', startNodeId: 's', endNodeId: 'n', lanes: preset('lane') }
	]
});

// Draws footpaths square across the street at each t along it, as draw mode
// does; returns each footpath's near and far node.
function crossAt(graph: Graph, ts: number[]) {
	const street = graph.segments.get('street')!;
	const ats = ts.map((t) => roadAt(graph, street, t)!);
	const reach = street.totalWidth / 2 + 8;
	const [near, far]: string[][] = [[], []];
	for (const at of ats) {
		const end = (k: number) =>
			graph.createNode(at.point.x + at.normal.x * k, at.point.y + at.normal.y * k).id;
		far.push(end(reach));
		near.push(end(-reach));
		resolveCrossings(graph, [graph.createSegment(far.at(-1)!, near.at(-1)!, preset('path')).id]);
	}
	return { near: near.map((id) => graph.nodes.get(id)!), far };
}

const drags: {
	name: string;
	base: GraphData;
	ts: number[];
	// The nodes selected: footpaths' near ends by index along the street,
	// others by id.
	selected: (number | string)[];
	by: Pt;
}[] = [
	{
		name: 'two footpaths on a curved street dragged together by an end',
		base: street(0, 0, { x: 0, y: 60 }),
		ts: [0.4, 0.6],
		selected: [0, 1],
		by: { x: 24, y: 10 }
	},
	{
		name: "a footpath's end dragged along a street that passes near a car road",
		base: spur(street()),
		ts: [0.5],
		selected: [0],
		by: { x: 8, y: 1 }
	},
	{
		name: "a footpath's end dragged with a footpath node and a car road node",
		base: spur(street()),
		ts: [0.5],
		selected: [0, 'far 0', 's'],
		by: { x: 6, y: 3 }
	},
	{
		name: "a footpath's end dragged with a node of its street",
		base: street(0, 0, { x: 0, y: 50 }),
		ts: [0.5],
		selected: [0, 'w'],
		by: { x: 5, y: 8 }
	},
	{
		name: "a footpath's end dragged past the next footpath on its street",
		base: street(),
		ts: [0.4, 0.6],
		selected: [0],
		by: { x: 40, y: 0 }
	}
];

for (const { name, base, ts, selected, by } of drags)
	test(`${name}: the car roads are drawn as the drag of its car nodes alone draws them`, () => {
		const reference = new Graph();
		reference.fromJSON(structuredClone(base));
		const own = selected.filter(
			(n): n is string => typeof n === 'string' && reference.nodes.has(n)
		);
		if (own.length) drag(reference, own, by);
		const expected = carPart(buildModel(reference.toJSON()).scene);

		const graph = new Graph();
		graph.fromJSON(structuredClone(base));
		const live = new Networks();
		live.build(graph);
		const { near, far } = crossAt(graph, ts);
		const was = near.map((n) => ({ x: n.x, y: n.y }));
		const ids = selected.map((n) =>
			typeof n === 'number' ? near[n].id : n.startsWith('far ') ? far[+n.slice(4)] : n
		);
		const kept = { nodes: [...graph.nodes.keys()], segments: [...graph.segments.keys()] };
		drag(graph, ids, by);
		expect(carDiff(expected, carPart(live.build(graph).scene))).toEqual([]);
		expect(carDiff(expected, carPart(buildModel(graph.toJSON()).scene))).toEqual([]);
		expect(mixed(graph)).toEqual([]);
		expect({ nodes: [...graph.nodes.keys()], segments: [...graph.segments.keys()] }).toEqual(kept);
		// Every end selected went with the pointer.
		for (const i of selected.filter((n) => typeof n === 'number'))
			expect(Math.hypot(near[i].x - was[i].x - by.x, near[i].y - was[i].y - by.y)).toBeLessThan(
				1e-6
			);
		expect(zebrasAreBands(graph).bare).toBe(0);
	});

// Moving a street carries what lies on its ground however it is moved, and
// nothing off it: a footpath's end on its sidewalk keeps its place along and
// across it, a footpath across it stays where it is and still crosses, and a
// footpath end lying beyond its dead end stays where it is.
test('a street moved by its node or its curve carries the footpath nodes on its ground, and only those', () => {
	const graph = new Graph();
	graph.fromJSON(street());
	const s = graph.segments.get('street')!;
	const side = sideOf(graph, s, -20, 3)!;
	const [end, out] = [graph.createNode(side.x, side.y), graph.createNode(-20, 25)];
	graph.createSegment(out.id, end.id, preset('path'));
	const [n, south] = [graph.createNode(10, -25), graph.createNode(10, 25)];
	resolveCrossings(graph, [graph.createSegment(n.id, south.id, preset('path')).id]);
	const beyond = graph.createNode(63, 0);
	graph.createSegment(beyond.id, graph.createNode(80, 0).id, preset('path'));
	const paint = () => {
		const { scene } = buildModel(graph.toJSON());
		return {
			zebras: zebraGround(scene).length,
			yields: piecesOf(scene).flatMap((d) => d.signs.filter((x) => x.kind === 'yield')).length
		};
	};
	const before = paint();
	expect(before).toEqual({ zebras: 1, yields: 2 });
	// Where each lies across the street, and how far along it.
	const place = (id: string) => {
		const node = graph.nodes.get(id)!;
		const near = closestOnRoad(graph, s, node.x, node.y);
		const at = roadAt(graph, s, near.t)!;
		const across = (node.x - at.line.x) * at.normal.x + (node.y - at.line.y) * at.normal.y;
		return [Math.round(near.t * 1e6) / 1e6 + 0, Math.round(across * 1e6) / 1e6 + 0];
	};
	const placed = place(end.id);
	const stay = [beyond, n, south].map(({ x, y }) => ({ x, y }));

	// Its east end dragged north.
	const d = dragNodes(graph, ['e'], groundOf(graph));
	d.move(-5, 6);
	expect(place(end.id)).toEqual(placed);
	expect([beyond, n, south].map(({ x, y }) => ({ x, y }))).toEqual(stay);
	expect(paint()).toEqual(before);

	// Its curve's handle dragged 25 m south.
	const riders = ridersOf(graph, groundOf(graph), [s.id]);
	expect(riders.nodes).toEqual([end.id]);
	s.setControlPoint(0, 25);
	riders.follow();
	expect(place(end.id)).toEqual(placed);
	expect(paint()).toEqual(before);
	expect(mixed(graph)).toEqual([]);
});

// A ramp's curve dragged at a roundabout split carries a footpath's node
// lying on the split's junction ground, as dragging its node or the ramp
// whole would (ridersOf reads the ground of the roads moved and of the
// junctions at their nodes).
test("a ramp's curve dragged at a roundabout split carries a footpath node on the split's ground", () => {
	const graph = new Graph();
	graph.fromJSON(readScene('roundabout'));
	const ramp = graph.segments.get('entry-ramp-n-a')!;
	// A footpath across both ramps 6 m past the split, bent at a node on the
	// entry ramp's line.
	const on = closestOnRoad(graph, ramp, -3, -44);
	const [w, m, e] = [
		graph.createNode(-20, -44),
		graph.createNode(on.x, on.y),
		graph.createNode(20, -44)
	];
	graph.createSegment(w.id, m.id, preset('path'));
	graph.createSegment(m.id, e.id, preset('path'));
	const riders = ridersOf(graph, groundOf(graph), [ramp.id]);
	expect(riders.nodes).toEqual([m.id]);
	const node = m;
	const place = () => {
		const near = closestOnRoad(graph, ramp, node.x, node.y);
		const at = roadAt(graph, ramp, near.t)!;
		const across = (node.x - at.line.x) * at.normal.x + (node.y - at.line.y) * at.normal.y;
		return [near.t, across];
	};
	const before = place();
	const from = { x: node.x, y: node.y };
	ramp.setControlPoint(ramp.controlX! - 7, ramp.controlY!);
	riders.follow();
	expect(Math.hypot(node.x - from.x, node.y - from.y)).toBeGreaterThan(1);
	const after = place();
	// Read back off the ramp's sampled line: to the millimetre.
	expect(after[0]).toBeCloseTo(before[0], 3);
	expect(after[1]).toBeCloseTo(before[1], 3);
	expect(mixed(graph)).toEqual([]);
});

// A footpath that dips into a roadway and back out on the side it came from
// crosses nothing: no node is cut in it and nothing of it is drawn over the
// lanes, whether it reaches the middle or not. Across the street right by its
// dead end it is a crossing like any other, cut nowhere.
test('a footpath dipping into a roadway from one side is no crossing; one across by the dead end is', () => {
	for (const dip of [3, 6]) {
		const graph = new Graph();
		graph.fromJSON(street());
		const s = graph.segments.get('street')!;
		const [p, q] = [sideOf(graph, s, -18, 3)!, sideOf(graph, s, 18, 3)!];
		const [a, b] = [graph.createNode(p.x, p.y), graph.createNode(q.x, q.y)];
		const path = graph.createSegment(a.id, b.id, preset('path'));
		// Its middle `dip` metres in from the sidewalk's middle (4.5 m out),
		// toward the street's: 3 m keeps it short of the middle, 6 m takes it
		// past and back.
		path.setControlPoint(0, p.y - 2 * dip);
		resolveCrossings(graph, [path.id]);
		expect([dip, footpaths(graph).length]).toEqual([dip, 1]);
		expect([dip, zebrasOf(buildModel(graph.toJSON()).scene).length]).toEqual([dip, 0]);
	}
	const graph = new Graph();
	graph.fromJSON(street());
	const [n, s] = [graph.createNode(59.5, -24), graph.createNode(59.5, 24)];
	resolveCrossings(graph, [graph.createSegment(n.id, s.id, preset('path')).id]);
	expect(footpaths(graph)).toHaveLength(1);
	expect(zebrasAreBands(graph)).toEqual({ bare: 0, zebras: 1 });
});

// Where a street is, for a footpath crossing it, is where it is drawn: a
// footpath across a roadway lying off the street's line, never reaching
// that line, draws its zebra over the roadway, cut nowhere.
test("a footpath across a roadway off its street's line, short of the line, draws its zebra there", () => {
	const graph = new Graph();
	graph.fromJSON(lopsided);
	const [a, b] = [graph.createNode(0, 1), graph.createNode(0, 15)];
	resolveCrossings(graph, [graph.createSegment(a.id, b.id, preset('path')).id]);
	expect([...graph.nodes.values()].filter((n) => n.connectedSegments.length === 2)).toEqual([]);
	expect(zebrasAreBands(graph)).toEqual({ bare: 0, zebras: 1 });
});

// A footpath short enough that the junction at its end reaches over the
// street it crosses (e2e/scenes/short-footpath.json, its side street's end
// t walked toward the main street) still crosses it, on a zebra the
// junction draws round the crossing's node.
test('a crossing drawn by the junction of a short footpath, past its own road, is still drawn', () => {
	for (const x of [-20, -10, -8, -7.96, -7]) {
		const data = readScene('short-footpath');
		data.nodes.find((n) => n.id === 't')!.x = x;
		expect([x, zebrasOf(buildModel(data).scene).length]).toEqual([x, 1]);
	}
});

// A crossing enters a roadway on one side and leaves on the other, whatever
// nodes the footpath has inside it (core/runs.ts). Bent back to the side it
// came from at a node of its own in the roadway, it draws no zebra and no
// give-way; taken on across through nodes off the roadway's middle, it is
// one crossing, given way to each way.
test('a footpath bent back at a node in the roadway is no crossing; one on across through such nodes is', () => {
	const paint = (graph: Graph) => {
		const { scene } = buildModel(graph.toJSON());
		return {
			zebras: zebrasOf(scene).length,
			yields: piecesOf(scene).flatMap((d) => d.signs.filter((x) => x.kind === 'yield')).length
		};
	};
	const graph = new Graph();
	graph.fromJSON(street());
	const [a, bend, b] = [
		graph.createNode(-20, 20),
		graph.createNode(0, 1),
		graph.createNode(20, 20)
	];
	const pieces = [
		graph.createSegment(a.id, bend.id, preset('path')).id,
		graph.createSegment(bend.id, b.id, preset('path')).id
	];
	resolveCrossings(graph, pieces);
	expect(footpaths(graph)).toHaveLength(2);
	expect(paint(graph)).toEqual({ zebras: 0, yields: 0 });

	// On across: in at 1.5 m right of the middle, out at 1.5 m left.
	const across = new Graph();
	across.fromJSON(street());
	const ends = [
		{ x: 0, y: 20 },
		{ x: 0, y: 1.5 },
		{ x: 0, y: -1.5 },
		{ x: 0, y: -20 }
	].map((p) => across.createNode(p.x, p.y));
	for (let i = 1; i < ends.length; i++)
		across.createSegment(ends[i - 1].id, ends[i].id, preset('path'));
	expect(paint(across)).toEqual({ zebras: 1, yields: 2 });
});

// Drawn with the Path brush, straight, bent back sharply just past the far
// car lane: its bend turns inside the roadway, so it crosses nothing; its
// bend dragged out well past the far curb, it crosses twice, once each way.
test('a footpath drawn bent back inside the roadway crosses nothing, and twice once its bend is dragged past the far curb', () => {
	const ui = openEditor({
		nodes: [
			{ id: 'a', x: -35, y: 0 },
			{ id: 'b', x: 35, y: 0 }
		],
		segments: [{ id: 'r', startNodeId: 'a', endNodeId: 'b', lanes: preset('street').slice(1, 3) }]
	});
	ui.editor.activateSlot(3);
	ui.editor.setDrawStyle('straight');
	for (const q of [
		{ x: -10, y: -20 },
		{ x: 0, y: 4.5 },
		{ x: 10, y: -20 }
	])
		ui.click(q.x, q.y);
	ui.key('Escape');
	ui.key('Escape');
	expect(ui.editor.graph.segments.size).toBe(3);
	const road = () => ui.editor.roadRenderer.scene!.road('r')!;
	expect(road().crossings).toEqual([]);
	expect(road().signs.filter((x) => x.kind === 'yield' || x.kind === 'stop')).toEqual([]);
	const j = [...ui.editor.graph.nodes.values()].find((n) => Math.hypot(n.x, n.y - 4.5) < 0.2)!;
	expect(j.connectedSegments).toHaveLength(2);
	ui.drag({ x: j.x, y: j.y }, { x: 0, y: 16 });
	expect(ui.node(j.id).y).toBeCloseTo(16, 1);
	expect(road().crossings).toHaveLength(2);
});

// A crossing is paint: a footpath's node in the middle of one joins as any,
// and the crossing is drawn as before.
test("a footpath's node in the middle of a crossing joins as any", () => {
	const graph = new Graph();
	graph.fromJSON(street());
	const [n, mid, s] = [graph.createNode(0, -24), graph.createNode(0, 0), graph.createNode(0, 24)];
	graph.createSegment(n.id, mid.id, preset('path'));
	resolveCrossings(graph, [graph.createSegment(mid.id, s.id, preset('path')).id]);
	expect(zebrasAreBands(graph)).toEqual({ bare: 0, zebras: 1 });
	expect(joinPlan(graph, mid.id)).not.toBeNull();
});

// A street cut where it carries on (drawn as one road) has no end at the
// cut: a footpath's end put on its sidewalk there lands beside the cut, on
// either half, as on the street uncut; at the street's own ends it stays
// inside what is drawn.
test("a footpath's end on a cut street's sidewalk lands beside the cut, not short of it", () => {
	const graph = new Graph();
	graph.fromJSON(street());
	const cut = graph.createNode(-18, 0);
	splitSegment(graph, graph.segments.get('street')!, 42 / 120, cut.id);
	const { derived } = new Networks().build(graph);
	const [west, east] = cut.connectedSegments.map((id) => graph.segments.get(id)!);
	const on = (s: typeof west, x: number) => sideOf(graph, s, x, 3, derived.spans.get(s.id))!;
	expect([on(west, -18), on(east, -18)]).toEqual([
		{ x: expect.closeTo(-18, 6), y: expect.closeTo(4.5, 6) },
		{ x: expect.closeTo(-18, 6), y: expect.closeTo(4.5, 6) }
	]);
	expect(on(west, -60).x).toBeGreaterThan(-60);
});

test("a footpath's end on a sidewalk rides with the street when only its shift moves", () => {
	// A street from (-70, 0) to (70, 0), a T at each end, and a footpath from
	// its sidewalk at (0, 4.5) to (0, 25). The street's shift set 3 m at both
	// ends, then at its start alone: the end keeps its place beside the
	// street's line as it shows, on the sidewalk it lay on.
	for (const [start, end] of [
		[3, 3],
		[3, 0]
	]) {
		const graph = new Graph();
		const node = (id: string, x: number, y: number) => ({ id, x, y });
		const road = (id: string, a: string, b: string, lanes = preset('street')) => ({
			id,
			startNodeId: a,
			endNodeId: b,
			lanes
		});
		graph.fromJSON({
			nodes: [
				node('a', -70, 0),
				node('b', 70, 0),
				node('an', -70, -30),
				node('as', -70, 30),
				node('bn', 70, -30),
				node('bs', 70, 30),
				node('c', 0, 4.5),
				node('d', 0, 25)
			],
			segments: [
				road('s', 'a', 'b'),
				road('an', 'a', 'an'),
				road('as', 'a', 'as'),
				road('bn', 'b', 'bn'),
				road('bs', 'b', 'bs'),
				road('w', 'c', 'd', preset('path'))
			]
		});
		const networks = new Networks();
		const was = networks.build(graph).derived.sidewalks.get('c');
		expect(was).toBeDefined();
		const street = graph.segments.get('s')!;
		const riders = ridersOf(graph, networks.onGround.bind(networks), ['s']);
		expect(riders.nodes).toEqual(['c']);
		street.offsetStart = start;
		street.offsetEnd = end;
		riders.follow();
		const c = graph.nodes.get('c')!;
		// Halfway along the street, where it lay.
		const shown = roadAt(graph, street, 0.5)!.point;
		expect([c.x, c.y]).toEqual([expect.closeTo(shown.x, 3), expect.closeTo(shown.y + 4.5, 3)]);
		expect(networks.build(graph).derived.sidewalks.get('c')?.[0].lane).toBe(was![0].lane);
	}
});

test('two footpaths ending at one node on opposite sidewalks each record their own, in whatever order they are listed', () => {
	// The node in the street's middle; west shifted onto its south sidewalk,
	// east onto its north one.
	const lanes = (preset: string) => createLanesFrom(preset).map((l, i) => ({ ...l, id: `l${i}` }));
	const road = (id: string, a: string, b: string, preset: string, shift = 0) => ({
		id,
		startNodeId: a,
		endNodeId: b,
		lanes: lanes(preset),
		offsetStart: shift,
		offsetEnd: shift
	});
	const records = (order: string[]) => {
		const paths = {
			west: road('west', 'w', 'j', 'path', 4.5),
			east: road('east', 'j', 'e', 'path', -4.5)
		};
		return buildModel({
			nodes: [
				{ id: 'a', x: -60, y: 0 },
				{ id: 'b', x: 60, y: 0 },
				{ id: 'w', x: -30, y: 0 },
				{ id: 'j', x: 0, y: 0 },
				{ id: 'e', x: 30, y: 0 }
			],
			segments: [road('street', 'a', 'b', 'street'), ...order.map((id) => paths[id as 'west'])]
		}).derived.sidewalks.get('j');
	};
	const one = records(['west', 'east']);
	expect(one?.map((r) => [r.path, r.road, r.lane])).toEqual([
		['east', 'street', 'l0'],
		['west', 'street', 'l3']
	]);
	expect(records(['east', 'west'])).toEqual(one);
});

test('a shifted footpath pasted to show within a wider footpath is taken out, leaving the graph as it was', () => {
	// `source`, 2 m wide, shows 4 m right of its nodes. Pasted with them 4 m
	// off the line of `target`, 6 m wide, it shows along `target`'s middle,
	// within its strip, so laying it leaves nothing.
	const width = (w: number) => preset('path').map((l) => ({ ...l, width: w }));
	const graph = new Graph();
	graph.fromJSON({
		nodes: [
			{ id: 'a', x: -40, y: 0 },
			{ id: 'b', x: 40, y: 0 },
			{ id: 'c', x: -24, y: 25 },
			{ id: 'd', x: 24, y: 25 }
		],
		segments: [
			{ id: 'target', startNodeId: 'a', endNodeId: 'b', lanes: width(6) },
			{
				id: 'source',
				startNodeId: 'c',
				endNodeId: 'd',
				lanes: width(2),
				offsetStart: 4,
				offsetEnd: 4
			}
		]
	});
	const clipboard = copySegments({ graph, selectedSegments: ['source'] })!;
	const before = JSON.stringify(graph.toJSON());
	// Centred where place mode puts the copy's nodes' middle (0, 25): on (0, -4).
	const { segmentIds } = layPaste(graph, clipboard, {
		translation: { dx: 0, dy: -29 },
		snap: null
	});
	resolveCrossings(graph, segmentIds.values());
	expect(JSON.stringify(graph.toJSON())).toBe(before);
});
