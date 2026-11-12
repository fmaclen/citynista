import { expect, test } from '@playwright/test';
import { PlaceBuilder } from '../src/lib/core/place';
import { createLanesFrom } from '../src/lib/core/lane-template';
import type { JunctionData, Lane } from '../src/lib/core/types';
import { area, inside, intersect, toPath, type Paths } from '../src/lib/lab/clip';
import { check } from '../src/lib/lab/checks';
import type { JunctionDraw } from '../src/lib/lab/junction';
import { roundabout } from '../src/lib/lab/places/roundabout';
import { Scene } from '../src/lib/lab/scene';
import { crossSection, frameAt, offsetPoint } from '../src/lib/lab/geometry';
import { connectionCurve, endsOf, laneEndOf, outlineOf } from '../src/lib/lab/junction';
import { band } from '../src/lib/lab/link';
import type { Pt } from '../src/lib/lab/model';
import { serializeLanes } from '../src/lib/core/lane-template';
import { readScene } from './scenes';

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

function graphOf(nodes: Record<string, [number, number, JunctionData?]>, segs: Seg[]) {
	const nodeMap = new Map(
		Object.entries(nodes).map(([id, [x, y, junction]]) => [
			id,
			{ id, x, y, junction, connectedSegments: [] as string[] }
		])
	);
	const segments = new Map(
		segs.map((s) => {
			s.lanes.forEach((l, i) => (l.id ??= `l${i}`));
			return [
				s.id,
				{
					id: s.id,
					startNodeId: s.from,
					endNodeId: s.to,
					controlX: s.control?.[0],
					controlY: s.control?.[1],
					hasControlPoint: !!s.control,
					offsetStart: s.offsetStart ?? s.offset ?? 0,
					offsetEnd: s.offsetEnd ?? s.offset ?? 0,
					lanes: s.lanes,
					lanesKey: serializeLanes(s.lanes),
					totalWidth: s.lanes.reduce((a, l) => a + l.width, 0)
				}
			];
		})
	);
	for (const s of segments.values()) {
		nodeMap.get(s.startNodeId)!.connectedSegments.push(s.id);
		nodeMap.get(s.endNodeId)!.connectedSegments.push(s.id);
	}
	return { nodes: nodeMap, segments };
}

// A graph from e2e/scenes/, read the same way.
function sceneGraph(name: string) {
	const { nodes, segments } = readScene(name) as {
		nodes: { id: string; x: number; y: number; junction?: JunctionData }[];
		segments: (Omit<Seg, 'from' | 'to' | 'control'> & {
			startNodeId: string;
			endNodeId: string;
			controlX?: number;
			controlY?: number;
		})[];
	};
	return graphOf(
		Object.fromEntries(nodes.map((n) => [n.id, [n.x, n.y, n.junction]])),
		segments.map((s) => ({
			id: s.id,
			from: s.startNodeId,
			to: s.endNodeId,
			lanes: s.lanes,
			offsetStart: s.offsetStart,
			offsetEnd: s.offsetEnd,
			control: s.controlX !== undefined ? [s.controlX, s.controlY!] : undefined
		}))
	);
}

