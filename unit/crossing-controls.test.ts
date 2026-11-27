import { expect, test } from 'bun:test';
import { resolveCrossings, splitSegment } from '../src/lib/core/crossings';
import { Graph } from '../src/lib/core/graph.svelte';
import { WALK } from '../src/lib/core/footpaths';
import { join, joinPlan } from '../src/lib/core/join';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { Networks, type Scene } from '../src/lib/core/networks';
import type { CrossingControl, GraphData, Lane } from '../src/lib/core/types';
import { STOP_ROOM } from '../src/lib/road-model/approach';
import { check } from '../src/lib/road-model/checks';
import { area, inside, intersect, toPath, union } from '../src/lib/road-model/clip';
import type { Description, Sign } from '../src/lib/road-model/description';
import type { Control } from '../src/lib/road-model/model';
import { signShapes } from '../src/lib/rendering/road-meshes';
import { buildModel, editorDrawing, liveShape, readScene } from './model';
import { cityOf, frame, openEditor } from './editor.svelte';

// A crossing is paint: every car approach a footpath's crossing lies on is
// held by its control, give-way unless one is set on it, a line behind its
// own crossing, on no other paint, or left out where there is no room for
// it: behind a crossing of the road's own over the same ground, behind the
// first of two crossings close together, and where the footpath crosses a
// roundabout's ramps close to where the approach splits into them, on the
// split node's ground. Nothing in the graph marks a crossing: no node, no
// cut; a control set on it is stored on its footpath
// (core/crossing-controls.ts). Near a junction a crossing over an approach is
// that approach's: one line behind it, the stronger control, the arrows
// behind that (approachesOf in road-model/approach.ts). The first two graphs
// are saved with footpaths and streets sharing a node, as before.

const preset = (id: string): Lane[] => createLanesFrom(id).map((l, i) => ({ ...l, id: `l${i}` }));
type Pt = { x: number; y: number };
const node = (
	id: string,
	x: number,
	y: number,
	junction?: GraphData['nodes'][number]['junction']
) => ({
	id,
	x,
	y,
	...(junction && { junction })
});
const segment = (id: string, startNodeId: string, endNodeId: string, lanes: Lane[]) => ({
	id,
	startNodeId,
	endNodeId,
	lanes
});

// Every piece's description.
const piecesOf = (scene: Scene): Description[] => [
	...scene.place.roads.map((r) => scene.road(r.id)!),
	...scene.place.junctions.map((j) => scene.node(j.id)!)
];
const controls = (scene: Scene) =>
	piecesOf(scene).flatMap((d) => d.signs.filter((s) => s.kind === 'stop' || s.kind === 'yield'));
const mid = (s: Sign & { a: Pt; b: Pt }) => ({ x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 });
// The car pieces as drawn, each road's and junction's description.
const carDrawn = (scene: Scene) =>
	[
		...scene.place.roads
			.filter((r) => r.lanes.some((l) => l.kind === 'drive'))
			.map((r) => scene.road(r.id)),
		...scene.place.junctions.filter((j) => !j.id.startsWith(WALK)).map((j) => scene.node(j.id))
	].map((d) => JSON.stringify(d, (k, v) => (k === 'key' ? undefined : v)));
const zebras = (scene: Scene) =>
	piecesOf(scene).flatMap((d) => d.crossings.filter((c) => c.runs.some((r) => r.kind === 'zebra')));

// How much of a sign lies on other paint: any crossing's stripes or
// paving, or another sign.
function onOtherPaint(scene: Scene, sign: Sign) {
	const own = union(signShapes(sign).map(toPath));
	const others = [
		...piecesOf(scene).flatMap((d) => d.crossings.flatMap((c) => c.runs.flatMap((r) => r.rings))),
		...controls(scene)
			.filter((s) => s !== sign)
			.flatMap(signShapes)
	];
	return intersect(own, union(others.map(toPath))).reduce((s, p) => s + Math.abs(area(p)), 0);
}

test('a footpath crossing a street where its own zebra already lies gives way each way', () => {
	// A street west to east through m, a footpath crossing it at m, and the
	// street's own zebra placed by hand there; m, saved holding both kinds,
	// holds a stop each way on the street, which it only carries on through.
	const at = (manual: boolean) =>
		buildModel({
			nodes: [
				node(
					'w',
					-60,
					0,
					manual
						? { crossings: [{ road: 'west', end: 'start', lanes: ['l0', 'l3'], at: 60 }] }
						: undefined
				),
				node('m', 0, 0, { control: { 'west:end': 'stop', 'east:start': 'stop' } }),
				node('e', 60, 0),
				node('p', 0, -24),
				node('q', 0, 24)
			],
			segments: [
				segment('west', 'w', 'm', preset('street')),
				segment('east', 'm', 'e', preset('street')),
				segment('south', 'p', 'm', preset('path')),
				segment('north', 'm', 'q', preset('path'))
			]
		}).scene;
	for (const manual of [false, true]) {
		const scene = at(manual);
		expect(zebras(scene)).toHaveLength(1);
		const zebra = zebras(scene)[0].runs.flatMap((r) => r.rings.flat());
		const [x0, x1] = [Math.min(...zebra.map((p) => p.x)), Math.max(...zebra.map((p) => p.x))];
		// A give-way each way, each just behind the zebra on its own side.
		expect(controls(scene).map((s) => s.kind)).toEqual(['yield', 'yield']);
		const stops = controls(scene).map(mid);
		expect(stops.map((p) => (p.x < 0 ? 'west' : 'east')).sort()).toEqual(['east', 'west']);
		for (const p of stops) {
			const behind = p.x < 0 ? x0 - p.x : p.x - x1;
			expect(behind).toBeGreaterThan(0);
			expect(behind).toBeLessThan(STOP_ROOM);
		}
		for (const s of controls(scene)) expect(onOtherPaint(scene, s)).toBeLessThan(1e-3);
		expect(check(scene)).toEqual([]);
	}
});

