import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { createLanesFrom } from '../src/lib/core/lane-template';
import type { GraphData, JunctionCrossing, JunctionData, Lane } from '../src/lib/core/types';
import {
	area,
	inside,
	intersect,
	offset,
	toPath,
	toRings,
	union
} from '../src/lib/road-model/clip';
import { check } from '../src/lib/road-model/checks';
import type { NodeDescription, Ring, Surface } from '../src/lib/road-model/description';
import type { Scene } from '../src/lib/core/networks';
import { crossSection, frameAt, offsetPoint } from '../src/lib/road-model/geometry';
import { band, connectionCurve, endsOf, laneEndOf } from '../src/lib/road-model/ends';
import { outlineOf } from '../src/lib/road-model/outline';
import type { Pt } from '../src/lib/road-model/model';
import { shapeOf, walkAt } from '../src/lib/road-model/overlay';
import { buildModel, readScene, segmentOf } from './model';
import { LAYERS, layerOf, signShapes } from '../src/lib/rendering/road-meshes';

// The default rules the drawing runs on, read straight off the road model
// (no browser): a graph is built by hand and read the way the editor reads
// it. Each test protects one rule the editor's look depends on.

type Seg = {
	id: string;
	from: string;
	to: string;
	lanes: Lane[];
	// The shift at both ends, unless one is given on its own.
	offset?: number;
	offsetStart?: number;
	offsetEnd?: number;
	control?: [number, number];
};

function graphOf(nodes: Record<string, [number, number, JunctionData?]>, segs: Seg[]): GraphData {
	return {
		nodes: Object.entries(nodes).map(([id, [x, y, junction]]) => ({ id, x, y, junction })),
		segments: segs.map((s) => {
			s.lanes.forEach((l, i) => (l.id ??= `l${i}`));
			return {
				id: s.id,
				startNodeId: s.from,
				endNodeId: s.to,
				controlX: s.control?.[0],
				controlY: s.control?.[1],
				offsetStart: s.offsetStart ?? s.offset ?? 0,
				offsetEnd: s.offsetEnd ?? s.offset ?? 0,
				lanes: s.lanes
			};
		})
	};
}

// A graph from e2e/scenes/, with every lane given an id.
function sceneGraph(name: string) {
	const graph = readScene(name);
	for (const s of graph.segments) s.lanes.forEach((l, i) => (l.id ??= `l${i}`));
	return graph;
}

// Two roads crossing at node c: a west-east one (w → c → e) and a
// north-south one (n → c → s).
function crossroads(ew: () => Lane[], ns: () => Lane[], junction?: JunctionData) {
	return graphOf({ c: [0, 0, junction], w: [-120, 0], e: [120, 0], n: [0, -120], s: [0, 120] }, [
		{ id: 'west', from: 'w', to: 'c', lanes: ew() },
		{ id: 'east', from: 'c', to: 'e', lanes: ew() },
		{ id: 'north', from: 'n', to: 'c', lanes: ns() },
		{ id: 'south', from: 'c', to: 's', lanes: ns() }
	]);
}
const avenue = () => createLanesFrom('avenue');
const street = () => createLanesFrom('street');

test('a seam a hair open or a crack a centimetre wide between a junction and its roads is found', () => {
	const { scene } = buildModel(crossroads(avenue, avenue));
	expect(check(scene)).toEqual([]);
	const node = scene.node('c')!;
	const k = node.surfaces.findIndex((s) => s.role === 'paving');
	const paving = node.surfaces[k];
	const rings = paving.shape as Ring[];
	// One of the paving's points where a road's lane edge ends, moved a
	// millimetre along the mouth.
	const mouth = node.outline.mouths[0];
	const at = mouth.line[1];
	const moved = rings.map((ring) =>
		ring.map((p) => (p === at ? { x: p.x + 0.001 * mouth.out.y, y: p.y - 0.001 * mouth.out.x } : p))
	);
	node.surfaces[k] = { ...paving, shape: moved };
	expect(check(scene)).toEqual([
		`seam open: c ${mouth.end} (${at.x.toFixed(2)}, ${at.y.toFixed(2)})`
	]);
	// The paving pulled back a centimetre all round: a crack that wide opens
	// across every road's mouth, too thin for the raster comparison to see.
	node.surfaces[k] = { ...paving, shape: toRings(offset(rings.map(toPath), -0.01), []) };
	expect(check(scene).filter((f) => f.startsWith('crack at c'))).toHaveLength(4);
});

test('two Avenues crossing are signalled; an Avenue crossing a Street gives way to nobody', () => {
	const big = buildModel(crossroads(avenue, avenue)).derived.junctions.get('c')!;
	expect(Object.values(big.control)).toEqual(['signal', 'signal', 'signal', 'signal']);

	const mixed = buildModel(crossroads(avenue, street)).derived.junctions.get('c')!;
	expect(mixed.control['west:end']).toBe('none');
	expect(mixed.control['east:start']).toBe('none');
	expect(mixed.control['north:end']).toBe('stop');
	expect(mixed.control['south:start']).toBe('stop');
});

test('a controlled junction has a crossing on every arm; one switched off is gone', () => {
	const on = buildModel(crossroads(avenue, avenue));
	const crossed = (d: typeof on) =>
		d.derived.place.roads.filter((r) => (r.crossings ?? []).length > 0).map((r) => r.id);
	expect(crossed(on).sort()).toEqual(['east', 'north', 'south', 'west']);

	const off = buildModel(
		crossroads(avenue, avenue, {
			crossings: [{ road: 'north', end: 'end', lanes: ['l0', 'l8'], on: false }]
		})
	);
	expect(crossed(off).sort()).toEqual(['east', 'south', 'west']);
});

test('a crossing moved past the far end of its road stops short of it', () => {
	const { derived } = buildModel(
		crossroads(avenue, avenue, {
			crossings: [{ road: 'east', end: 'start', lanes: ['l0', 'l8'], at: 500 }]
		})
	);
	const road = derived.place.roads.find((r) => r.id === 'east')!;
	const span = derived.spans.get('east')!;
	const at = road.crossings![0].at;
	expect(at).toBeLessThan(span.length);
	expect(at).toBeGreaterThan(span.length - 3);
});

// Two Avenues crossing, the west approach with a third eastbound lane on its
// kerb side (right of the existing eastbound pair), as a right-turn lane is.
function rightTurnLane() {
	const graph = crossroads(avenue, avenue);
	const west = segmentOf(graph, 'west');
	const lanes = avenue();
	lanes.splice(7, 0, {
		role: 'vehicle',
		material: 'asphalt',
		width: 3.5,
		direction: 'forward',
		id: 'l9'
	});
	west.lanes = lanes;
	// Slid half a lane toward its kerb, as a pocket is, so its through lanes
	// line up with the road beyond.
	west.offsetStart = 1.75;
	west.offsetEnd = 1.75;
	return graph;
}

test('a lane added on the kerb side turns right only; the lanes beside it go straight', () => {
	const j = buildModel(rightTurnLane()).derived.junctions.get('c')!;
	const from = (lane: string) =>
		j.connections
			.filter((c) => c.from.road === 'west' && c.from.lane === lane)
			.map((c) => c.to.road)
			.sort();
	// Eastbound on a road drawn west to east: the south arm is to the right.
	expect(from('l9')).toEqual(['south']);
	expect(from('l6')).toEqual(['east']);
	expect(from('l5')).toEqual(['east', 'north']);
});

test('through and turn arrows on one approach are one length and start level', () => {
	const { scene } = buildModel(rightTurnLane());
	// The west approach's arrows (straight-and-left, straight, right only).
	const arrows = scene
		.node('c')!
		.signs.filter((s) => s.kind === 'arrow')
		.flatMap(signShapes)
		.filter((p) => p.every((q) => q.x < -15));
	expect(new Set(arrows.map((a) => a.length)).size).toBe(3);
	const start = Math.min(...arrows[0].map((q) => q.x));
	for (const a of arrows) {
		const xs = a.map((q) => q.x);
		expect(Math.min(...xs)).toBeCloseTo(start, 3);
		expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(4, 3);
	}
});