function build(graph: ReturnType<typeof graphOf>) {
	const derived = new PlaceBuilder().build(graph as never);
	const scene = new Scene(derived.place);
	scene.build();
	return { derived, scene };
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

test('two Avenues crossing are signalled; an Avenue crossing a Street gives way to nobody', () => {
	const big = build(crossroads(avenue, avenue)).derived.junctions.get('c')!;
	expect(Object.values(big.control)).toEqual(['signal', 'signal', 'signal', 'signal']);

	const mixed = build(crossroads(avenue, street)).derived.junctions.get('c')!;
	expect(mixed.control['west:end']).toBe('none');
	expect(mixed.control['east:start']).toBe('none');
	expect(mixed.control['north:end']).toBe('stop');
	expect(mixed.control['south:start']).toBe('stop');
});

test('a controlled junction has a crossing on every arm; one switched off is gone', () => {
	const on = build(crossroads(avenue, avenue));
	const crossed = (d: typeof on) =>
		d.derived.place.roads.filter((r) => (r.crossings ?? []).length > 0).map((r) => r.id);
	expect(crossed(on).sort()).toEqual(['east', 'north', 'south', 'west']);

	const off = build(
		crossroads(avenue, avenue, {
			connections: [],
			crossings: [{ road: 'north', end: 'end', lanes: ['l0', 'l8'], on: false }]
		})
	);
	expect(crossed(off).sort()).toEqual(['east', 'south', 'west']);
});

test('a crossing moved past the far end of its road stops short of it', () => {
	const { derived } = build(
		crossroads(avenue, avenue, {
			connections: [],
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
	const west = graph.segments.get('west')!;
	const lanes = avenue();
	lanes.splice(7, 0, {
		role: 'vehicle',
		material: 'asphalt',
		width: 3.5,
		direction: 'forward',
		id: 'l9'
	});
	west.lanes = lanes;
	west.lanesKey = serializeLanes(lanes);
	west.totalWidth += 3.5;
	// Slid half a lane toward its kerb, as a pocket is, so its through lanes
	// line up with the road beyond.
	west.offsetStart = 1.75;
	west.offsetEnd = 1.75;
	return graph;
}

test('a lane added on the kerb side turns right only; the lanes beside it go straight', () => {
	const j = build(rightTurnLane()).derived.junctions.get('c')!;
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
	const { scene } = build(rightTurnLane());
	// The west approach's arrows (straight-and-left, straight, right only);
	// its stop bar is the only other paint there, four corners.
	const arrows = scene
		.junctionDraw('c')!
		.white.filter((p) => p.length > 4 && p.every((q) => q.x < -15));
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
					connections: [],
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
	const { scene } = build(graph);
	const draw = scene.junctionDraw('m')!;
	// The eastbound kerb sits 8 m south of the line (y = 7.8 inside it); the
	// node's paint keeps a solid white line along it the whole way across.
	const kerb = draw.marks.filter(
		(m) => !m.dashed && m.colour === 'white' && m.pts.every((p) => Math.abs(p.y - 7.8) < 0.2)
	);
	expect(kerb.length).toBe(1);
	const xs = kerb[0].pts.map((p) => p.x);
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
			m: [0, 0, { connections: [], sides: { ramp: 'left' } }],
			s: [0, 200],
			r: [-60, -150]
		},
		[
			{ id: 'north', from: 'n', to: 'm', lanes: createLanesFrom('highway') },
			{ id: 'south', from: 'm', to: 's', lanes: accel, offset: 1.75 },
			{ id: 'ramp', from: 'r', to: 'm', lanes: oneLane('forward') }
		]
	);
	const j = build(graph).derived.junctions.get('m')!;
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
			m: [0, 0, { connections: [], sides: { westbound: 'left', eastbound: 'right' } }],
			a: [200, -12],
			b: [200, 12]
		},
		[
			{ id: 'avenue', from: 'w', to: 'm', lanes: avenueLanes },
			{ id: 'westbound', from: 'm', to: 'a', lanes: half('backward') },
			{ id: 'eastbound', from: 'm', to: 'b', lanes: half('forward') }
		]
	);
	const j = build(graph).derived.junctions.get('m')!;
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
	const { scene } = build(graph);
	const joined = scene.effective.find((j) => j.id.includes('+'));
	expect(joined?.id.split('+').sort()).toEqual(['p', 'q']);
	const walks = joined!.connections
		.filter((c) => /^l0$|^l3$/.test(c.from.lane) && c.from.road !== c.to.road)
		.map((c) => [c.from.road, c.to.road].sort().join('-'));
	expect(walks).toEqual(['north-south', 'north-south']);
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
function paintedAcrossMouth(draw: JunctionDraw, key: string) {
	const mouth = draw.mouths.find((m) => m.key === key)!;
	const into = mouth.pts.map((p) => ({ x: p.x - mouth.out.x, y: p.y - mouth.out.y }));
	const strip = [toPath([...mouth.pts, ...into.reverse()])];
	return draw.marks.some((m) => m.pts.some((p) => inside(strip, p)));
}

test('two legs attached at the edges of one road merge into it with no lines crossing', () => {
	// A two-way stem going south from the node; a one-way leg attached at
	// each of its edges, curving apart to the north; a footpath off east.
	const graph = graphOf(
		{
			s: [0, 100],
			m: [0, 0, { connections: [], sides: { west: 'left', east: 'right' } }],
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
	const { scene } = build(graph);
	expect(check(scene)).toEqual([]);
	// Each leg's lane line runs on into the stem.
	expect(scene.junctionDraw('m')!.marks.filter((m) => m.dashed).length).toBe(2);
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
			{ connections: [], control: { [`ring${prev}:end`]: 'none', [`arm${i}:start`]: 'yield' } }
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
	const { scene } = build(ring());
	for (let i = 0; i < 4; i++) {
		const draw = scene.junctionDraw(`r${i}`)!;
		// The dashes between the ring's two lanes, and its inner edge line
		// (yellow, on the driver's left of a one-way road).
		expect(draw.marks.filter((m) => m.dashed).length).toBe(1);
		expect(draw.marks.filter((m) => !m.dashed && m.colour === 'yellow').length).toBe(1);
		// The outer edge stops at the arm's mouth: the arm's paths and its
		// mouth lie beyond it there.
		expect(paintedAcrossMouth(draw, `arm${i}:start`)).toBe(false);
	}
	expect(check(scene)).toEqual([]);
});

test('the roundabout place keeps its ring lines through every entry', () => {
	const scene = new Scene(roundabout());
	scene.build();
	for (const id of ['e', 'n', 'w', 's']) {
		const j = scene.effective.find((x) => x.id === `entry-${id}`)!;
		const arm = `arm-${id}:start`;
		expect(j.control[arm]).toBe('yield');
		const draw = scene.junctionDraw(j.id)!;
		expect(draw.marks.filter((m) => m.dashed).length).toBe(1);
		expect(draw.marks.filter((m) => !m.dashed && m.colour === 'yellow').length).toBe(1);
		// The outer edge runs where nothing lies beyond it, and stops at the
		// arm's mouth.
		expect(draw.marks.some((m) => !m.dashed && m.colour === 'white')).toBe(true);
		expect(paintedAcrossMouth(draw, arm)).toBe(false);
	}
});

// What a junction draws on top at a point, as the renderer stacks its
// layers: concrete, grass, dirt, then the paving (in the junction's
// material) and asphalt, then sidewalk; null where it leaves the ground.
function surfaceAt(scene: Scene, id: string, p: Pt) {
	const draw = scene.junctionDraw(id)!;
	const lanes = (surface: string) =>
		(draw.lanes ?? []).filter((l) => l.surface === surface).flatMap((l) => l.paths);
	const carried = (surface: string) =>
		draw.carried.filter((c) => c.surface === surface).flatMap((c) => c.paths);
	const layers: [string, Paths][] = [
		['concrete', [...carried('concrete'), ...lanes('concrete')]],
		['grass', [...carried('grass'), ...draw.verges, ...lanes('grass')]],
		['dirt', [...carried('dirt'), ...lanes('dirt')]],
		[scene.junctionPaving(id), draw.asphalt],
		['asphalt', [...carried('hatch'), ...lanes('asphalt')]],
		['pavement', [...draw.pavement, ...lanes('pavement')]]
	];
	for (const island of draw.islands) if (inside([island.path], p)) return island.surface;
	return layers.find(([, paths]) => inside(paths, p))?.[0] ?? null;
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
	// One asphalt lane and one concrete lane, cut in two where the road bends.
	const { scene } = build(
		graphOf({ a: [-60, -60], m: [0, 0], b: [80, 0] }, [
			{ id: 'one', from: 'a', to: 'm', lanes: mixed() },
			{ id: 'two', from: 'm', to: 'b', lanes: mixed(), control: [40, 40] }
		])
	);
	// All the way across the node, each lane is drawn in its own material.
	for (const [lane, surface] of [
		[0, 'asphalt'],
		[1, 'pavement']
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
	const { scene } = build(
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
	const { scene } = build(sceneGraph('off-ramp'));
	const j = scene.effective.find((x) => x.id === 'm')!;
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

test('between a freeway and the off-ramp leaving it, where no lane runs, is ground', () => {
	const { scene, through, ramp } = offRamp();
	// Halfway between the edges of the lane carrying on and the ramp's lane,
	// wherever they have parted.
	const between = through.right.flatMap((p) => {
		const q = ramp.left.reduce((a, b) => (distance(p, b) < distance(p, a) ? b : a));
		return distance(p, q) > 1.5 ? [{ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }] : [];
	});
	expect(between.length).toBeGreaterThan(5);
	for (const p of between) expect(surfaceAt(scene, 'm', p), `at ${p.x}, ${p.y}`).toBeNull();
});

test("a freeway's edge line runs along its lane to where an off-ramp parts", () => {
	const { scene, through } = offRamp();
	// All along the right edge of the lane carrying on, a line beside it: the
	// lane line while the ramp's lane is beside it, then its edge line.
	const lines = scene.junctionDraw('m')!.marks.filter((m) => m.colour === 'white');
	const near = (p: Pt) =>
		Math.min(
			...lines.flatMap((m) =>
				m.pts.slice(1).map((b, i) => {
					const a = m.pts[i];
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
	const { scene } = build(sceneGraph('busway-crossing'));
	const draw = scene.junctionDraw('c')!;
	const zebra = draw.crossings.filter((c) => c.on).flatMap((c) => c.zebra);
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
		const side = graph.segments.get('side')!;
		side.lanes = lanes;
		side.lanesKey = serializeLanes(lanes);
		side.totalWidth = lanes.reduce((a, l) => a + l.width, 0);
	}
	const { scene } = build(graph);
	const j = scene.effective.find((x) => x.id === 'c')!;
	const ends = endsOf(j, scene.geos);
	const side = ends.find((e) => e.ref.road === 'side')!;
	const draw = scene.junctionDraw('c')!;
	// A point in the side road's frame at its end: metres along it away from
	// the avenue, and across it to the right.
	const at = (along: number, across: number) =>
		offsetPoint(offsetPoint(side.frame.p, side.frame.out, along), side.frame.n, across);
	return { scene, j, ends, side, draw, at };
}

test('a divided side road is crossed by a crosswalk, not paved over as a driveway', () => {
	const { j, draw, at } = curvedTee();
	expect(j.control['side:start']).toBe('stop');
	const across = j.walkways.find((w) => w.id === 'north:start~south:end')!;
	expect(across.paved).toBe(false);
	// Zebra stripes over both its lanes (3.5 m either side of a 2 m median),
	// within the first 3 m of each.
	const zebra = draw.crossings.filter((c) => c.on).flatMap((c) => c.zebra);
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

test('two lanes with no median and no sidewalks are a driveway: the sidewalk is paved across', () => {
	const { j, draw } = curvedTee([
		{ ...drive('backward'), id: 'l0' },
		{ ...drive('forward'), id: 'l1' }
	]);
	const across = j.walkways.find((w) => w.id === 'north:start~south:end')!;
	expect(across.paved).toBe(true);
	expect(draw.crossings.flatMap((c) => c.zebra)).toEqual([]);
});

test("the corners either side of a side road's mouth round, with the sidewalk round them", () => {
	const { scene, j, ends, draw } = curvedTee();
	const outline = outlineOf(j, ends);
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
		const sign = inside(draw.asphalt, offsetPoint(m, n, 0.3)) ? -1 : 1;
		expect(inside(draw.pavement, offsetPoint(m, n, sign * 1.5)), `${key} sidewalk`).toBe(true);
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
		expect(inside(draw.pavement, at(2.8, edge + out * 2.8)), `landing at ${edge}`).toBe(true);
		expect(inside(draw.pavement, at(3.4, edge + out * 1.5)), `past landing at ${edge}`).toBe(false);
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
		const { scene } = build(sceneGraph(name));
		const j = scene.effective.find((x) => x.id === 'k')!;
		const ends = endsOf(j, scene.geos);
		const outline = outlineOf(j, ends);
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