test('of two crossings close together, each give-way stands behind its own or is left out', () => {
	// One eastbound lane crossed by two footpaths `gap` apart, each giving way
	// (the stop and give-way saved on the street there, which it only carries
	// on through, draw nothing).
	const lane = {
		id: 'drive',
		role: 'vehicle',
		material: 'asphalt',
		direction: 'forward',
		width: 3.5
	} as const;
	const walk = {
		id: 'walk',
		role: 'pedestrian',
		material: 'concrete',
		direction: 'bidirectional',
		width: 3
	} as const;
	const at = (gap: number) =>
		buildModel({
			nodes: [
				node('w', -60, 0),
				node('a', 0, 0, { control: { 'west:end': 'stop' } }),
				node('b', gap, 0, { control: { 'centre:end': 'yield' } }),
				node('e', 60, 0),
				node('as', 0, 20),
				node('an', 0, -20),
				node('bs', gap, 20),
				node('bn', gap, -20)
			],
			segments: [
				segment('west', 'w', 'a', [lane]),
				segment('centre', 'a', 'b', [lane]),
				segment('east', 'b', 'e', [lane]),
				segment('wa', 'as', 'a', [walk]),
				segment('wb', 'a', 'an', [walk]),
				segment('wc', 'bs', 'b', [walk]),
				segment('wd', 'b', 'bn', [walk])
			]
		}).scene;
	for (const [gap, kinds] of [
		// The crossings touching, or all but: one crossing, which only the
		// give-way traffic meets first stands behind.
		[3, ['yield']],
		[3.04, ['yield']],
		[3.06, ['yield']],
		// The second's teeth would reach onto the first crossing: no room.
		[4, ['yield']],
		[5, ['yield']],
		[6, ['yield', 'yield']]
	] as const) {
		const scene = at(gap);
		const signs = controls(scene);
		expect([gap, signs.map((s) => s.kind).sort()]).toEqual([gap, [...kinds]]);
		const [first, second] = (signs as (Sign & { a: Pt; b: Pt })[])
			.map(mid)
			.sort((p, q) => p.x - q.x);
		// Behind the first crossing (x from -1.5 to 1.5).
		expect(first.x).toBeLessThan(-1.5);
		expect(first.x).toBeGreaterThan(-1.5 - STOP_ROOM);
		// Between the two, behind the second.
		if (second) expect(second.x).toBeGreaterThan(1.5);
		for (const s of signs) expect([gap, onOtherPaint(scene, s)]).toEqual([gap, 0]);
		expect(check(scene)).toEqual([]);
	}
});

// The roundabout (e2e/scenes/roundabout.json): the north approach runs south
// from y -110 and splits at y -50 into the entry ramp (west of x 0, its
// traffic heading south to the ring) and the exit ramp (east, heading north);
// the split node's ground reaches some 16 m down both. A footpath laid across
// both ramps `d` south of the split, as drawing lays one: it is cut nowhere.
function acrossRamps(d: number) {
	const graph = new Graph();
	graph.fromJSON(readScene('roundabout'));
	const was = new Set(graph.nodes.keys());
	const y = -50 + d;
	const [a, b] = [graph.createNode(-20, y), graph.createNode(20, y)];
	resolveCrossings(graph, [graph.createSegment(a.id, b.id, preset('path')).id]);
	const cuts = [...graph.nodes.values()].filter((n) => !was.has(n.id) && n !== a && n !== b);
	return { cuts: cuts.length, scene: buildModel(graph.toJSON()).scene, y };
}

for (const d of [4, 6, 8, 12, 18])
	test(`a footpath across both roundabout ramps ${d} m from the split gives way on each`, () => {
		const { cuts, scene, y } = acrossRamps(d);
		expect(cuts).toBe(0);
		// The footpath's 2 m: the crossing on each ramp, y - 1 to y + 1.
		// (The ring's own give-ways stand where the ramps meet it.)
		const stops = controls(scene)
			.filter((s) => s.kind === 'yield')
			.map((s) => ({ s, p: mid(s as Sign & { a: Pt; b: Pt }) }));
		const entry = stops.filter(({ p }) => p.x < 0 && p.x > -8 && Math.abs(p.y - y) < 6);
		const exit = stops.filter(({ p }) => p.x > 0 && p.x < 8 && Math.abs(p.y - y) < 6);
		expect([entry.length, exit.length]).toEqual([1, 1]);
		// Entering traffic heads south (y growing), leaving traffic north: each
		// gives way just short of the crossing, on its own side of it.
		expect(y - 1 - entry[0].p.y).toBeGreaterThan(0);
		expect(y - 1 - entry[0].p.y).toBeLessThan(STOP_ROOM);
		expect(exit[0].p.y - (y + 1)).toBeGreaterThan(0);
		expect(exit[0].p.y - (y + 1)).toBeLessThan(STOP_ROOM);
		for (const { s } of [...entry, ...exit]) expect(onOtherPaint(scene, s)).toBeLessThan(1e-3);
		expect(check(scene)).toEqual([]);
	});

test('a crossing laid in two pieces, the first ending inside the roadway, is drawn with no node of its own', () => {
	// A street along y = 0; a footpath from (0, -18) to (0, 2), short of the
	// far curb, then on to (12, 18): the second piece makes a crossing of the
	// two, which is paint: the graph holds the two pieces and their nodes
	// alone.
	const graph = new Graph();
	const [w, e] = [graph.createNode(-65, 0), graph.createNode(65, 0)];
	graph.createSegment(w.id, e.id, preset('street'));
	const [a, b, c] = [graph.createNode(0, -18), graph.createNode(0, 2), graph.createNode(12, 18)];
	expect(resolveCrossings(graph, [graph.createSegment(a.id, b.id, preset('path')).id])).toBe(false);
	expect(resolveCrossings(graph, [graph.createSegment(b.id, c.id, preset('path')).id])).toBe(false);
	expect(graph.segments.size).toBe(3);
	expect([...graph.nodes.values()].filter((n) => ![w, e, a, b, c].includes(n))).toEqual([]);
	const scene = buildModel(graph.toJSON()).scene;
	expect(zebras(scene)).toHaveLength(1);
	expect(controls(scene).map((s) => s.kind)).toEqual(['yield', 'yield']);
});

test('a crossing near a dead end gives way only where the whole marking lies on the road', () => {
	// A street from (-70, 0) to a dead end at (70, 0), crossed by a footpath
	// at x. Close to the end the westbound give-way's teeth would reach past
	// it: it is left out, the eastbound one kept.
	for (const [x, ways] of [
		[60, 2],
		[66, 2],
		[67, 1],
		[69, 1]
	] as const) {
		const { scene } = buildModel({
			nodes: [node('w', -70, 0), node('e', 70, 0), node('p', x, -16), node('q', x, 16)],
			segments: [
				segment('street', 'w', 'e', preset('street')),
				segment('walk', 'p', 'q', preset('path'))
			]
		});
		const road = scene.road('street')!;
		const ground = union(
			road.surfaces.flatMap((s) =>
				'left' in s.shape
					? [toPath([...s.shape.left, ...s.shape.right.toReversed()])]
					: s.shape.map(toPath)
			)
		);
		const yields = controls(scene).filter((s) => s.kind === 'yield');
		const off = yields.map((s) => {
			const paint = union(signShapes(s).map(toPath));
			return (
				paint.reduce((t, p) => t + Math.abs(area(p)), 0) -
				intersect(paint, ground).reduce((t, p) => t + Math.abs(area(p)), 0)
			);
		});
		expect([x, yields.length]).toEqual([x, ways]);
		for (const m of off) expect([x, m]).toEqual([x, expect.closeTo(0, 3)]);
	}
});