test('swapping two lanes across a node keeps both kerb lines', () => {
	// An Avenue cut in two at node m, its eastbound lanes swapped there.
	const ref = (road: string, end: 'start' | 'end', lane: string) => ({ road, end, lane });
	const graph = graphOf(
		{
			a: [-100, 0],
			b: [100, 0],
			m: [
				0,
				0,
				{
					removed: [
						{ from: ref('one', 'end', 'l5'), to: ref('two', 'start', 'l5') },
						{ from: ref('one', 'end', 'l6'), to: ref('two', 'start', 'l6') }
					],
					added: [
						{ from: ref('one', 'end', 'l5'), to: ref('two', 'start', 'l6') },
						{ from: ref('one', 'end', 'l6'), to: ref('two', 'start', 'l5') }
					],
					setbacks: { one: 15, two: 15 }
				}
			]
		},
		[
			{ id: 'one', from: 'a', to: 'm', lanes: avenue() },
			{ id: 'two', from: 'm', to: 'b', lanes: avenue() }
		]
	);
	const { scene } = buildModel(graph);
	const node = scene.node('m')!;
	// The eastbound kerb sits 8 m south of the line (y = 7.8 inside it); the
	// node's paint keeps a solid white line along it the whole way across.
	const kerb = node.markings.filter(
		(m) => !m.dashed && m.colour === 'white' && m.line.every((p) => Math.abs(p.y - 7.8) < 0.2)
	);
	expect(kerb.length).toBe(1);
	const xs = kerb[0].line.map((p) => p.x);
	expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(25);
});

const oneLane = (direction: 'forward' | 'backward'): Lane[] => [
	{ id: 'l0', role: 'vehicle', material: 'asphalt', width: 3.5, direction }
];

test('an on-ramp attached at the freeway edge feeds only its acceleration lane', () => {
	// A freeway drawn southward; the stretch after the ramp has a fourth
	// southbound lane on the outside, slid half a lane so the median runs on.
	const accel = createLanesFrom('highway');
	accel.push({ ...accel[accel.length - 1], id: 'l7' });
	const graph = graphOf(
		{
			n: [0, -200],
			m: [0, 0, { sides: { ramp: 'left' } }],
			s: [0, 200],
			r: [-60, -150]
		},
		[
			{ id: 'north', from: 'n', to: 'm', lanes: createLanesFrom('highway') },
			{ id: 'south', from: 'm', to: 's', lanes: accel, offset: 1.75 },
			{ id: 'ramp', from: 'r', to: 'm', lanes: oneLane('forward') }
		]
	);
	const j = buildModel(graph).derived.junctions.get('m')!;
	const from = (road: string, lane: string) =>
		j.connections
			.filter((c) => c.from.road === road && c.from.lane === lane)
			.map((c) => `${c.to.road}:${c.to.lane}`);
	expect(from('ramp', 'l0')).toEqual(['south:l7']);
	expect(from('north', 'l6')).toEqual(['south:l6']);
	expect(Object.values(j.control).every((c) => c === 'none')).toBe(true);
});

test('an avenue splitting into two one-way roads carries every lane straight on', () => {
	const avenueLanes = createLanesFrom('avenue');
	const half = (dir: 'forward' | 'backward') =>
		createLanesFrom('avenue')
			.filter((l) => l.role === 'vehicle' && l.direction === dir)
			.map((l, i) => ({ ...l, id: `l${i}` }));
	const graph = graphOf(
		{
			w: [-200, 0],
			m: [0, 0, { sides: { westbound: 'left', eastbound: 'right' } }],
			a: [200, -12],
			b: [200, 12]
		},
		[
			{ id: 'avenue', from: 'w', to: 'm', lanes: avenueLanes },
			{ id: 'westbound', from: 'm', to: 'a', lanes: half('backward') },
			{ id: 'eastbound', from: 'm', to: 'b', lanes: half('forward') }
		]
	);
	const j = buildModel(graph).derived.junctions.get('m')!;
	const cars = j.connections.filter((c) =>
		['avenue', 'westbound', 'eastbound'].includes(c.from.road)
	);
	// Two lanes each way, each with one connection, and none between the
	// two one-way roads.
	const travel = cars.filter((c) => c.from.road !== c.to.road && c.from.lane.startsWith('l'));
	expect(travel.filter((c) => c.to.road === 'eastbound').length).toBe(2);
	expect(travel.filter((c) => c.from.road === 'westbound').length).toBe(2);
	expect(
		travel.some(
			(c) =>
				(c.from.road === 'westbound' && c.to.road === 'eastbound') ||
				(c.from.road === 'eastbound' && c.to.road === 'westbound')
		)
	).toBe(false);
	const outs = new Set(travel.map((c) => `${c.from.road}:${c.from.lane}`));
	expect(outs.size).toBe(travel.length);
});

test('two lane changes close enough to merge keep the sidewalks running through', () => {
	// A street with a turn lane added each side of a short plain piece, as a
	// street does between two pocketed junctions: the tapers use up the short
	// piece, so its two nodes draw as one.
	const pocket = (dir: 'forward' | 'backward') => {
		const lanes = street();
		lanes.forEach((l, i) => (l.id = `l${i}`));
		const at = dir === 'forward' ? 3 : 1;
		lanes.splice(at, 0, {
			role: 'vehicle',
			material: 'asphalt',
			width: 3.5,
			direction: dir,
			id: 'turn'
		});
		return lanes;
	};
	const graph = graphOf({ a: [0, -100], p: [0, -60], q: [0, -45], b: [0, 0] }, [
		{ id: 'north', from: 'a', to: 'p', lanes: pocket('backward'), offset: -1.75 },
		{ id: 'south', from: 'q', to: 'b', lanes: pocket('forward'), offset: 1.75 },
		// Listed last, as a piece split off later is: at both its nodes the
		// sidewalks then run from the outer road into it.
		{ id: 'middle', from: 'p', to: 'q', lanes: street() }
	]);
	const { scene } = buildModel(graph);
	const joined = scene.place.junctions.find((j) => j.members.length > 1);
	expect(joined?.members.sort()).toEqual(['p', 'q']);
	const walks = joined!.connections
		.filter((c) => /^l0$|^l3$/.test(c.from.lane) && c.from.road !== c.to.road)
		.map((c) => [c.from.road, c.to.road].sort().join('-'));
	expect(walks).toEqual(['north-south', 'north-south']);
});

test('two nodes of two roads merged keep their sidewalks running through, whichever way they were stored', () => {
	// tight-link with b moved 2 m toward c, their 3 m piece merged away, and
	// that piece listed first, as one drawn first is: at both nodes the
	// sidewalks then run out of it into the road kept.
	for (const first of [false, true]) {
		const graph = readScene('tight-link');
		graph.nodes.find((n) => n.id === 'b')!.x = 2;
		if (first) graph.segments.sort((a) => (a.id === 'bc' ? -1 : 1));
		const { scene } = buildModel(graph);
		const joined = scene.place.junctions.find((j) => j.members.length > 1)!;
		const sidewalk = (r: { road: string; lane: string }) =>
			scene.geos.get(r.road)?.road.lanes.find((l) => l.id === r.lane)?.kind === 'walk';
		const walks = joined.connections
			.filter((c) => sidewalk(c.from) && sidewalk(c.to))
			.map((c) => [c.from.road, c.to.road].sort().join('-'));
		expect(walks).toEqual(['ab-cd', 'ab-cd']);
	}
});

const drive = (direction: 'forward' | 'backward'): Lane => ({
	role: 'vehicle',
	material: 'asphalt',
	width: 3.5,
	direction
});

// Whether any point of a junction's lines lies on the asphalt just inside a
// road end's mouth (within 1 m of it), where a line would run across the
// road's lanes as they come in.
function paintedAcrossMouth(node: NodeDescription, key: string) {
	const mouth = node.outline.mouths.find((m) => m.end === key)!;
	const into = mouth.line.map((p) => ({ x: p.x - mouth.out.x, y: p.y - mouth.out.y }));
	const strip = [toPath([...mouth.line, ...into.reverse()])];
	return node.markings.some((m) => m.line.some((p) => inside(strip, p)));
}