test('a footpath crossing a street twice makes two crossings, each with its own give-ways', () => {
	// A street along y = 0 and a footpath from (-32, -20) to (32, -20) bent
	// through (0, 60): it crosses the street near x = -22 and x = 22 and
	// nowhere between.
	const { scene } = buildModel({
		nodes: [node('w', -70, 0), node('e', 70, 0), node('p', -32, -20), node('q', 32, -20)],
		segments: [
			segment('street', 'w', 'e', preset('street')),
			{ ...segment('walk', 'p', 'q', preset('path')), controlX: 0, controlY: 60 }
		]
	});
	const spans = zebras(scene).map((c) => {
		const xs = c.runs
			.filter((r) => r.kind === 'zebra')
			.flatMap((r) => r.rings.flat().map((p) => p.x));
		return [Math.min(...xs), Math.max(...xs)];
	});
	expect(spans).toHaveLength(2);
	// No stripe lies between the two crossings.
	for (const [x0, x1] of spans) expect(x1 - x0).toBeLessThan(8);
	expect(spans.map(([x0, x1]) => Math.sign(x0 + x1)).sort()).toEqual([-1, 1]);
	// Each crossing gives way each way, behind it on either side.
	const yields = controls(scene).map((s) => mid(s as Sign & { a: Pt; b: Pt }));
	for (const [x0, x1] of spans) {
		const at = yields.filter((p) => p.x > x0 - STOP_ROOM - 1 && p.x < x1 + STOP_ROOM + 1);
		expect(at).toHaveLength(2);
	}
	expect(controls(scene).map((s) => s.kind)).toEqual(['yield', 'yield', 'yield', 'yield']);
	expect(check(scene)).toEqual([]);
});

test("a kept build follows a footpath's handle bent to cross a street twice and straightened, as a fresh build draws it", () => {
	// The footpath of the test above, laid straight south of the street, its
	// curve's handle then dragged to (0, 60) and taken off again.
	const graph = liveShape({
		nodes: [node('w', -70, 0), node('e', 70, 0), node('p', -32, -20), node('q', 32, -20)],
		segments: [
			segment('street', 'w', 'e', preset('street')),
			segment('walk', 'p', 'q', preset('path'))
		]
	});
	const kept = editorDrawing();
	// Every piece drawn, but the keys its caches go by.
	const json = (d: unknown) => JSON.stringify(d, (k, v) => (k === 'key' ? undefined : v));
	const piecesDrawn = (scene: Scene) => piecesOf(scene).map(json);
	const walk = graph.segments.get('walk')!;
	const bend = (handle: Pt | null) =>
		Object.assign(walk, {
			hasControlPoint: handle !== null,
			controlX: handle?.x,
			controlY: handle?.y
		});
	for (const [label, handle, crossings] of [
		['straight', null, 0],
		['bent', { x: 0, y: 60 }, 2],
		['straightened', null, 0]
	] as const) {
		bend(handle);
		const scene = kept(graph);
		expect([label, piecesDrawn(scene)]).toEqual([label, piecesDrawn(editorDrawing()(graph))]);
		expect([label, zebras(scene).length, controls(scene).length]).toEqual([
			label,
			crossings,
			crossings * 2
		]);
		expect([label, check(scene)]).toEqual([label, []]);
	}
});

// A street along y = 0 crossed by a footpath at x = 0, the footpath storing
// `controls`.
const across = (controls?: CrossingControl[]): GraphData => ({
	nodes: [node('w', -60, 0), node('e', 60, 0), node('p', 0, -16), node('q', 0, 16)],
	segments: [
		segment('street', 'w', 'e', preset('street')),
		{ ...segment('walk', 'p', 'q', preset('path')), ...(controls && { controls }) }
	]
});

test("a crossing's control set on its footpath holds both approaches, a signal behind a stop line", () => {
	for (const [control, kinds] of [
		[undefined, ['yield', 'yield']],
		['yield', ['yield', 'yield']],
		['stop', ['stop', 'stop']],
		['signal', ['stop', 'stop']],
		['none', []]
	] as const) {
		const { scene } = buildModel(across(control && [{ roads: ['street'], control }]));
		expect([control, controls(scene).map((s) => s.kind)]).toEqual([control, [...kinds]]);
		for (const p of controls(scene).map((s) => mid(s as Sign & { a: Pt; b: Pt })))
			expect(Math.abs(p.x)).toBeLessThan(1 + STOP_ROOM + 0.5);
		expect(check(scene)).toEqual([]);
	}
});

test('a control naming another road, or stored on a car road, holds no crossing', () => {
	const elsewhere = buildModel(across([{ roads: ['other'], control: 'stop' }])).scene;
	expect(controls(elsewhere).map((s) => s.kind)).toEqual(['yield', 'yield']);
	const graph = new Graph();
	const data = across();
	data.segments[0] = {
		...data.segments[0],
		controls: [{ roads: ['x'], control: 'stop' }]
	};
	graph.fromJSON(data);
	expect(graph.segments.get('street')!.controls).toBeUndefined();
	expect(graph.toJSON().segments[0].controls).toBeUndefined();
});

test('a control carries onto the pieces of either road cut, the street anywhere along it', () => {
	const drawn = (graph: Graph) =>
		controls(buildModel(graph.toJSON()).scene)
			.map((s) => s.kind)
			.sort();
	for (const cut of ['street', 'walk'] as const)
		for (const t of [0.2, 0.48, 0.52, 0.8]) {
			const graph = new Graph();
			graph.fromJSON(across([{ roads: ['street'], control: 'stop' }]));
			const s = graph.segments.get(cut)!;
			const p = { x: cut === 'street' ? -60 + 120 * t : 0, y: cut === 'street' ? 0 : -16 + 32 * t };
			splitSegment(graph, s, t, graph.createNode(p.x, p.y).id);
			expect([cut, t, drawn(graph)]).toEqual([cut, t, ['stop', 'stop']]);
		}
});

// A street along y = 0 and a footpath bowed through (0, 60), storing
// `stored` (as data read from a save, any shape): it crosses the street near
// x -22 and x 22.
const bowed = (stored: unknown[]) =>
	buildModel({
		nodes: [node('w', -70, 0), node('e', 70, 0), node('p', -32, -20), node('q', 32, -20)],
		segments: [
			segment('street', 'w', 'e', preset('street')),
			{
				...segment('walk', 'p', 'q', preset('path')),
				controlX: 0,
				controlY: 60,
				controls: stored as CrossingControl[]
			}
		]
	}).scene;
// Each line drawn, by the side of the street's middle it stands and its kind.
const sides = (scene: Scene) =>
	controls(scene)
		.map((s) => `${mid(s as Sign & { a: Pt; b: Pt }).x < 0 ? 'west' : 'east'} ${s.kind}`)
		.sort();

test('a footpath crossing one street twice holds both crossings to the one control it stores', () => {
	const both = ['east stop', 'east stop', 'west stop', 'west stop'];
	expect(sides(bowed([{ roads: ['street'], control: 'stop' }]))).toEqual(both);
	expect(sides(bowed([{ roads: ['street'], lanes: ['l1', 'l2'], control: 'stop' }]))).toEqual(both);
	// Stored, as older saves stored them, with where along the footpath each
	// lay: both read the stronger, whatever the order.
	for (const at of [
		[0.16, 0.84],
		[0.84, 0.16]
	])
		expect(
			sides(
				bowed([
					{ roads: ['street'], at: at[0], control: 'stop' },
					{ roads: ['street'], at: at[1], control: 'none' }
				])
			)
		).toEqual(both);
});

// The owner's T: a street along y = 0 meeting at m a stem running south to
// y = 60, of a back lane, a 4 m walkway and a forward lane (`sidewalks`:
// with a sidewalk either side too), crossed by a footpath at `y` (its
// crossing of the carriageway coming in to m, its back lane l1, set to
// `control`); the stem's approach to m stops, the junction's default.
function tee(
	y: number,
	sidewalks: boolean,
	junction?: GraphData['nodes'][number]['junction'],
	control?: CrossingControl['control']
) {
	const s = preset('street');
	const stem = [s[1], { ...s[0], id: 'l4', width: 4 }, s[2]];
	return buildModel({
		nodes: [
			node('w', -40, 0),
			node('m', 0, 0, junction),
			node('e', 40, 0),
			node('s', 0, 60),
			node('p', -20, y),
			node('q', 20, y)
		],
		segments: [
			segment('west', 'w', 'm', preset('street')),
			segment('east', 'm', 'e', preset('street')),
			segment('stem', 'm', 's', sidewalks ? [s[0], ...stem, s[3]] : stem),
			{
				...segment('walk', 'p', 'q', preset('path')),
				...(control && { controls: [{ roads: ['stem'], lanes: ['l1'], control }] })
			}
		]
	}).scene;
}

// The stem's approach to m: its lines and arrows, each by how far down the
// stem it reaches, and the footpath's zebra across the stem.
function approach(scene: Scene) {
	const signs = piecesOf(scene).flatMap((d) =>
		d.signs.flatMap((s) => {
			if (s.kind === 'end') return [];
			const ref = s.kind === 'arrow' ? s.lane : s.lanes[0];
			if (ref.road !== 'stem' || ref.end !== 'start') return [];
			const ys = signShapes(s)
				.flat()
				.map((p) => p.y);
			return [{ kind: s.kind, near: Math.min(...ys), far: Math.max(...ys) }];
		})
	);
	const zebra = zebras(scene)
		.filter((c) => c.id.includes('~'))
		.flatMap((c) => c.runs.flatMap((r) => r.rings.flat().map((p) => p.y)));
	return { signs, zebra: Math.max(...zebra) };
}

test("a crossing near a T's junction is behind one line, the stronger control, the arrows behind it", () => {
	for (const sidewalks of [false, true])
		for (const y of [9, 10, 11, 12, 13, 14, 15, 16]) {
			const scene = tee(y, sidewalks);
			const { signs, zebra } = approach(scene);
			const lines = signs.filter((s) => s.kind !== 'arrow');
			const arrows = signs.filter((s) => s.kind === 'arrow');
			// The junction's stop, stronger than the crossing's give-way.
			expect([sidewalks, y, lines.map((s) => s.kind)]).toEqual([sidewalks, y, ['stop']]);
			expect(lines[0].near).toBeGreaterThan(zebra);
			expect([sidewalks, y, arrows.length > 0]).toEqual([sidewalks, y, true]);
			for (const a of arrows) expect(a.near).toBeGreaterThan(lines[0].far);
			expect([sidewalks, y, check(scene)]).toEqual([sidewalks, y, []]);
		}
	// The junction stopping no one there: the crossing's give-way; the
	// crossing set to stop where the junction gives way: a stop.
	const lineOf = (scene: Scene) =>
		approach(scene)
			.signs.filter((s) => s.kind !== 'arrow')
			.map((s) => s.kind);
	const none = approach(tee(11, false, { control: { 'stem:start': 'none' } }));
	const yields = none.signs.filter((s) => s.kind !== 'arrow');
	expect(yields.map((s) => s.kind)).toEqual(['yield']);
	expect(yields[0].near).toBeGreaterThan(none.zebra);
	expect(lineOf(tee(11, false, { control: { 'stem:start': 'yield' } }, 'stop'))).toEqual(['stop']);
});

// A street along y = 0 from (-35, 0) to (35, 0), of `lanes` (each lane
// named by its id, its offset right of the line the y it lies at), and a
// footpath from (0, y0) to (0, y1) storing `controls`.
const lane = (id: string, role: Lane['role'], width: number, direction: Lane['direction']) => ({
	id,
	role,
	width,
	direction,
	material:
		role === 'vehicle'
			? ('asphalt' as const)
			: role === 'buffer'
				? ('grass' as const)
				: ('concrete' as const)
});
const sidewalk = (id: string) => lane(id, 'pedestrian', 2, 'bidirectional');
// Sidewalk, back lane (y -5.5 to -2), a 4 m walkway, forward lane (2 to
// 5.5), sidewalk.
const divided = [
	sidewalk('left'),
	lane('back', 'vehicle', 3.5, 'backward'),
	lane('middle', 'pedestrian', 4, 'bidirectional'),
	lane('forward', 'vehicle', 3.5, 'forward'),
	sidewalk('right')
];
const crossedBy = (lanes: Lane[], y0: number, y1: number, controls?: CrossingControl[]) =>
	buildModel({
		nodes: [node('a', -35, 0), node('b', 35, 0), node('c', 0, y0), node('d', 0, y1)],
		segments: [
			segment('r', 'a', 'b', lanes),
			{ ...segment('w', 'c', 'd', [sidewalk('path')]), ...(controls && { controls }) }
		]
	}).scene;
// Each line drawn, by its kind and the lanes it stands across.
const linesOn = (scene: Scene) =>
	controls(scene)
		.map((s) => `${s.kind} ${'lanes' in s ? s.lanes.map((l) => l.lane).join() : ''}`)
		.sort();

test('a control names its carriageway: each carriageway is held by its own crossing alone', () => {
	// Set on the back carriageway, wherever the footpath lies across the
	// street.
	for (const [y0, y1] of [
		[-20, 24],
		[-14, 30]
	]) {
		const scene = crossedBy(divided, y0, y1, [{ roads: ['r'], lanes: ['back'], control: 'stop' }]);
		expect([y0, linesOn(scene)]).toEqual([y0, ['stop back', 'yield forward']]);
	}
	// One on each: each reads its own.
	const both = crossedBy(divided, -20, 24, [
		{ roads: ['r'], lanes: ['forward'], control: 'none' },
		{ roads: ['r'], lanes: ['back'], control: 'signal' }
	]);
	expect(linesOn(both)).toEqual(['stop back']);
	expect(check(both)).toEqual([]);
	// Stored without lane ids, as cities saved before carriageways were
	// told apart store it: every carriageway of the road.
	const old = crossedBy(divided, -20, 24, [
		{ roads: ['r'], at: 0.5, control: 'stop' } as CrossingControl
	]);
	expect(linesOn(old)).toEqual(['stop back', 'stop forward']);
});