test('two legs attached at the edges of one road merge into it with no lines crossing', () => {
	// A two-way stem going south from the node; a one-way leg attached at
	// each of its edges, curving apart to the north; a footpath off east.
	const graph = graphOf(
		{
			s: [0, 100],
			m: [0, 0, { sides: { west: 'left', east: 'right' } }],
			w: [-90, -130],
			e: [90, -130],
			f: [80, 0]
		},
		[
			{
				id: 'stem',
				from: 's',
				to: 'm',
				lanes: [drive('backward'), drive('backward'), drive('forward'), drive('forward')]
			},
			{
				id: 'west',
				from: 'm',
				to: 'w',
				lanes: [drive('backward'), drive('backward')],
				control: [-4, -90]
			},
			{
				id: 'east',
				from: 'm',
				to: 'e',
				lanes: [drive('forward'), drive('forward')],
				control: [4, -90]
			},
			{ id: 'path', from: 'm', to: 'f', lanes: createLanesFrom('path') }
		]
	);
	const { scene } = buildModel(graph);
	expect(check(scene)).toEqual([]);
	// Each leg's lane line runs on into the stem.
	expect(scene.node('m')!.markings.filter((m) => m.dashed).length).toBe(2);
});

// A ring of four one-way two-lane roads running anticlockwise on screen,
// drawn as the editor stores it, with a two-way arm leaving each ring node:
// the ring goes on (Go) and each arm yields, as set with the connector's
// badges.
function ring() {
	const R = 30;
	const at = (deg: number, r: number): [number, number] => [
		r * Math.cos((deg * Math.PI) / 180),
		r * Math.sin((deg * Math.PI) / 180)
	];
	const angles = [0, -90, 180, 90];
	const nodes: Record<string, [number, number, JunctionData?]> = {};
	const segs: Seg[] = [];
	angles.forEach((deg, i) => {
		const prev = (i + 3) % 4;
		nodes[`r${i}`] = [
			...at(deg, R),
			{ control: { [`ring${prev}:end`]: 'none', [`arm${i}:start`]: 'yield' } }
		];
		nodes[`o${i}`] = [...at(deg, 90)];
		segs.push({
			id: `ring${i}`,
			from: `r${i}`,
			to: `r${(i + 1) % 4}`,
			lanes: [drive('forward'), drive('forward')],
			control: at(deg - 45, R / Math.cos(Math.PI / 4))
		});
		segs.push({
			id: `arm${i}`,
			from: `r${i}`,
			to: `o${i}`,
			lanes: [drive('backward'), drive('backward'), drive('forward'), drive('forward')]
		});
	});
	return graphOf(nodes, segs);
}

test('a ring drawn in the editor keeps its lane line and inner edge through every entry', () => {
	const { scene } = buildModel(ring());
	for (let i = 0; i < 4; i++) {
		const j = scene.place.junctions.find((x) => x.id === `r${i}`)!;
		expect(j.control[`arm${i}:start`]).toBe('yield');
		const draw = scene.node(j.id)!;
		// The dashes between the ring's two lanes, and its inner edge line
		// (yellow, on the driver's left of a one-way road).
		expect(draw.markings.filter((m) => m.dashed).length).toBe(1);
		expect(draw.markings.filter((m) => !m.dashed && m.colour === 'yellow').length).toBe(1);
		// The outer edge stops at the arm's mouth: the arm's paths and its
		// mouth lie beyond it there.
		expect(paintedAcrossMouth(draw, `arm${i}:start`)).toBe(false);
	}
	expect(check(scene)).toEqual([]);
});

// A surface's ground as clipper paths: its rings, or its ribbon's outline.
const groundOf = (s: Surface) =>
	Array.isArray(s.shape)
		? s.shape.map(toPath)
		: [toPath([...s.shape.left, ...[...s.shape.right].reverse()])];

// A node's surfaces of one role, as clipper paths.
const surfaces = (node: NodeDescription, role: Surface['role']) =>
	node.surfaces.filter((s) => s.role === role).flatMap(groundOf);

// The stripes of a node's zebra crossings.
const zebraOf = (node: NodeDescription) =>
	node.crossings.flatMap((c) =>
		c.runs.filter((r) => r.kind === 'zebra').flatMap((r) => r.rings.map(toPath))
	);

// What a junction draws on top at a point, as the renderer stacks its
// layers: the material showing there, null where it leaves the ground.
function surfaceAt(scene: Scene, id: string, p: Pt) {
	const top = scene
		.node(id)!
		.surfaces.filter((s) => inside(groundOf(s), p))
		.sort((a, b) => LAYERS.indexOf(layerOf(b)) - LAYERS.indexOf(layerOf(a)))[0];
	return top?.material ?? null;
}

// The middle of a road's lane (by index) at a distance along it.
function laneMiddle(scene: Scene, road: string, lane: number, at: 'start' | 'end') {
	const geo = scene.geos.get(road)!;
	const d = at === 'start' ? 0 : geo.path.length;
	const f = frameAt(geo.path, d);
	const span = crossSection(geo.road, d)[lane];
	return { p: offsetPoint(f.p, f.n, (span.left + span.right) / 2), t: f.t };
}

const mixed = (): Lane[] => [
	{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' },
	{ role: 'vehicle', material: 'concrete', width: 3.5, direction: 'forward' }
];

test('a node between two identical roads draws each lane on in its own material', () => {
	// One asphalt lane and one concrete lane, carrying on where the road
	// bends: two roads drawn on their own, their lanes named apart, so m is a
	// node (one road cut there is drawn whole, core/place.ts).
	const named = (prefix: string) => mixed().map((l, i) => ({ ...l, id: `${prefix}${i}` }));
	const { scene } = buildModel(
		graphOf({ a: [-60, -60], m: [0, 0], b: [80, 0] }, [
			{ id: 'one', from: 'a', to: 'm', lanes: named('a') },
			{ id: 'two', from: 'm', to: 'b', lanes: named('b'), control: [40, 40] }
		])
	);
	// All the way across the node, each lane is drawn in its own material.
	for (const [lane, surface] of [
		[0, 'asphalt'],
		[1, 'concrete']
	] as const) {
		const from = laneMiddle(scene, 'one', lane, 'end').p;
		const to = laneMiddle(scene, 'two', lane, 'start').p;
		for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
			const p = { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f };
			expect(surfaceAt(scene, 'm', p), `lane ${lane} at ${f}`).toBe(surface);
		}
	}
});

test('a node paves only where lanes carry on: a sidewalk ending there leaves ground', () => {
	// A street (sidewalk, two lanes, sidewalk) bending into two bare lanes.
	const bare = (): Lane[] => [drive('backward'), drive('forward')];
	const { scene } = buildModel(
		graphOf({ a: [-60, -60], m: [0, 0], b: [80, 0] }, [
			{ id: 'wide', from: 'a', to: 'm', lanes: street() },
			{ id: 'narrow', from: 'm', to: 'b', lanes: bare() }
		])
	);
	const into = (lane: number) => {
		const { p, t } = laneMiddle(scene, 'wide', lane, 'end');
		return offsetPoint(p, t, 0.5);
	};
	// Just past the wide road's end, beyond its sidewalks: ground.
	expect(surfaceAt(scene, 'm', into(0))).toBeNull();
	expect(surfaceAt(scene, 'm', into(3))).toBeNull();
	// Its two lanes carry on, paved.
	expect(surfaceAt(scene, 'm', into(1))).toBe('asphalt');
	expect(surfaceAt(scene, 'm', into(2))).toBe('asphalt');
	expect(check(scene)).toEqual([]);
});

// A divided freeway, four lanes each way, curving on to three each way at
// node m, where its outermost northbound lane leaves as a one-lane off-ramp
// attached at its right edge and curving away (e2e/scenes/off-ramp.json).
// The transition at m was dragged long before the ramp was drawn off it.
function offRamp() {
	const { scene } = buildModel(sceneGraph('off-ramp'));
	const j = scene.place.junctions.find((x) => x.id === 'm')!;
	const ends = endsOf(j, scene.geos);
	const path = (from: string, to: string) => {
		const [fr, fl] = from.split(':');
		const [tr, tl] = to.split(':');
		const c = j.connections.find(
			(c) => c.from.road === fr && c.from.lane === fl && c.to.road === tr && c.to.lane === tl
		)!;
		const a = laneEndOf(ends, c.from)!;
		const b = laneEndOf(ends, c.to)!;
		return band(connectionCurve(a.lane, a.end, b.lane, b.end));
	};
	// The freeway's outermost lane carrying on, and the lane leaving.
	return { scene, through: path('south:l7', 'north:l7'), ramp: path('south:l8', 'ramp:l0') };
}