test('two carriageways running the same way each have their own line on their own lanes', () => {
	// Both car lanes forward, a walkway between: the footpath right across
	// crosses each carriageway on its own.
	const same = [
		sidewalk('left'),
		lane('near', 'vehicle', 3.5, 'forward'),
		lane('middle', 'pedestrian', 4, 'bidirectional'),
		lane('forward', 'vehicle', 3.5, 'forward'),
		sidewalk('right')
	];
	const lines = (near: CrossingControl['control'], far: CrossingControl['control']) => {
		const scene = crossedBy(same, -20, 24, [
			{ roads: ['r'], lanes: ['near'], control: near },
			{ roads: ['r'], lanes: ['forward'], control: far }
		]);
		expect(check(scene)).toEqual([]);
		return linesOn(scene);
	};
	expect(lines('yield', 'yield')).toEqual(['yield forward', 'yield near']);
	expect(lines('none', 'stop')).toEqual(['stop forward']);
	expect(lines('stop', 'none')).toEqual(['stop near']);
	expect(lines('signal', 'yield')).toEqual(['stop near', 'yield forward']);
});

test("a crossing over part of a street marks only its own carriageway's lanes", () => {
	// Both car lanes forward; the footpath ended on the walkway down the
	// middle crosses the forward lane right of it alone.
	const lanes = [
		sidewalk('left'),
		lane('near', 'vehicle', 3.5, 'forward'),
		lane('middle', 'pedestrian', 4, 'bidirectional'),
		lane('forward', 'vehicle', 3.5, 'forward'),
		sidewalk('right')
	];
	for (const control of ['yield', 'stop'] as const) {
		const scene = crossedBy(lanes, 0, 22, [{ roads: ['r'], lanes: ['forward'], control }]);
		expect(linesOn(scene)).toEqual([`${control} forward`]);
		expect(check(scene)).toEqual([]);
	}
});

test('a crossing paves all between the walkways it joins: zebra over the car lanes, refuge over the rest', () => {
	// A 2 m grass buffer (y -3 to -1, a median) between the back lane (-6.5
	// to -3) and the walkway down the middle (-1 to 3), its refuge drawn as
	// crossing paving.
	const lanes = [
		sidewalk('left'),
		lane('back', 'vehicle', 3.5, 'backward'),
		lane('grass', 'buffer', 2, 'bidirectional'),
		lane('middle', 'pedestrian', 4, 'bidirectional'),
		lane('forward', 'vehicle', 3.5, 'forward'),
		sidewalk('right')
	];
	for (const [y0, y1] of [
		[-20, 24],
		[-20, 1]
	]) {
		const scene = crossedBy(lanes, y0, y1);
		const runs = scene
			.road('r')!
			.crossings.filter((c) => c.id.includes('~'))
			.flatMap((c) => c.runs);
		const ground = (kind: string) =>
			union(runs.filter((r) => r.kind === kind).flatMap((r) => r.rings.map(toPath)));
		// Across the footpath's middle and near either edge, over the whole
		// buffer.
		for (const x of [-0.9, 0, 0.9])
			for (const y of [-2.95, -2, -1.05])
				expect([y0, x, y, inside(ground('paved'), { x, y })]).toEqual([y0, x, y, true]);
		expect(ground('zebra').length).toBeGreaterThan(0);
		expect(check(scene)).toEqual([]);
	}
});

// A two-lane street west to east through m, with sidewalks west of m and
// none east of it, so m is a node of two sides; a footpath off the north
// side, bent at a node inside the roadway, across to the south side, at its
// south curb `south` m east of m (west of it, negative) and its north end
// `north` m east of m: the slanted zebra's corner comes onto m's ground in
// one lane alone. `mirror` turns the footpath half round m, across the
// street with no sidewalks, its corner reaching m from there; `flip` draws
// both car segments the other way, m at the other end of each.
function twoSidedGraph(south: number, north: number, { mirror = false, flip = false } = {}) {
	const at = (id: string, x: number, y: number) => (mirror ? node(id, -x, -y) : node(id, x, y));
	const car = (id: string, a: string, b: string, lanes: Lane[]) =>
		flip ? segment(id, b, a, lanes) : segment(id, a, b, lanes);
	return {
		nodes: [
			node('w', -60, 0),
			node('m', 0, 0),
			node('e', 60, 0),
			at('a', north, -20),
			at('b', north, -4.5),
			at('c', (north + south) / 2 + 1, 1),
			at('d', south, 4.5),
			at('f', south + 10, 15)
		],
		segments: [
			car('west', 'w', 'm', preset('street')),
			car('east', 'm', 'e', preset('street').slice(1, 3)),
			segment('p1', 'a', 'b', preset('path')),
			segment('p2', 'b', 'c', preset('path')),
			segment('p3', 'c', 'd', preset('path')),
			segment('p4', 'd', 'f', preset('path'))
		]
	};
}
const twoSided = (...args: Parameters<typeof twoSidedGraph>) =>
	buildModel(twoSidedGraph(...args)).scene;

// How many give-way rows hold the traffic each way, westbound and eastbound.
const rowsEachWay = (scene: Scene) => {
	const rows = controls(scene).filter((s) => s.kind === 'yield');
	return [rows.filter((s) => s.toward.x > 0).length, rows.filter((s) => s.toward.x < 0).length];
};

test('a slanted crossing by a node of two sides marks each lane once, wherever its corner lies', () => {
	// The south end slid along the sidewalk across where the zebra's corner
	// comes onto and off m's ground, and the path turned through a range of
	// angles: one row each way, nothing between it and the zebra.
	const at = (south: number, north: number, opts?: Parameters<typeof twoSided>[2]) => {
		const scene = twoSided(south, north, opts);
		expect([south, north, opts, rowsEachWay(scene)]).toEqual([south, north, opts, [1, 1]]);
		expect([south, north, opts, check(scene)]).toEqual([south, north, opts, []]);
	};
	for (let south = -6; south <= 1; south += 0.5) at(south, -10);
	for (let north = -16; north <= -4; north += 1) at(-1, north);
	// The crossing reaching m from the street with no sidewalks, and m at
	// the other end of each road.
	for (const opts of [{ mirror: true }, { flip: true }, { mirror: true, flip: true }]) {
		for (let south = -6; south <= 1; south += 1) at(south, -10, opts);
		for (let north = -16; north <= -4; north += 2) at(-1, north, opts);
	}
	// One drawing kept from build to build, as the editor keeps it while
	// the south end is slid along the sidewalk and then the north end along
	// its own, draws at each step what a fresh build draws.
	const data = twoSidedGraph(-3, -10);
	data.nodes.find((n) => n.id === 'c')!.x = -4;
	const graph = liveShape(data);
	const kept = new Networks();
	// Every piece drawn, but the keys its caches go by.
	const json = (d: unknown) => JSON.stringify(d, (k, v) => (k === 'key' ? undefined : v));
	const piecesDrawn = (scene: Scene) => piecesOf(scene).map(json);
	const steps = [
		...[-2, -1.5, -4, -2.5, -1.7].map((x) => ['d', x] as const),
		...[-14, -12, -8, -6].map((x) => ['b', x] as const)
	];
	kept.build(graph as never);
	for (const [id, x] of steps) {
		graph.nodes.get(id)!.x = x;
		const scene = kept.build(graph as never).scene;
		const fresh = new Networks().build(graph as never).scene;
		expect([id, x, piecesDrawn(scene)]).toEqual([id, x, piecesDrawn(fresh)]);
		expect([id, x, rowsEachWay(scene), check(scene)]).toEqual([id, x, [1, 1], []]);
	}
});