const distance = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y);

test('an off-ramp leaving a freeway keeps its lines on the road', () => {
	expect(check(offRamp().scene)).toEqual([]);
});

test('between a freeway and the off-ramp leaving it the gore is ground: only the lanes are paved, and the seam between them while they are side by side', () => {
	const { scene, through, ramp } = offRamp();
	// Halfway between the edges of the lane carrying on and the ramp's lane,
	// with how far apart they are there.
	const between = through.right.map((p) => {
		const q = ramp.left.reduce((a, b) => (distance(p, b) < distance(p, a) ? b : a));
		return { at: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, gap: distance(p, q) };
	});
	// Once the two are a metre apart nothing is drawn between them, all the
	// way to where the roads start.
	const gore = between.filter((b) => b.gap > 1);
	expect(gore.length).toBeGreaterThan(5);
	for (const { at } of gore) expect(surfaceAt(scene, 'm', at), `at ${at.x}, ${at.y}`).toBeNull();
	// While they are under half a metre apart the ground between them is road.
	const seam = between.filter((b) => b.gap > 0.1 && b.gap < 0.5);
	expect(seam.length).toBeGreaterThan(0);
	for (const { at } of seam)
		expect(surfaceAt(scene, 'm', at), `at ${at.x}, ${at.y}`).toBe('asphalt');
	expect(check(scene)).toEqual([]);
});

test("a freeway's edge line runs along its lane to where an off-ramp parts", () => {
	const { scene, through } = offRamp();
	// All along the right edge of the lane carrying on, a line beside it: the
	// lane line while the ramp's lane is beside it, then its edge line.
	const lines = scene.node('m')!.markings.filter((m) => m.colour === 'white');
	const near = (p: Pt) =>
		Math.min(
			...lines.flatMap((m) =>
				m.line.slice(1).map((b, i) => {
					const a = m.line[i];
					const d = { x: b.x - a.x, y: b.y - a.y };
					const t = ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / (d.x * d.x + d.y * d.y || 1);
					const k = Math.max(0, Math.min(1, t));
					return distance(p, { x: a.x + d.x * k, y: a.y + d.y * k });
				})
			)
		);
	for (const p of through.right.slice(1, -1))
		expect(near(p), `at ${p.x}, ${p.y}`).toBeLessThan(0.3);
});

// An avenue (sidewalk, two lanes, grass median, two lanes, sidewalk) running
// west-east across a road of just two car lanes, 7 m of roadway, whose lanes
// only go straight through (e2e/scenes/busway-crossing.json): a busway.
test('a narrow road whose lanes cross an avenue stops its median and sidewalks', () => {
	const { scene } = buildModel(sceneGraph('busway-crossing'));
	// The zebra crossings, whole: x = ±1.75 falls on the edge of a stripe.
	const zebra = scene
		.node('c')!
		.crossings.filter((c) => c.runs.some((r) => r.kind === 'zebra' && r.rings.length))
		.flatMap((c) => c.body.map(toPath));
	// Across the busway's two lanes (x = ±1.75): asphalt where the avenue's
	// median and sidewalks would run on, and a crosswalk over the busway just
	// past the corners where they turn.
	for (const x of [-1.75, 1.75]) {
		expect(surfaceAt(scene, 'c', { x, y: 0 }), `median at ${x}`).toBe('asphalt');
		for (const y of [-9.5, 9.5])
			expect(surfaceAt(scene, 'c', { x, y }), `sidewalk at ${x}, ${y}`).toBe('asphalt');
		for (const y of [-15.5, 15.5])
			expect(inside(zebra, { x, y }), `crosswalk at ${x}, ${y}`).toBe(true);
	}
	expect(check(scene)).toEqual([]);
});

// A curved six-lane avenue with sidewalks, and joining it at a slant from
// the inside of the curve a side road of two car lanes either side of a
// concrete median, 9 m from curb to curb, with no sidewalks of its own
// (e2e/scenes/curved-tee.json). The side road stops at the avenue. `lanes`
// swaps in another cross-section for the side road.
function curvedTee(lanes?: Lane[]) {
	const graph = sceneGraph('curved-tee');
	if (lanes) {
		segmentOf(graph, 'side').lanes = lanes;
	}
	const { scene } = buildModel(graph);
	const j = scene.place.junctions.find((x) => x.id === 'c')!;
	const ends = endsOf(j, scene.geos);
	const side = ends.find((e) => e.ref.road === 'side')!;
	const draw = scene.node('c')!;
	// A point in the side road's frame at its end: metres along it away from
	// the avenue, and across it to the right.
	const at = (along: number, across: number) =>
		offsetPoint(offsetPoint(side.frame.p, side.frame.out, along), side.frame.n, across);
	return { scene, j, ends, side, draw, at };
}

test('a divided side road without sidewalks is crossed by a crosswalk', () => {
	const { j, draw, at } = curvedTee();
	expect(j.control['side:start']).toBe('stop');
	expect(j.walkways.some((w) => w.id === 'north:start~south:end')).toBe(true);
	// Zebra stripes over both its lanes (3.5 m either side of a 2 m median),
	// within the first 3 m of each.
	const zebra = zebraOf(draw);
	for (const lane of [-2.75, 2.75]) {
		const box = toPath([
			at(0, lane - 1.75),
			at(3, lane - 1.75),
			at(3, lane + 1.75),
			at(0, lane + 1.75)
		]);
		const painted = intersect(zebra, [box]).reduce((s, p) => s + Math.abs(area(p)), 0);
		expect(painted, `lane at ${lane}`).toBeGreaterThan(2);
	}
});

test('two lanes with no median and no sidewalks are crossed by a crosswalk too: no sidewalk is paved over them', () => {
	const { draw, at } = curvedTee([
		{ ...drive('backward'), id: 'l0' },
		{ ...drive('forward'), id: 'l1' }
	]);
	// The side road stops on the avenue's curb line, so the avenue's sidewalk
	// lies across its first 3 m: zebra stripes over both its lanes there, and
	// no sidewalk surface or crossing paving.
	const zebra = zebraOf(draw);
	const paved = [
		...surfaces(draw, 'walk'),
		...draw.crossings.flatMap((c) =>
			c.runs.filter((r) => r.kind !== 'zebra').flatMap((r) => r.rings.map(toPath))
		)
	];
	for (const lane of [-1.75, 1.75]) {
		const box = [
			toPath([at(0, lane - 1.75), at(3, lane - 1.75), at(3, lane + 1.75), at(0, lane + 1.75)])
		];
		const sum = (paths: ReturnType<typeof intersect>) =>
			paths.reduce((s, p) => s + Math.abs(area(p)), 0);
		expect(sum(intersect(zebra, box)), `stripes on the lane at ${lane}`).toBeGreaterThan(2);
		expect(sum(intersect(paved, box)), `paving on the lane at ${lane}`).toBeLessThan(0.05);
	}
});

// An east-west street with sidewalks met by one-way lanes with no
// sidewalks, each so many degrees off its line (negative: from the north).
// At -62° and 62° it is the junction of the first QA screenshot.
function slantedArms(degs: number[]) {
	const at = (angle: number): [number, number] => [
		80 * Math.cos((angle * Math.PI) / 180),
		80 * Math.sin((angle * Math.PI) / 180)
	];
	return buildModel(
		graphOf(
			{
				m: [0, 0],
				w: [-80, 0],
				e: [80, 0],
				...Object.fromEntries(degs.map((deg, i) => [`a${i}`, at(deg)]))
			},
			[
				{ id: 'west', from: 'w', to: 'm', lanes: street() },
				{ id: 'east', from: 'm', to: 'e', lanes: street() },
				...degs.map((deg, i) => ({
					id: `arm${i}`,
					from: deg < 0 ? `a${i}` : 'm',
					to: deg < 0 ? 'm' : `a${i}`,
					lanes: [drive('forward')]
				}))
			]
		)
	).scene;
}

for (const degs of [[-62, 62], [-35], [-90], [118], [-62, 35]])
	test(`a street's sidewalk carries straight on as a crosswalk over side roads without sidewalks joining at ${degs.join('° and ')}°`, () => {
		const scene = slantedArms(degs);
		const node = scene.node('m')!;
		const everything = [node, ...scene.place.roads.map((r) => scene.road(r.id)!)];
		const walk = union(
			everything.flatMap((d) => d.surfaces.filter((s) => s.role === 'walk').flatMap(groundOf))
		);
		const cars = union(
			everything.flatMap((d) =>
				d.surfaces.filter((s) => s.role === 'lane' || s.role === 'paving').flatMap(groundOf)
			)
		);
		const crossed = union(node.crossings.flatMap((c) => c.body.map(toPath)));
		const paved = union(
			node.crossings.flatMap((c) =>
				c.runs.filter((r) => r.kind !== 'zebra').flatMap((r) => r.rings.map(toPath))
			)
		);
		// Along the middle of each of the street's sidewalks (4.5 m off its
		// line), from one arm of the street to the other: sidewalk or crossing
		// all the way, the crossing wherever asphalt lies under the line, and
		// neither sidewalk nor crossing paving on that asphalt.
		for (const y of [-4.5, 4.5]) {
			let over = 0;
			for (let x = -30.1; x <= 30; x += 0.25) {
				const p = { x, y };
				const road = inside(cars, p);
				if (road) over++;
				expect(inside(crossed, p), `a crossing at ${x}, ${y}`).toBe(road);
				expect(inside(walk, p), `sidewalk at ${x}, ${y}`).toBe(!road);
				expect(inside(paved, p), `crossing paving at ${x}, ${y}`).toBe(false);
			}
			// A side road's 3.5 m lane, as wide as it lies across the line.
			if (degs.some((deg) => Math.sign(deg) === Math.sign(y)))
				expect(over * 0.25).toBeGreaterThan(3.4);
			else expect(over).toBe(0);
		}
		expect(zebraOf(node).length).toBeGreaterThan(2);
		expect(check(scene)).toEqual([]);
	});

test("the corners either side of a side road's mouth round, with the sidewalk round them", () => {
	const { scene, ends, draw } = curvedTee();
	const outline = outlineOf(ends);
	for (const key of ['north:start>side:start', 'side:start>south:end']) {
		const corner = outline.corners.find((c) => `${c.a}>${c.b}` === key)!;
		const [a, b] = [corner.pts[0], corner.pts[corner.pts.length - 1]];
		const chord = distance(a, b);
		// Bowed well off the straight line between its two curb points.
		const bow = Math.max(
			...corner.pts.map(
				(p) => Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / chord
			)
		);
		expect(bow, `${key} bow`).toBeGreaterThan(1);
		// Sidewalk just outside the curb at the middle of the corner.
		const k = Math.floor(corner.pts.length / 2);
		const [p, q] = [corner.pts[k - 1], corner.pts[k + 1]];
		const l = distance(p, q);
		const n = { x: -(q.y - p.y) / l, y: (q.x - p.x) / l };
		const m = corner.pts[k];
		const sign = inside(surfaces(draw, 'paving'), offsetPoint(m, n, 0.3)) ? -1 : 1;
		expect(inside(surfaces(draw, 'walk'), offsetPoint(m, n, sign * 1.5)), `${key} sidewalk`).toBe(
			true
		);
	}
	expect(check(scene)).toEqual([]);
});

test('the sidewalk ends square beside a crosswalk over a road without sidewalks', () => {
	const { draw, at } = curvedTee();
	// The roadway runs 4.5 m either side of the side road's line; the crossing
	// is 3 m deep, as wide as the avenue's sidewalk. Beside it on either side
	// a square of sidewalk, its far corner paved (no rounded knob), and
	// nothing beyond.
	for (const edge of [-4.5, 4.5]) {
		const out = Math.sign(edge);
		const walk = surfaces(draw, 'walk');
		expect(inside(walk, at(2.8, edge + out * 2.8)), `landing at ${edge}`).toBe(true);
		expect(inside(walk, at(3.4, edge + out * 1.5)), `past landing at ${edge}`).toBe(false);
	}
});

// A skewed four-way junction of divided roads without sidewalks: north-west,
// south-west, east and south-east, the last two only 45° apart. Each corner
// stays outside both roads' edge lines, from a few metres in front of a
// road's mouth to well behind it, so no corner pinches a road's opening
// narrower than the road. Automatically, every end sits a hair inside its
// neighbour's curb line; set by hand, south-west and south-east stop further
// out than their neighbours.
for (const name of ['skewed-four', 'skewed-four-setbacks'])
	test(`no corner of the ${name} junction cuts inside a road's edge`, () => {
		const { scene } = buildModel(sceneGraph(name));
		const j = scene.place.junctions.find((x) => x.id === 'k')!;
		const ends = endsOf(j, scene.geos);
		const outline = outlineOf(ends);
		const curb = outline.corners.flatMap((c) =>
			c.pts.flatMap((p, i) => {
				if (i === 0) return [p];
				const q = c.pts[i - 1];
				const n = Math.ceil(distance(p, q) / 0.25);
				return Array.from({ length: n }, (_, k) => ({
					x: q.x + ((p.x - q.x) * (k + 1)) / n,
					y: q.y + ((p.y - q.y) * (k + 1)) / n
				}));
			})
		);
		for (const e of ends) {
			const { p, out, n } = e.frame;
			const across = (q: Pt) => (q.x - p.x) * n.x + (q.y - p.y) * n.y;
			const along = (q: Pt) => (q.x - p.x) * out.x + (q.y - p.y) * out.y;
			const { lo, hi } = outline.curbs.get(e.key)!;
			const [left, right] = [across(lo), across(hi)].sort((a, b) => a - b);
			// How far the curb reaches in from the nearer edge line, 6 m in front
			// of the mouth to 10 m behind it. Only the hair of overlap the
			// automatic setbacks leave.
			const inside = Math.max(
				...curb
					.filter((q) => along(q) > -6 && along(q) < 10)
					.map((q) => Math.min(across(q) - left, right - across(q)))
			);
			expect(inside, e.key).toBeLessThan(0.25);
		}
	});