// The editor's crossing badge without the browser: the crossing drawn over a
// point (Networks.crossingAt) and the control it reads, or stepped on to
// `control` and written as Editor.cycleCrossing writes it.
function drawn(graph: Graph) {
	const networks = new Networks();
	const { scene } = networks.build(graph);
	const badgeAt = (p: Pt) => {
		const id = networks.crossingAt(p);
		return id === null ? null : networks.crossingOf(id)!.control;
	};
	return { networks, scene, badgeAt };
}
function setBadge(graph: Graph, p: Pt, control: Control) {
	const { networks } = drawn(graph);
	const id = networks.crossingAt(p);
	if (id === null) throw new Error(`no crossing at ${p.x}, ${p.y}`);
	for (const [x, kept] of networks.crossingOf(id)!.storing(control))
		graph.segments.get(x)!.controls = kept;
}
// What the editor writes after each edit it saves
// (Editor.keepCrossingControls).
function settle(graph: Graph) {
	for (const [id, kept] of drawn(graph).networks.settle()) graph.segments.get(id)!.controls = kept;
}
const isCar = (s: { lanes: readonly Lane[] }) => s.lanes.some((l) => l.role === 'vehicle');
const carIds = (graph: Graph) => [...graph.segments.values()].filter(isCar).map((s) => s.id);
const graphOf = (data: GraphData) => {
	const graph = new Graph();
	graph.fromJSON(data);
	return graph;
};
// The lines drawn within 8 m of `x` along a street along y 0, each by its
// kind and the side of the street it stands on, sorted.
const sidesAt = (scene: Scene, x: number) =>
	controls(scene)
		.map((s) => ({ s, p: mid(s as Sign & { a: Pt; b: Pt }) }))
		.filter(({ p }) => Math.abs(p.x - x) < 8)
		.map(({ s, p }) => `${s.kind} ${p.y < 0 ? 'north' : 'south'}`)
		.sort();

// Two footpaths straight across `streets` at x -22 and x 22, the west one
// stopping the north carriageway and signalling the south one, the east one
// the other way round, each set through its badge.
const WEST = -22;
const EAST = 22;
const northOf = (x: number) => ({ x: x + 0.3, y: -3.75 });
const southOf = (x: number) => ({ x: x + 0.3, y: 3.75 });
const HELD = [
	[northOf(WEST), 'stop'],
	[southOf(WEST), 'signal'],
	[northOf(EAST), 'signal'],
	[southOf(EAST), 'stop']
] as const;
function heldAcross(nodes: GraphData['nodes'], streets: GraphData['segments']) {
	const graph = graphOf({
		nodes: [
			...nodes,
			node('p', WEST, -20),
			node('q', WEST, 24),
			node('r', EAST, -20),
			node('s', EAST, 24)
		],
		segments: [
			...streets,
			segment('w1', 'p', 'q', [sidewalk('path')]),
			segment('w2', 'r', 's', [sidewalk('path')])
		]
	});
	for (const [p, control] of HELD) setBadge(graph, p, control);
	expectHeld(graph, 'set');
	return graph;
}
// Each crossing's badge as set and a stop line each way across its own
// carriageway, and every entry naming segments of the graph and car lanes
// of the roads it names.
function expectHeld(graph: Graph, label: string) {
	const { scene, badgeAt } = drawn(graph);
	expect([label, HELD.map(([p]) => badgeAt(p))]).toEqual([label, HELD.map(([, c]) => c)]);
	for (const x of [WEST, EAST])
		expect([label, x, sidesAt(scene, x)]).toEqual([label, x, ['stop north', 'stop south']]);
	expect([label, check(scene)]).toEqual([label, []]);
	for (const s of graph.segments.values())
		for (const e of s.controls ?? []) {
			const named = e.roads.map((r) => graph.segments.get(r));
			const cars = named.flatMap((r) => r?.lanes.filter((l) => l.role === 'vehicle') ?? []);
			expect([
				label,
				s.id,
				named.every(Boolean),
				e.lanes?.every((l) => cars.some((c) => c.id === l))
			]).toEqual([label, s.id, true, true]);
		}
}
const STREET_ENDS = [node('a', -40, 0), node('b', 40, 0)];
const WAYS = [
	['west to east', 'a', 'b'],
	['east to west', 'b', 'a']
] as const;