const divided = (): Lane[] => [
	{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'backward' },
	{ role: 'buffer', material: 'concrete', width: 2, direction: 'bidirectional' },
	{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' }
];

// How far a point lies from a polyline.
const offLine = (p: Pt, pts: Pt[]) =>
	Math.min(
		...pts.slice(1).map((b, i) => {
			const a = pts[i];
			const d = { x: b.x - a.x, y: b.y - a.y };
			const t = ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / (d.x * d.x + d.y * d.y || 1);
			const k = Math.max(0, Math.min(1, t));
			return distance(p, { x: a.x + d.x * k, y: a.y + d.y * k });
		})
	);

// Four divided roads (one lane each way, a concrete median) at a skewed
// junction (e2e/scenes/skewed-priority.json): west and east have right of way
// and bend through it, the other two stop, and both join on the same side.
// West stops 14 m short, so the curb between west and east is long and bends
// one way then the other.
test('an edge line runs the whole curb between two priority roads, at its inset', () => {
	const { scene } = buildModel(sceneGraph('skewed-priority'));
	const j = scene.place.junctions.find((x) => x.id === 'k')!;
	const outline = outlineOf(endsOf(j, scene.geos));
	const curb = outline.corners.find(
		(c) => [c.a, c.b].sort().join() === 'east:start,west:start'
	)!.pts;
	const lines = scene
		.node('k')!
		.markings.filter((m) => m.colour === 'white' && !m.dashed && offLine(m.line[0], curb) < 0.5);
	expect(lines.length).toBe(1);
	const pts = lines[0].line;
	// From one mouth to the other, the inset in from the curb all along.
	const ends = [pts[0], pts[pts.length - 1]];
	for (const c of [curb[0], curb[curb.length - 1]])
		expect(Math.min(...ends.map((p) => distance(p, c)))).toBeCloseTo(0.2, 1);
	for (const p of pts) expect(offLine(p, curb), `at ${p.x}, ${p.y}`).toBeCloseTo(0.2, 1);
	expect(check(scene)).toEqual([]);
});

test('the lines either side of a median join round its nose, but not at a free or carried end', () => {
	const { scene } = buildModel(sceneGraph('skewed-priority'));
	for (const id of ['west', 'east', 'sw', 'se']) {
		const draw = scene.road(id)!;
		const yellow = draw.markings.filter((m) => m.colour === 'yellow');
		// One line: from the free end up one side, round the nose at the
		// junction and back down the other.
		expect(yellow.length, id).toBe(1);
		const along = yellow[0].along;
		expect(along[0]).toBeCloseTo(draw.path.length, 1);
		expect(along[along.length - 1]).toBeCloseTo(draw.path.length, 1);
		// Round the tip, the inset short of it.
		expect(Math.min(...along)).toBeCloseTo(draw.cut.start.nose! - 0.2, 1);
	}

	// A road on its own, and a divided road narrowing into a plain one at a
	// node of two (the median carried square to the node): two lines each.
	const plain = (): Lane[] => divided().filter((l) => l.role === 'vehicle');
	const { scene: other } = buildModel(
		graphOf({ a: [-60, 0], m: [0, 0], b: [60, 0], c: [-60, 40], d: [60, 40] }, [
			{ id: 'taper', from: 'a', to: 'm', lanes: divided() },
			{ id: 'plain', from: 'm', to: 'b', lanes: plain() },
			{ id: 'alone', from: 'c', to: 'd', lanes: divided() }
		])
	);
	for (const id of ['taper', 'alone']) {
		const draw = other.road(id)!;
		const yellow = draw.markings.filter((m) => m.colour === 'yellow');
		expect(yellow.length, id).toBe(2);
		for (const m of yellow) {
			expect(m.along[0]).toBeCloseTo(0, 1);
			expect(m.along[m.along.length - 1]).toBeCloseTo(draw.path.length, 1);
		}
	}
	expect(check(other)).toEqual([]);
});

// A stop line runs from the approach's white edge line to the yellow line on
// its other side, both running up to it: its back edge (away from the
// junction) has a white line at one end and a yellow one at the other. On a
// divided road the yellow runs along the median (its nose comes forward past
// the stop line), on a plain one it is the centre line, and on an avenue the
// stop line spans both lanes behind its crosswalk.
test('a stop line meets the edge line and the yellow line', () => {
	const stops: JunctionData = {
		control: {
			'west:end': 'stop',
			'east:start': 'stop',
			'north:end': 'stop',
			'south:start': 'stop'
		}
	};
	const plain = (): Lane[] => divided().filter((l) => l.role === 'vehicle');
	for (const [name, lanes] of [
		['divided', divided],
		['plain', plain],
		['avenue', avenue]
	] as const) {
		const { scene } = buildModel(crossroads(lanes, lanes, stops));
		const marks = scene.place.roads.flatMap((r) => scene.road(r.id)!.markings);
		const bars = scene
			.node('c')!
			.signs.filter((s) => s.kind === 'stop')
			.flatMap(signShapes);
		expect(bars.length, name).toBe(4);
		for (const bar of bars) {
			// The roads run along the axes: the back edge is the farther one
			// out along its road.
			const out = (p: Pt) => Math.max(Math.abs(p.x), Math.abs(p.y));
			const back = [...bar].sort((p, q) => out(q) - out(p)).slice(0, 2);
			const colours = back.map(
				(p) => marks.find((m) => !m.dashed && offLine(p, m.line) < 0.1)?.colour
			);
			expect(colours.sort(), `${name} at ${back[0].x.toFixed(1)}, ${back[0].y.toFixed(1)}`).toEqual(
				['white', 'yellow']
			);
		}
		expect(check(scene), name).toEqual([]);
	}
});

// One lane each way on a line bent harder than the lanes are wide: the lane
// on the inside of the bend folds over itself at the turn.
test('a lane folded over by a bend tighter than its width is never drawn twice over one ground', () => {
	const { scene } = buildModel(
		graphOf({ a: [0, 0], b: [20, 0] }, [
			{
				id: 'bend',
				from: 'a',
				to: 'b',
				control: [10, 40],
				lanes: [
					{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'backward' },
					{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' }
				]
			}
		])
	);
	const road = scene.road('bend')!;
	// The folded lane leaves as rings, the other as its ribbon.
	const inner = road.surfaces.findIndex((s) => !('left' in s.shape));
	expect(road.surfaces.map((s) => 'left' in s.shape).sort()).toEqual([false, true]);
	expect(check(scene)).toEqual([]);
	// Drawn as its ribbon, one quad's two triangles lie on each other while
	// the quad's whole area stays positive: the rules see it.
	road.surfaces[inner].shape = { left: road.edges[inner], right: road.edges[inner + 1] };
	expect(check(scene)).toEqual([
		'ribbon inverted: bend',
		'double cover: bend lane|asphalt within one surface'
	]);
});

// A straight 100 m street with two crossings mid-block, set by hand.
function twoCrossings(first: number, second: number) {
	const lanes: Lane[] = [
		{ id: 'w0', role: 'pedestrian', material: 'concrete', width: 2, direction: 'bidirectional' },
		{ id: 'l0', role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'backward' },
		{ id: 'l1', role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' },
		{ id: 'w1', role: 'pedestrian', material: 'concrete', width: 2, direction: 'bidirectional' }
	];
	const crossings = [first, second].map(
		(at): JunctionCrossing => ({ road: 'r', end: 'start', lanes: ['w0', 'w1'], at })
	);
	const { scene } = buildModel(
		graphOf({ a: [0, 0, { crossings }], b: [100, 0] }, [{ id: 'r', from: 'a', to: 'b', lanes }])
	);
	return { scene, road: scene.road('r')! };
}

test('two crossings with less than a metre of road between them leave no line there', () => {
	// 3 m deep each: 20 cm of road lies between them.
	const { scene, road } = twoCrossings(50, 53.2);
	expect(road.crossings.length).toBe(2);
	const pieces = road.markings.map((m) => [m.along[0], m.along[m.along.length - 1]]);
	expect(pieces.length).toBeGreaterThan(0);
	for (const [from, to] of pieces) {
		expect(to - from).toBeGreaterThan(1);
		expect(to < 48.51 || from > 54.69, `a line from ${from} to ${to}`).toBe(true);
	}
	expect(check(scene)).toEqual([]);
});

test('two crossings lying over each other paint their shared ground once', () => {
	const { scene, road } = twoCrossings(50, 51);
	const zebra = road.crossings.map((c) =>
		c.runs.filter((r) => r.kind === 'zebra').flatMap((r) => r.rings.map(toPath))
	);
	expect(zebra.length).toBe(2);
	const shared = intersect(zebra[0], zebra[1]).reduce((s, p) => s + Math.abs(area(p)), 0);
	expect(shared).toBeLessThan(0.01);
	// Together they stripe the 4 m they span: a stripe every metre, half a
	// metre wide, across the 7 m roadway.
	const striped = zebra.flat().reduce((s, p) => s + area(p), 0);
	expect(striped).toBeCloseTo(7 * 0.5 * 4, 1);
	expect(check(scene)).toEqual([]);
});

test('every sign at a node names the lanes it is painted across', () => {
	const kinds = new Map<string, number>();
	// Two one-way roads driving head on into a node: each lane ends there.
	const oneWay = (id: string, from: string, to: string, direction: Lane['direction']) => ({
		id,
		startNodeId: from,
		endNodeId: to,
		lanes: [
			{ id: 'l', role: 'vehicle' as const, material: 'asphalt' as const, width: 3.5, direction }
		]
	});
	const headOn = {
		nodes: [
			{ id: 'a', x: 0, y: 0 },
			{ id: 'b', x: 50, y: 0 },
			{ id: 'c', x: 100, y: 0 }
		],
		segments: [oneWay('ab', 'a', 'b', 'forward'), oneWay('bc', 'b', 'c', 'backward')]
	};
	const graphs = [
		...readdirSync('e2e/scenes').map((file) => sceneGraph(file.replace('.json', ''))),
		JSON.parse(readFileSync('static/examples/neighbourhood.json', 'utf8')).graph,
		headOn
	];
	for (const graph of graphs) {
		const { scene } = buildModel(graph);
		for (const j of scene.place.junctions)
			for (const sign of scene.node(j.id)!.signs) {
				kinds.set(sign.kind, (kinds.get(sign.kind) ?? 0) + 1);
				const lanes = 'lanes' in sign ? sign.lanes : [sign.lane];
				expect(lanes.length).toBeGreaterThan(0);
				for (const l of lanes) expect(l.road).toBeTruthy();
			}
	}
	expect([...kinds.keys()].sort()).toEqual(['arrow', 'end', 'stop', 'yield']);
});

test('a hatched median carried past a driveway is not drawn over by the paving beneath it', () => {
	// A street with hatching between its two directions; a one-way driveway
	// from the south turning only into the near side, so the hatching runs on
	// across the node.
	const lanes = (codes: [string, Lane['role'], Lane['material'], number, Lane['direction']][]) =>
		codes.map(
			([id, role, material, width, direction]): Lane => ({ id, role, material, width, direction })
		);
	const street = lanes([
		['w0', 'pedestrian', 'concrete', 2, 'bidirectional'],
		['l1', 'vehicle', 'asphalt', 3.5, 'backward'],
		['h2', 'buffer', 'asphalt', 2, 'bidirectional'],
		['l3', 'vehicle', 'asphalt', 3.5, 'forward'],
		['w4', 'pedestrian', 'concrete', 2, 'bidirectional']
	]);
	const removed = [
		{
			from: { road: 'drive', end: 'end' as const, lane: 'd0' },
			to: { road: 'west', end: 'end' as const, lane: 'l1' }
		}
	];
	const { scene } = buildModel(
		graphOf({ w: [-60, 0], m: [0, 0, { removed }], e: [60, 0], s: [0, 40] }, [
			{ id: 'west', from: 'w', to: 'm', lanes: street },
			{ id: 'east', from: 'm', to: 'e', lanes: street },
			{
				id: 'drive',
				from: 's',
				to: 'm',
				lanes: lanes([['d0', 'vehicle', 'asphalt', 3, 'forward']])
			}
		])
	);
	const node = scene.node('m')!;
	const band = node.surfaces.filter((s) => s.role === 'lane');
	expect(band).toHaveLength(1);
	expect(check(scene)).toEqual([]);
});

test('paving shrunk anywhere from a millimetre to 20 cm short of its curbs is found', () => {
	for (const shrink of [0.001, 0.01, 0.04, 0.15, 0.2]) {
		const { scene } = buildModel(sceneGraph('crossroads'));
		expect(check(scene)).toEqual([]);
		// The description the scene holds, drawn short all round.
		const paving = scene.node('c')!.surfaces.find((s) => s.role === 'paving')!;
		const rings = paving.shape as Ring[];
		paving.shape = toRings(offset(union(rings.map(toPath)), -shrink), []);
		const found = check(scene);
		expect(
			found.some((p) => /^(crack|seam)/.test(p)),
			`${shrink} m: ${found.join('; ')}`
		).toBe(true);
	}
});

// The turn, in degrees, between each line of a road and the line of the node
// that carries it on from the same point at the road's end (within 2 cm).
function turnsWhereLinesMeet(scene: Scene, nodeId: string) {
	const node = scene.node(nodeId)!;
	const heading = (a: Pt, b: Pt) => {
		const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
		return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
	};
	const turns: number[] = [];
	for (const end of node.ends)
		for (const own of scene.road(end.ref.road)!.markings)
			for (const k of [0, own.line.length - 1]) {
				const at = own.line[k];
				// Along the road's line, on toward the node.
				const into = heading(own.line[k === 0 ? 1 : k - 1], at);
				for (const m of node.markings)
					for (const i of [0, m.line.length - 1]) {
						if (
							m.colour !== own.colour ||
							Math.hypot(m.line[i].x - at.x, m.line[i].y - at.y) > 0.02
						)
							continue;
						const on = heading(m.line[i], m.line[i === 0 ? 1 : i - 1]);
						const cos = Math.max(-1, Math.min(1, into.x * on.x + into.y * on.y));
						turns.push((Math.acos(cos) * 180) / Math.PI);
					}
			}
	return turns;
}

test('the lines a junction or a taper carries on from a road run on from the road’s own without a step or a kink, however the road is shifted at its ends', () => {
	// A street carrying on past a side street, and the same with the street
	// shifted 3 m to one side where it meets the junction: its lanes and lines
	// then run at 4° to its drawn line all the way along it.
	for (const shift of [0, 3, -3]) {
		const { scene } = buildModel(
			graphOf({ w: [-45, 0], m: [0, 0], e: [45, 0], s: [0, 60] }, [
				{ id: 'west', from: 'w', to: 'm', lanes: street(), offsetEnd: shift },
				{ id: 'east', from: 'm', to: 'e', lanes: street(), offsetStart: shift },
				{ id: 'side', from: 'm', to: 's', lanes: street() }
			])
		);
		// The far edge line is carried across from one arm to the other: it
		// starts on the end of west's and ends on the start of east's, and
		// leaves each the way that road's line runs.
		const turns = turnsWhereLinesMeet(scene, 'm');
		expect(turns.length, `shifted ${shift}`).toBeGreaterThanOrEqual(2);
		for (const turn of turns) expect(turn, `shifted ${shift}`).toBeLessThan(0.5);
		expect(check(scene)).toEqual([]);
	}
	// Two roads of the same lanes meeting end to end, each shifted 2.5 m
	// where they meet: every line across the node between them.
	const { scene } = buildModel(
		graphOf({ a: [-40, 0], m: [0, 0], b: [40, 0] }, [
			{ id: 'one', from: 'a', to: 'm', lanes: street(), offsetEnd: 2.5 },
			{ id: 'two', from: 'm', to: 'b', lanes: street(), offsetStart: 2.5 }
		])
	);
	const turns = turnsWhereLinesMeet(scene, 'm');
	// Two white edge lines and the two yellow ones, at both ends.
	expect(turns.length).toBe(8);
	for (const turn of turns) expect(turn).toBeLessThan(0.5);
	expect(check(scene)).toEqual([]);
});

test('an approach with room for its arrows that lacks one is reported', () => {
	// The roundabout's entries give way at the ring, each with an arrow.
	const { scene } = buildModel(readScene('roundabout'));
	expect(check(scene)).toEqual([]);
	const j = scene.place.junctions.find((x) => scene.node(x.id)!.approaches.some((a) => a.arrows))!;
	const node = scene.node(j.id)!;
	const bare = { ...node, signs: node.signs.filter((s) => s.kind !== 'arrow') };
	const found = check({ ...scene, node: (id) => (id === j.id ? bare : scene.node(id)) });
	expect(found.some((p) => p.startsWith(`arrows left out: ${j.id}`))).toBe(true);
});

// Whether some piece drawn paves a point for walking (walkAt).
const walkedAt = (scene: Scene, p: Pt) =>
	[
		...scene.place.roads.map((r) => scene.road(r.id)),
		...scene.place.junctions.map((j) => scene.node(j.id))
	].some((d) => d && walkAt(d, p));

// Three roads meeting at m, as a T (two running straight on, so the corner
// between them is straight too) and as a Y, each shifted differently at its
// two ends, so its lanes run at a slant (`lean`, metres of shift a metre
// along) to the line it is drawn on, which its end lies square to. Each
// corner's sidewalk runs back into both roads' own sidewalks square to their
// ends, so the two meet across the sidewalk's whole width just in front of
// each end, however the road leans, whichever way it is stored, straight or
// curved.
test("a corner's sidewalk meets each road's own across its whole width, however the road leans", () => {
	const shapes: Record<string, Record<string, [number, number]>> = {
		T: { a: [40, 0], b: [-40, 0], c: [0, 40] },
		Y: { a: [40, 0], b: [-20, 34.6], c: [-20, -34.6] }
	};
	for (const [shape, arms] of Object.entries(shapes))
		for (const lanes of [street, avenue])
			for (const lean of [-0.16, -0.08, 0.08, 0.16])
				for (const flip of [false, true])
					for (const bow of [0, 6]) {
						const segs = Object.entries(arms).map(([id, [x, y]]): Seg => {
							// Shifted 2 m at the junction, less or more at the far end.
							const [near, far] = [2, 2 - lean * 40];
							const control: [number, number] = [x / 2 - (y / 40) * bow, y / 2 + (x / 40) * bow];
							return flip
								? {
										id,
										from: id,
										to: 'm',
										lanes: lanes(),
										offsetStart: far,
										offsetEnd: near,
										control
									}
								: {
										id,
										from: 'm',
										to: id,
										lanes: lanes(),
										offsetStart: near,
										offsetEnd: far,
										control
									};
						});
						const { scene } = buildModel(graphOf({ m: [0, 0], ...arms }, segs));
						const node = scene.node('m')!;
						const label = `${shape} ${lanes === street ? 'street' : 'avenue'} lean ${lean} flip ${flip} bow ${bow}`;
						expect(node.walkways?.length, label).toBe(3);
						for (const w of node.walkways!)
							for (const ref of [w.a, w.b]) {
								const end = node.ends.find(
									(e) => e.ref.road === ref.road && e.ref.end === ref.end
								)!;
								const walk = end.lanes.find((l) => l.lane.id === ref.lane)!;
								for (let t = walk.left + 0.05; t < walk.right - 0.04; t += 0.1) {
									const p = offsetPoint(
										offsetPoint(end.frame.p, end.frame.n, t),
										end.frame.out,
										-0.03
									);
									expect(walkedAt(scene, p), `${label}: ${ref.road} at ${t.toFixed(2)}`).toBe(true);
								}
							}
					}
});

// Six roads meeting, a corner between two streets running out of the
// junction at a sharp angle with a curb swinging out past where the two
// streets' sidewalk edges meet: the rounding between those edges crosses the curb, and
// the corner's sidewalk keeps all of its band all the same, paved along its
// middle, with no point of it running on from it.
test('a corner whose curb swings out past where its sidewalks meet is paved all round, with no point', () => {
	const path = () => createLanesFrom('path');
	const { scene } = buildModel(
		graphOf(
			{
				centre: [0, 0],
				'arm-0': [-59.65604145768502, -57.46020749934989],
				'arm-1': [7.190903948353953, -68.72499074564377],
				'arm-2': [72.64889726560733, -49.312891380646164],
				'arm-3': [53.9908755802293, 47.2183828816398],
				'arm-4': [-10.17553637024968, 47.35585423767769],
				'arm-5': [-90.86502401485353, 54.54076380979003],
				p0: [-14.694788404740393, 10.380115695297718],
				q0: [35.127231632359326, 28.282369105145335],
				p1: [63.48425823729485, 7.991949412971735],
				q1: [32.64614297542721, 54.185689175501466],
				p2: [-67.35573369544, -49.57988605834544],
				q2: [-6.791751240380108, -6.6838775016367435],
				p3: [-68.14889570232481, 52.43060399778187],
				q3: [4.168924069963396, -68.612927980721]
			},
			[
				{
					id: 'arm-0',
					from: 'centre',
					to: 'arm-0',
					lanes: avenue(),
					control: [-12.861137705094098, -46.34537388394794],
					offsetStart: -3.6676226910203695,
					offsetEnd: 0.2287731021642685
				},
				{
					id: 'arm-1',
					from: 'arm-1',
					to: 'centre',
					lanes: avenue(),
					control: [-5.438842914391087, -35.30778101171323],
					offsetStart: -3.965477893128991,
					offsetEnd: -3.2015167511999607
				},
				{
					id: 'arm-2',
					from: 'centre',
					to: 'arm-2',
					lanes: street(),
					control: [30.355956374757827, -33.44936715052206],
					offsetStart: -1.7842912506312132,
					offsetEnd: -3.5054131373763084
				},
				{
					id: 'arm-3',
					from: 'arm-3',
					to: 'centre',
					lanes: street(),
					control: [31.10141693248805, 18.914295184703132],
					offsetStart: -1.7378554213792086,
					offsetEnd: 2.0932725556194782
				},
				{
					id: 'arm-4',
					from: 'centre',
					to: 'arm-4',
					lanes: street(),
					control: [-19.411257959518593, 20.600183226463216],
					offsetStart: 0.7514603529125452,
					offsetEnd: 2.4324755370616913
				},
				{
					id: 'arm-5',
					from: 'arm-5',
					to: 'centre',
					lanes: avenue(),
					control: [-29.155110615339805, 54.38856590300588],
					offsetStart: -0.10174837149679661,
					offsetEnd: -0.8195219226181507
				},
				{ id: 'path-0', from: 'p0', to: 'q0', lanes: path() },
				{
					id: 'path-1',
					from: 'p1',
					to: 'q1',
					lanes: path(),
					control: [6.2780295219272375, 5.418142676353455]
				},
				{ id: 'path-2', from: 'p2', to: 'q2', lanes: path() },
				{
					id: 'path-3',
					from: 'p3',
					to: 'q3',
					lanes: path(),
					control: [33.51634849794209, -11.688306201249361]
				}
			]
		)
	);
	const node = scene.node('centre')!;
	const corner = node.walkways!.find((w) => w.a.road === 'arm-3' && w.b.road === 'arm-4')!;
	const line = corner.line;
	for (let k = 1; k < line.length; k++)
		for (let f = 0; f < 1; f += 0.25) {
			const p = {
				x: line[k - 1].x + (line[k].x - line[k - 1].x) * f,
				y: line[k - 1].y + (line[k].y - line[k - 1].y) * f
			};
			expect(walkedAt(scene, p), `middle at (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`).toBe(true);
		}
	// Its points ran on along the street's curb, to (-9.4, 37.2) and (-11.5, 22.0).
	const spikes = check(scene).filter((s) => s.startsWith('sidewalk spike'));
	const near = (s: string) => {
		const [x, y] = s.match(/-?[\d.]+/g)!.map(Number);
		return x > -15 && x < -5 && y > 15 && y < 45;
	};
	expect(spikes.filter(near)).toEqual([]);
});

// Six roads meeting, a corner between a street and an avenue whose curb
// swings out past where their sidewalks' edges meet, so the rounding between
// those edges crosses the avenue's grass verge round the corner: the verge
// stays grass there, with no sidewalk under it.
test('a corner whose curb swings out past where its sidewalks meet leaves its verge grass', () => {
	const arm = (id: string, from: string, to: string, lanes: () => Lane[], more: number[]): Seg => ({
		id,
		from,
		to,
		lanes: lanes(),
		offsetStart: more[0],
		offsetEnd: more[1],
		control: [more[2], more[3]]
	});
	const { scene } = buildModel(
		graphOf(
			{
				centre: [0, 0],
				'arm-0': [-22.382963603425484, -29.899523086727427],
				'arm-1': [3.532287733469704, -33.66084986474954],
				'arm-2': [53.8000789534598, -4.056999826622953],
				'arm-3': [66.65053995835436, 50.573458484249265],
				'arm-4': [-7.115036110275707, 45.418302790960034],
				'arm-5': [-91.94599608501689, 26.612516994826958]
			},
			[
				arm(
					'arm-0',
					'centre',
					'arm-0',
					avenue,
					[-3.63072950206697, 1.864115759730339, -6.215720826359286, -18.67464626769967]
				),
				arm(
					'arm-1',
					'arm-1',
					'centre',
					street,
					[-0.6128636691719294, 2.9896153770387173, 2.7602966726424705, -16.72610095435247]
				),
				arm(
					'arm-2',
					'centre',
					'arm-2',
					avenue,
					[1.9667046833783388, -0.9983558878302574, 28.00968952310444, 12.686625217801522]
				),
				arm(
					'arm-3',
					'arm-3',
					'centre',
					avenue,
					[-3.763049768283963, -0.5270090810954571, 33.29711192129663, 25.323838623570264]
				),
				arm(
					'arm-4',
					'centre',
					'arm-4',
					street,
					[-0.703164478763938, -0.9654707610607147, 1.6581588805309435, 23.526216927576517]
				),
				arm(
					'arm-5',
					'arm-5',
					'centre',
					avenue,
					[-2.958288276568055, 1.0949893407523632, -56.209484635390794, -22.060706467848668]
				)
			]
		)
	);
	const node = scene.node('centre')!;
	const verge = node.surfaces.filter((s) => s.role === 'verge');
	// Along the verge round the arm-1 to arm-2 corner.
	for (const q of [
		{ x: 10.88, y: -12.11 },
		{ x: 12.77, y: -9.95 },
		{ x: 15.48, y: -7.64 },
		{ x: 17.59, y: -6.33 }
	]) {
		const at = `(${q.x}, ${q.y})`;
		expect(
			verge.some((s) => inside(shapeOf(s), q)),
			at
		).toBe(true);
		expect(walkedAt(scene, q), at).toBe(false);
	}
});