test("a control stays on its carriageway through a cut, a join and a draw's cut, either road, the street drawn either way", () => {
	for (const [way, from, to] of WAYS) {
		// The street cut between the footpaths.
		const cut = heldAcross(STREET_ENDS, [segment('street', from, to, divided)]);
		splitSegment(cut, cut.segments.get('street')!, 0.5, cut.createNode(0, 0).id);
		settle(cut);
		expect(carIds(cut)).toHaveLength(2);
		expectHeld(cut, `cut, ${way}`);
		// A street drawn from the north and ended on its line, which cuts it
		// there (anchorIn in modes/draw.ts), resolved as a draw is.
		const drawnOn = heldAcross(STREET_ENDS, [segment('street', from, to, divided)]);
		const end = drawnOn.createNode(0, 0);
		splitSegment(drawnOn, drawnOn.segments.get('street')!, 0.5, end.id);
		const start = drawnOn.createNode(0, -30);
		resolveCrossings(drawnOn, [drawnOn.createSegment(start.id, end.id, preset('street')).id]);
		settle(drawnOn);
		expect(carIds(drawnOn)).toHaveLength(3);
		expectHeld(drawnOn, `draw's cut, ${way}`);
	}
	// Two streets meeting at x 0 joined into one: the east one drawn on from
	// the node with lane ids of its own, or drawn toward the node with the
	// west one's lane ids, which there lie on the other side of the street.
	const renamed = divided.map((l) => ({ ...l, id: `e-${l.id}` }));
	for (const [name, east] of [
		['the east street drawn on, its lanes named otherwise', segment('east', 'j', 'b', renamed)],
		['the east street drawn toward the node', segment('east', 'b', 'j', divided)]
	] as const) {
		const graph = heldAcross(
			[...STREET_ENDS, node('j', 0, 0)],
			[segment('west', 'a', 'j', divided), east]
		);
		const merged = join(graph, joinPlan(graph, 'j')!);
		settle(graph);
		expect(carIds(graph)).toEqual([merged.id]);
		expectHeld(graph, `join, ${name}`);
	}

	// The west footpath cut on the walkway down the middle: each piece
	// crosses one carriageway and stores that one's control alone; joined
	// again, it stores both.
	const graph = heldAcross(STREET_ENDS, [segment('street', 'a', 'b', divided)]);
	const kept: CrossingControl[] = [
		{ roads: ['street'], lanes: ['back'], control: 'stop' },
		{ roads: ['street'], lanes: ['forward'], control: 'signal' }
	];
	expect(graph.segments.get('w1')!.controls).toEqual(kept);
	const onWalkway = graph.createNode(WEST, 0);
	const halves = splitSegment(graph, graph.segments.get('w1')!, 20 / 44, onWalkway.id)!;
	settle(graph);
	expect([halves.left.controls, halves.right.controls]).toEqual([[kept[0]], [kept[1]]]);
	expectHeld(graph, 'footpath cut on the walkway');
	const rejoined = join(graph, joinPlan(graph, onWalkway.id)!);
	settle(graph);
	expect(rejoined.controls).toEqual(kept);
	expectHeld(graph, 'footpath joined');
	// Cut north of the street: the piece north of the cut crosses nothing
	// and stores nothing, the piece across holds both.
	const north = splitSegment(graph, rejoined, 8 / 44, graph.createNode(WEST, -12).id)!;
	settle(graph);
	expect([north.left.controls, north.right.controls]).toEqual([undefined, kept]);
	expectHeld(graph, 'footpath cut north of the street');

	// The east footpath moved off past the street's end: no crossing of it
	// is left to hold its entries, which go, and moved back across it gives
	// way, the west one's untouched.
	const moved = heldAcross(STREET_ENDS, [segment('street', 'a', 'b', divided)]);
	const ends = ['r', 's'].map((id) => moved.nodes.get(id)!);
	for (const n of ends) n.x = 60;
	settle(moved);
	expect(moved.segments.get('w2')!.controls).toBeUndefined();
	for (const n of ends) n.x = EAST;
	settle(moved);
	const back = drawn(moved);
	expect([northOf(EAST), southOf(EAST)].map(back.badgeAt)).toEqual(['yield', 'yield']);
	expect([northOf(WEST), southOf(WEST)].map(back.badgeAt)).toEqual(['stop', 'signal']);
	expect(moved.segments.get('w2')!.controls).toBeUndefined();
});

test('lanes pasted carry each control to the carriageway counted the same from the edge, the street drawn either way', () => {
	// Another divided street's lanes: the same carriageways, its south lane
	// 4 m wide, its lanes named the other way round, so the id the north lane
	// had names the south one.
	const pasted = [
		sidewalk('s-left'),
		lane('forward', 'vehicle', 3.5, 'backward'),
		lane('s-middle', 'pedestrian', 4, 'bidirectional'),
		lane('back', 'vehicle', 4, 'forward'),
		sidewalk('s-right')
	];
	for (const [way, from, to] of WAYS) {
		const graph = heldAcross(STREET_ENDS, [segment('street', from, to, divided)]);
		const street = graph.segments.get('street')!;
		graph.setLanes([[street, pasted.map((l) => ({ ...l }))]], true);
		settle(graph);
		expect(street.lanes.map((l) => l.width)).toEqual([2, 3.5, 4, 4, 2]);
		expectHeld(graph, `pasted, ${way}`);
	}
});

test('a lane edit keeps each control on the car lanes it names', () => {
	// A street along y 0 and a footpath straight across it at x 0, its
	// crossings set at `set` (a badge just east of the footpath, by y), its
	// lanes then given `edit`'s; each badge then read at `read`.
	const left = sidewalk('left');
	const right = sidewalk('right');
	const back = lane('back', 'vehicle', 3.5, 'backward');
	const fwd = lane('fwd', 'vehicle', 3.5, 'forward');
	const middle = (width: number) => lane('middle', 'pedestrian', width, 'bidirectional');
	const near = lane('near', 'vehicle', 3.5, 'forward');
	const far = lane('far', 'vehicle', 3.5, 'forward');
	const cases: [string, Lane[], [number, Control][], Lane[], [number, Control][]][] = [
		// The carriageways then lie at y -9.5 to -6 and 6 to 9.5.
		[
			'the walkway down the middle widened from 4 m to 12 m',
			[left, back, middle(4), fwd, right],
			[
				[-3.75, 'stop'],
				[3.75, 'signal']
			],
			[left, back, middle(12), fwd, right],
			[
				[-7.75, 'stop'],
				[7.75, 'signal']
			]
		],
		[
			'the walkway down the middle retyped as a buffer',
			[left, back, middle(4), fwd, right],
			[[3.75, 'signal']],
			[left, back, lane('middle', 'buffer', 4, 'bidirectional'), fwd, right],
			[
				[3.75, 'signal'],
				[-3.75, 'signal']
			]
		],
		// A 7 m north lane (y -5.75 to 1.25), a 1 m walkway and the south lane
		// (2.25 to 5.75), wider than the south's place across the road once the
		// north lane is gone; the south lane then lies at y -1.25 to 2.25.
		[
			'the north lane removed',
			[left, { ...back, width: 7 }, middle(1), fwd, right],
			[
				[-2.25, 'stop'],
				[4, 'signal']
			],
			[left, middle(1), fwd, right],
			[[0.5, 'signal']]
		],
		// The same, the control the lane removed held the stronger: never
		// handed to the lane left.
		[
			'the north lane removed, its signal the stronger',
			[left, { ...back, width: 7 }, middle(1), fwd, right],
			[
				[-2.25, 'signal'],
				[4, 'stop']
			],
			[left, middle(1), fwd, right],
			[[0.5, 'stop']]
		],
		// One carriageway, y -3.5 to 3.5: the stronger.
		[
			'the walkway down the middle removed',
			[left, back, middle(4), fwd, right],
			[
				[-3.75, 'stop'],
				[3.75, 'signal']
			],
			[left, back, fwd, right],
			[
				[-1.75, 'signal'],
				[1.75, 'signal']
			]
		],
		// Two carriageways, y -5.25 to -1.75 and 1.75 to 5.25.
		[
			'a car lane in the middle retyped as a walkway',
			[left, back, lane('mid', 'vehicle', 3.5, 'forward'), fwd, right],
			[[0, 'stop']],
			[left, back, lane('mid', 'pedestrian', 3.5, 'forward'), fwd, right],
			[
				[-3.5, 'stop'],
				[3.5, 'stop']
			]
		],
		// Both running the same way; the far lane widened to 4 m and the near
		// lane copied (the copy taking no id of the one it copied): 19 m
		// across, the near lanes from y -7.5 to -0.5, the far lane 3.5 to 7.5.
		[
			'the far lane widened and the near lane copied',
			[left, near, middle(4), far, right],
			[
				[-3.75, 'stop'],
				[3.75, 'signal']
			],
			[left, near, { ...near, id: undefined }, middle(4), { ...far, width: 4 }, right],
			[
				[-5.75, 'stop'],
				[-2.25, 'stop'],
				[5.5, 'signal']
			]
		]
	];
	for (const [name, lanes, set, edit, read] of cases) {
		const graph = graphOf({
			nodes: [node('a', -40, 0), node('b', 40, 0), node('p', 0, -22), node('q', 0, 22)],
			segments: [segment('r', 'a', 'b', lanes), segment('w', 'p', 'q', [sidewalk('path')])]
		});
		for (const [y, control] of set) setBadge(graph, { x: 0.3, y }, control);
		graph.setLanes([[graph.segments.get('r')!, edit.map((l) => ({ ...l }))]]);
		settle(graph);
		const { scene, badgeAt } = drawn(graph);
		expect([name, read.map(([y]) => badgeAt({ x: 0.3, y }))]).toEqual([
			name,
			read.map(([, c]) => c)
		]);
		expect([name, check(scene)]).toEqual([name, []]);
		const r = graph.segments.get('r')!;
		const stored = graph.segments.get('w')!.controls ?? [];
		// Every entry names car lanes the street holds now.
		for (const e of stored)
			expect([
				name,
				e.lanes?.every((l) => r.lanes.some((x) => x.id === l && x.role === 'vehicle'))
			]).toEqual([name, true]);
		if (name.startsWith('the north lane removed'))
			expect([name, stored.map((e) => e.control)]).toEqual([name, [read[0][1]]]);
		if (name === 'the far lane widened and the near lane copied') {
			const nearIds = r.lanes.slice(1, 3).map((l) => l.id!);
			expect(nearIds[0]).toBe('near');
			expect(stored).toEqual([
				{ roads: ['r'], lanes: ['far'], control: 'signal' },
				{ roads: ['r'], lanes: nearIds, control: 'stop' }
			]);
			expect(linesOn(scene)).toEqual(['stop far', `stop ${nearIds.join()}`]);
		}
	}
});

test('a crossing of one carriageway near a T holds that carriageway alone', () => {
	// A T: a street along y 0, and a stem from it south to y 60 whose two car
	// lanes, either side of a 4 m walkway down its middle, both run toward
	// the T, which holds the stem's traffic to nothing. A footpath from the
	// east across the stem's east carriageway 12 m from the T, ended on the
	// walkway, set to stop.
	const street = [
		sidewalk('left'),
		lane('back', 'vehicle', 3.5, 'backward'),
		lane('fwd', 'vehicle', 3.5, 'forward'),
		sidewalk('right')
	];
	const stem = [
		sidewalk('left'),
		lane('near', 'vehicle', 3.5, 'backward'),
		lane('middle', 'pedestrian', 4, 'bidirectional'),
		lane('far', 'vehicle', 3.5, 'backward'),
		sidewalk('right')
	];
	const graph = graphOf({
		nodes: [
			node('j', 0, 0, { control: { 'stem:start': 'none' } }),
			node('a', -40, 0),
			node('b', 40, 0),
			node('c', 0, 60),
			node('p', 20, 12),
			node('q', 0, 12)
		],
		segments: [
			segment('west', 'a', 'j', street),
			segment('east', 'j', 'b', street),
			segment('stem', 'j', 'c', stem),
			segment('w', 'p', 'q', [sidewalk('path')])
		]
	});
	setBadge(graph, { x: 3.75, y: 12.3 }, 'stop');
	const { scene } = drawn(graph);
	// One stop line, across the east carriageway's lane alone.
	const stemLines = piecesOf(scene).flatMap((d) =>
		d.signs.flatMap((s) =>
			(s.kind === 'stop' || s.kind === 'yield') && s.lanes.some((l) => l.road === 'stem')
				? [`${s.kind} ${s.lanes.map((l) => l.lane).join(' ')}`]
				: []
		)
	);
	expect(stemLines).toEqual(['stop near']);
	expect(check(scene)).toEqual([]);
});

// A footpath through a junction makes no crossing there (onJunction in
// core/networks.ts), so it shows no button and reads none of what it
// stores: a four-way of Streets with a Path through its middle storing a
// stop for an arm and a signal by the junction's node (as a city saved with
// crossings over junctions held them), beside a Path across that arm well
// clear of the junction storing a stop. Selecting the arm shows the clear
// Path's button alone, with its stop; selecting the Path through shows none,
// and the car roads are drawn as with that Path not there. The next edit
// saved writes each footpath's entries as its crossings stand: the clear
// Path keeps its stop, and the Path through keeps nothing.
test('a footpath through a junction shows no button and keeps no control it stored there', () => {
	const city = cityOf(
		{
			j: [0, 0],
			e: [60, 0],
			n: [0, -60],
			w: [-60, 0],
			s: [0, 60],
			a: [-30, -30],
			b: [30, 30],
			c: [35, -25],
			d: [35, 25]
		},
		[
			{ id: 'east', from: 'j', to: 'e', lanes: 'street' },
			{ id: 'north', from: 'j', to: 'n', lanes: 'street' },
			{ id: 'west', from: 'j', to: 'w', lanes: 'street' },
			{ id: 'south', from: 'j', to: 's', lanes: 'street' },
			{ id: 'through', from: 'a', to: 'b', lanes: 'path' },
			{ id: 'clear', from: 'c', to: 'd', lanes: 'path' }
		]
	);
	const stored: Record<string, CrossingControl[]> = {
		through: [
			{ roads: ['east'], control: 'stop' },
			{ roads: [], nodes: ['j'], control: 'signal' } as CrossingControl
		],
		clear: [{ roads: ['east'], control: 'stop' }]
	};
	for (const s of city.segments) if (stored[s.id]) s.controls = stored[s.id];
	const ui = openEditor(structuredClone(city), 0.05);
	ui.editor.selectSegment('east');
	frame();
	expect(ui.editor.crossingBadges.map((b) => b.control)).toEqual(['stop']);
	ui.editor.clearSelection();
	ui.editor.selectSegment('through');
	frame();
	expect(ui.editor.crossingBadges).toEqual([]);
	const without = { ...city, segments: city.segments.filter((s) => s.id !== 'through') };
	expect(carDrawn(buildModel(city).scene)).toEqual(carDrawn(buildModel(without).scene));
	ui.key('Escape');
	ui.draw('Street', [
		{ x: 200, y: 200 },
		{ x: 260, y: 200 }
	]);
	const saved = ui.saved().segments;
	expect(saved.find((s) => s.id === 'clear')?.controls).toEqual([
		{ roads: ['east'], lanes: expect.any(Array), control: 'stop' }
	]);
	expect(saved.find((s) => s.id === 'through')?.controls).toBeUndefined();
});
