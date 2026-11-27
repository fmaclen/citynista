import { expect, test } from 'bun:test';
import { resolveCrossings, splitSegment } from '../src/lib/core/crossings';
import { bandOf, crossingsHeldBy } from '../src/lib/core/runs';
import { shownAt, sideOf } from '../src/lib/core/road-line';
import { Graph } from '../src/lib/core/graph.svelte';
import { createLanesFrom, getTotalWidth } from '../src/lib/core/lane-template';
import { Networks, type Scene } from '../src/lib/core/networks';
import type { CrossingControl, GraphData, Lane } from '../src/lib/core/types';
import { STOP_ROOM } from '../src/lib/road-model/approach';
import {
	area,
	inside,
	intersect,
	offset,
	piecesOf,
	toPath,
	union
} from '../src/lib/road-model/clip';
import { WALK } from '../src/lib/core/footpaths';
import { shapeOf } from '../src/lib/road-model/overlay';
import { at, junction, junctions } from './junctions';
import type { Description, Sign } from '../src/lib/road-model/description';
import { buildModel, editorDrawing, liveShape, pieces } from './model';

// Where footpaths cross car roads is read one way (core/runs.ts), by the
// drawing alone (core/networks.ts): a run across a road read whole and as
// drawn, its band one connected crossing that every car approach it lies on
// gives way to. Laying a footpath across a car road (resolveCrossings) cuts
// nothing: a crossing is paint.

const preset = (id: string): Lane[] => createLanesFrom(id).map((l, i) => ({ ...l, id: `l${i}` }));
const street = preset('street');
const path = preset('path');
type Node = GraphData['nodes'][number];
type Pt = { x: number; y: number };
const ringArea = (ring: { X: number; Y: number }[]) => area(ring);
const n = (id: string, x: number, y: number): Node => ({ id, x, y });
const s = (id: string, a: string, b: string, lanes = path, more = {}) => ({
	id,
	startNodeId: a,
	endNodeId: b,
	lanes,
	...more
});
const ends = [n('a', -60, 0), n('b', 60, 0)];
const road = s('street', 'a', 'b', street);

const piecesOfScene = (g: GraphData) => {
	const { scene } = buildModel(g);
	return [
		...scene.place.roads.map((r) => scene.road(r.id)!),
		...scene.place.junctions.map((j) => scene.node(j.id)!)
	] as Description[];
};
// The zebras drawn, each piece of ground joined.
const zebras = (g: GraphData) =>
	piecesOf(
		union(
			piecesOfScene(g)
				.flatMap((d) => d.crossings)
				.filter((c) => c.runs.some((r) => r.kind === 'zebra'))
				.flatMap((c) => c.body.map(toPath))
		)
	);
const stops = (g: GraphData) =>
	piecesOfScene(g).flatMap((d) => d.signs.filter((x) => x.kind === 'stop' || x.kind === 'yield'));
const resolved = (g: GraphData, changed: string[]) => {
	const graph = new Graph();
	graph.fromJSON(structuredClone(g));
	const did = resolveCrossings(graph, changed);
	return { graph, did, data: graph.toJSON() };
};

for (const count of [14, 16, 18, 22])
	test(`${count} nodes on a path inside the roadway: one zebra, and laying it cuts nothing`, () => {
		const inside = Array.from({ length: count }, (_, i) =>
			n(`in${i}`, 0, -3.3 + (i * 6.6) / (count - 1))
		);
		const all = [n('p', 0, -12), ...inside, n('q', 0, 12)];
		const g: GraphData = {
			nodes: [...ends, ...all],
			segments: [road, ...all.slice(1).map((x, i) => s(`w${i}`, all[i].id, x.id))]
		};
		expect(zebras(g)).toHaveLength(1);
		const { graph, did, data } = resolved(g, [`w${Math.floor(count / 2)}`]);
		expect(did).toBe(false);
		expect(graph.nodes.size).toBe(g.nodes.length);
		expect(zebras(data)).toHaveLength(1);
	});

test('a loop hung off a footpath node in the roadway is no run, and nothing is cut', () => {
	const g: GraphData = {
		nodes: [
			...ends,
			n('p', 0, -12),
			n('q', 0, 12),
			n('j', 0, 1),
			n('k', 12, 2),
			n('l', 17, -2),
			n('m', 5, -1)
		],
		segments: [
			road,
			s('in', 'p', 'j'),
			s('out', 'j', 'q'),
			s('loop1', 'j', 'k'),
			s('loop2', 'k', 'l'),
			s('loop3', 'l', 'm'),
			s('loop4', 'm', 'j')
		]
	};
	// Its one run is in and out through j; the loop is no way across that
	// passes no node twice.
	const { graph, data } = resolved(g, ['loop2']);
	expect(graph.nodes.size).toBe(g.nodes.length);
	for (const id of ['loop1', 'loop2', 'loop3', 'loop4']) expect(graph.segments.has(id)).toBe(true);
	for (const d of [g, data]) {
		expect(zebras(d)).toHaveLength(1);
		expect(stops(d)).toHaveLength(2);
	}
});

test('a footpath walked round a dead end crosses nothing', () => {
	const g: GraphData = {
		nodes: [n('a', -60, 0), n('b', 50, 0), n('p', 42, -10), n('m', 52, 0), n('q', 42, 10)],
		segments: [road, s('in', 'p', 'm'), s('out', 'm', 'q')]
	};
	expect(zebras(g)).toHaveLength(0);
	expect(stops(g)).toHaveLength(0);
});

test('a street cut where it is drawn whole is crossed as one road', () => {
	const walk = [n('p', -20, -10), n('m', 2, 0), n('q', 24, 10)];
	const whole: GraphData = {
		nodes: [...ends, ...walk],
		segments: [s('left', 'a', 'b', street), s('in', 'p', 'm'), s('out', 'm', 'q')]
	};
	const cut: GraphData = {
		nodes: [...ends, n('carcut', 0, 0), ...walk],
		segments: [
			s('left', 'a', 'carcut', street),
			s('right', 'carcut', 'b', street),
			s('in', 'p', 'm'),
			s('out', 'm', 'q')
		]
	};
	const size = (g: GraphData) => zebras(g).map((z) => z.reduce((t, p) => t + area(p), 0));
	expect(size(cut)).toHaveLength(1);
	expect(size(cut)[0]).toBeCloseTo(size(whole)[0], 3);
});

test('footpaths shifted off the sidewalk their node lies on are no join to it', () => {
	const g: GraphData = {
		nodes: [...ends, n('p', -22, 1), n('m', 0, 4.5), n('q', 22, 1)],
		segments: [
			road,
			s('in', 'p', 'm', path, { offsetStart: 8, offsetEnd: 8 }),
			s('out', 'm', 'q', path, { offsetStart: 8, offsetEnd: 8 })
		]
	};
	const { scene, derived } = buildModel(g);
	expect(derived.sidewalks.has('m')).toBe(false);
	expect(scene.place.junctions.map((j) => j.id)).toContain('walk:m');
	const pieces: Description[] = [scene.road('in')!, scene.road('out')!, scene.node('walk:m')!];
	const ground = pieces.flatMap((d) =>
		d.surfaces.flatMap((x) =>
			'left' in x.shape ? [[...x.shape.left, ...[...x.shape.right].reverse()]] : x.shape
		)
	);
	expect(piecesOf(union(ground.map(toPath)))).toHaveLength(1);
});

test('a footpath shifted across a street is drawn where it shows, cut nowhere', () => {
	const g: GraphData = {
		nodes: [...ends, n('p', -20, -20), n('q', 20, -10)],
		segments: [road, s('path', 'p', 'q', path, { offsetStart: 15, offsetEnd: 15 })]
	};
	expect(zebras(g)).toHaveLength(1);
	const { did, data } = resolved(g, ['path']);
	expect(did).toBe(false);
	expect(data).toEqual(g);
});

test('a long footpath along a curved street is one crossing given way to each way', () => {
	const g: GraphData = {
		nodes: [n('w', -50, 0), n('e', 50, 0), n('p', -45, -14), n('q', 45, 2)],
		segments: [
			s('street', 'w', 'e', street, { controlX: 0, controlY: -60 }),
			s('walk', 'p', 'q', path, { controlX: 0, controlY: -54.3 })
		]
	};
	expect(zebras(g)).toHaveLength(1);
	const { graph, data } = resolved(g, ['walk']);
	expect(data).toEqual(g);
	const signs = stops(data) as (Sign & { a: Pt; b: Pt })[];
	expect(signs.map((x) => x.kind)).toEqual(['yield', 'yield']);
	// Each stands behind the band, just short of it: none of it on the band,
	// its nearest point within the room a give-way line takes behind one.
	const cars = [...graph.segments.values()].filter((x) =>
		x.lanes.some((l) => l.role === 'vehicle')
	);
	const bands = [...graph.segments.values()]
		.filter((x) => !cars.includes(x))
		.flatMap((x) => crossingsHeldBy(graph, x, cars, new Set()))
		.flatMap((c) => c.runs.map((run) => toPath(bandOf(c.road, run))));
	const band = union(bands);
	const near = offset(band, STOP_ROOM + 0.05);
	for (const sign of signs) {
		const along = Array.from({ length: 21 }, (_, i) => ({
			x: sign.a.x + ((sign.b.x - sign.a.x) * i) / 20,
			y: sign.a.y + ((sign.b.y - sign.a.y) * i) / 20
		}));
		expect(along.some((p) => inside(band, p))).toBe(false);
		expect(along.some((p) => inside(near, p))).toBe(true);
	}
	// One each side of it.
	const middle = (sign: (typeof signs)[number]) => ({
		x: (sign.a.x + sign.b.x) / 2,
		y: (sign.a.y + sign.b.y) / 2
	});
	expect(
		Math.hypot(middle(signs[0]).x - middle(signs[1]).x, middle(signs[0]).y - middle(signs[1]).y)
	).toBeGreaterThan(2);
});

test('a diamond inside the roadway is one crossing, whichever branch is listed first', () => {
	const diamond: GraphData = {
		nodes: [
			...ends,
			n('p', 0, -12),
			n('j', 0, -2.5),
			n('k', 0, 2.5),
			n('q', 0, 12),
			n('l', -8, 0),
			n('r', 8, 0)
		],
		segments: [
			road,
			s('in', 'p', 'j'),
			s('out', 'k', 'q'),
			s('l0', 'j', 'l'),
			s('l1', 'l', 'k'),
			s('r0', 'j', 'r'),
			s('r1', 'r', 'k')
		]
	};
	const flipped = {
		...diamond,
		segments: [
			...diamond.segments.slice(0, 3),
			...diamond.segments.slice(5),
			...diamond.segments.slice(3, 5)
		]
	};
	for (const g of [diamond, flipped]) {
		expect(zebras(g)).toHaveLength(1);
		expect(stops(g)).toHaveLength(2);
	}
});

test('a footpath bent 17 m along the street at a node in the roadway still crosses it', () => {
	// Its band where it crosses the curbs.
	const bent: GraphData = {
		nodes: [...ends, n('p', 0, -7), n('m', 17, 0), n('q', 0, 7)],
		segments: [road, s('in', 'p', 'm'), s('out', 'm', 'q')]
	};
	expect(zebras(bent)).toHaveLength(1);
	expect(stops(bent)).toHaveLength(2);
});

test('two footpath nodes that turn back are not merged away, the path between them drawn', () => {
	const g: GraphData = {
		nodes: [n('s', -8.1, 21.98), n('nn', 7.99, -22.11), n('h', -2.16, -9.03), n('c', -2.43, 0)],
		segments: [s('one', 's', 'h'), s('two', 'h', 'c'), s('three', 'c', 'nn')]
	};
	const { scene } = buildModel(g);
	expect(scene.place.hidden).toEqual([]);
	expect(scene.place.junctions.map((j) => j.id).sort()).toEqual(['walk:c', 'walk:h']);
});

test('moving one footpath node reads the crossings near it alone', () => {
	const nodes: GraphData['nodes'] = [];
	const segments: GraphData['segments'] = [];
	for (let i = 0; i < 40; i++) {
		const x = i * 180;
		for (const [k, dx, y] of [
			['a', -60, 0],
			['b', 60, 0],
			['p', 0, -10],
			['m', 0, 0],
			['q', 0, 10]
		] as const)
			nodes.push({ id: `${k}${i}`, x: x + dx, y });
		segments.push(
			s(`road${i}`, `a${i}`, `b${i}`, street),
			s(`in${i}`, `p${i}`, `m${i}`),
			s(`out${i}`, `m${i}`, `q${i}`)
		);
	}
	const live = liveShape({ nodes, segments });
	const networks = new Networks();
	networks.build(live as never);
	live.nodes.get('m0')!.x += 1;
	const read = new Set<number>();
	const stringify = JSON.stringify;
	// Any ground serialised, by the crossing it lies at.
	type Point = { x?: number; X?: number };
	JSON.stringify = ((data: unknown, ...rest: []) => {
		const rings = (data as { rings?: Point[][] } | null)?.rings ?? data;
		const first = Array.isArray(rings) ? (rings[0] as Point[] | undefined)?.[0] : undefined;
		const x = first?.x ?? (first?.X !== undefined ? first.X / 1000 : undefined);
		if (x !== undefined) read.add(Math.round(x / 180));
		return stringify(data, ...rest);
	}) as typeof JSON.stringify;
	try {
		networks.build(live as never);
	} finally {
		JSON.stringify = stringify;
	}
	expect([...read].filter((i) => i > 0)).toEqual([]);
});

// The same graph under other ids and in another order: a renaming applied
// to its segments, nodes kept, the segments shuffled by a seeded generator.
function renamed(g: GraphData, seed: number): GraphData {
	let a = seed >>> 0;
	const random = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), a | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const order = g.segments.map((x) => ({ x, k: random() })).sort((p, q) => p.k - q.k);
	return {
		nodes: g.nodes,
		segments: order.map(({ x }, i) => ({
			...x,
			id: x.lanes === street ? x.id : `r${(i * 7919) % 1000}-${i}`
		}))
	};
}
// What the drawing makes of a graph's crossings over its street: each zebra's
// bounds and the give-way lines.
const crossingsOn = (g: GraphData) => ({
	zebras: zebras(g)
		.map((z) => {
			const p = z.flatMap((r) => r.map((q) => [Math.round(q.X), Math.round(q.Y)]));
			return [
				Math.min(...p.map((q) => q[0])),
				Math.max(...p.map((q) => q[0])),
				Math.min(...p.map((q) => q[1])),
				Math.max(...p.map((q) => q[1]))
			];
		})
		.sort(),
	stops: stops(g).length
});

// Builds graphs of hundreds of nodes several times over: it takes seconds,
// past bun's default 5 s limit on a loaded machine.
test('the runs found are the same under any ids and order of the segments, however many nodes', () => {
	// Ten small diamonds in series inside one roadway.
	const d: GraphData = {
		nodes: [...ends, n('p', 0, -12), n('j0', 0, -3)],
		segments: [road, s('in', 'p', 'j0')]
	};
	for (let i = 0; i < 10; i++) {
		const y = -3 + i * 0.6;
		d.nodes.push(n(`j${i + 1}`, 0, y + 0.6), n(`l${i}`, -1, y + 0.3), n(`r${i}`, 1, y + 0.3));
		d.segments.push(
			s(`l${i}a`, `j${i}`, `l${i}`),
			s(`l${i}b`, `l${i}`, `j${i + 1}`),
			s(`r${i}a`, `j${i}`, `r${i}`),
			s(`r${i}b`, `r${i}`, `j${i + 1}`)
		);
	}
	d.nodes.push(n('q', 0, 12));
	d.segments.push(s('out', 'j10', 'q'));
	const want = crossingsOn(d);
	expect(want).toEqual({ zebras: [expect.any(Array)], stops: 2 });
	for (const seed of [1, 2, 3, 4]) expect(crossingsOn(renamed(d, seed))).toEqual(want);
	// A straight path of hundreds of nodes inside the roadway still crosses.
	for (const count of [511, 512, 600]) {
		const all = [
			n('p', 0, -12),
			...Array.from({ length: count }, (_, i) => n(`i${i}`, 0, -3.3 + (i * 6.6) / (count - 1))),
			n('q', 0, 12)
		];
		const g: GraphData = {
			nodes: [...ends, ...all],
			segments: [road, ...all.slice(1).map((x, i) => s(`w${i}`, all[i].id, x.id))]
		};
		expect([count, zebras(g).length]).toEqual([count, 1]);
	}
}, 30_000);

test('a footpath across fifty-one roads crosses each, cut on none', () => {
	const graph = new Graph();
	for (let i = 0; i < 51; i++) {
		const [p, q] = [graph.createNode(-10, i * 10), graph.createNode(10, i * 10)];
		graph.createSegment(p.id, q.id, preset('lane'));
	}
	const [p, q] = [graph.createNode(0, -6), graph.createNode(0, 506)];
	expect(resolveCrossings(graph, [graph.createSegment(p.id, q.id, path).id])).toBe(false);
	expect(graph.nodes.size).toBe(104);
	expect(zebras(graph.toJSON())).toHaveLength(51);
});

// A footpath through a junction's ground makes no crossing there
// (onJunction in core/networks.ts): a T crossed through its middle is drawn
// as the T alone, whatever its roads' ids and once an arm is cut.
test('a T crossed through its junction paints nothing there, whatever the ids', () => {
	const t: GraphData = {
		nodes: [...ends, n('j', 0, 0), n('c', 0, 60), n('p', -8, -10), n('q', 8, 10), n('m', 0, 0)],
		segments: [
			s('a-west', 'a', 'j', street),
			s('b-east', 'j', 'b', street),
			s('c-north', 'j', 'c', street),
			s('in', 'p', 'm'),
			s('out', 'm', 'q')
		]
	};
	const drawn = (g: GraphData) => {
		const all = piecesOfScene(g);
		const bodies = all.flatMap((d) =>
			d.crossings.filter((c) => c.runs.some((r) => r.kind === 'zebra')).flatMap((c) => c.body)
		);
		const signs = all.flatMap((d) =>
			d.signs.filter((x) => x.kind === 'stop' || x.kind === 'yield')
		);
		const area = union(bodies.map(toPath)).reduce((sum, ring) => sum + Math.abs(ringArea(ring)), 0);
		return { area: Math.round(area * 100) / 100, stops: signs.length };
	};
	const want = drawn({ ...t, segments: t.segments.filter((x) => x.id !== 'in' && x.id !== 'out') });
	expect(drawn(t)).toEqual(want);
	for (const id of ['a-west', 'b-east', 'c-north'])
		expect(
			drawn({ ...t, segments: t.segments.map((x) => (x.id === id ? { ...x, id: `0-${id}` } : x)) })
		).toEqual(want);
	const graph = new Graph();
	graph.fromJSON(structuredClone(t));
	splitSegment(graph, graph.segments.get('a-west')!, 0.5, graph.createNode(-30, 0).id);
	expect(drawn(graph.toJSON())).toEqual(want);
});

// Which road a run across a T's middle is read as crossing (crossingsHeldBy,
// heldAt in core/runs.ts, as at a node of two sides) is read off the roads as
// drawn, never off the way each is stored: a footpath slid across a T's
// middle, square and at a slant, its arms each stored either way round (an
// arm leaving due west among them), is read against the same roads every
// time. (Over a junction's ground it is then no crossing: onJunction in
// core/networks.ts.)
test('the roads a run across a T is read as crossing are the same whichever way they are stored', () => {
	const flip = (x: ReturnType<typeof s>) => ({
		...x,
		startNodeId: x.endNodeId,
		endNodeId: x.startNodeId,
		lanes: [...x.lanes].reverse().map((l) => ({
			...l,
			direction:
				l.direction === 'forward'
					? 'backward'
					: l.direction === 'backward'
						? 'forward'
						: l.direction
		}))
	});
	const arms = [
		s('west', 'a', 'j', street),
		s('east', 'j', 'b', street),
		s('north', 'j', 'c', street)
	];
	const holder = (stored: number, x: number, tilt: number) => {
		const graph = new Graph();
		graph.fromJSON({
			nodes: [...ends, n('j', 0, 0), n('c', 0, 60), n('p', x - tilt, -10), n('q', x + tilt, 10)],
			segments: [...arms.map((x, k) => (stored & (1 << k) ? flip(x) : x)), s('walk', 'p', 'q')]
		} as GraphData);
		const cars = arms.map((x) => graph.segments.get(x.id)!);
		return crossingsHeldBy(graph, graph.segments.get('walk')!, cars, new Set())
			.map((c) => c.road.segments.join())
			.sort();
	};
	const found: string[] = [];
	for (const tilt of [0, 2, -2])
		for (let x = -2; x <= 2; x += 0.5) {
			const want = holder(0, x, tilt);
			for (let stored = 1; stored < 8; stored++) {
				const got = holder(stored, x, tilt);
				if (JSON.stringify(got) !== JSON.stringify(want))
					found.push(`x ${x}, tilt ${tilt}, stored ${stored}: ${got} not ${want}`);
			}
		}
	expect(found).toEqual([]);
});

test('a footpath bent back inside the roadway, its bend short of the far curb, crosses nothing; moved past it, it crosses twice', () => {
	// A street with no sidewalks along y 0, its roadway y -3.5 to 3.5, and a
	// footpath laid from (-10, -20) to a node at (0, 4.5) and back to
	// (10, -20): its bend's paving turns inside the roadway, so it never
	// leaves it on the far side and nothing gives way to it.
	const g: GraphData = {
		nodes: [n('a', -35, 0), n('b', 35, 0), n('p', -10, -20), n('j', 0, 4.5), n('q', 10, -20)],
		segments: [s('r', 'a', 'b', street.slice(1, 3)), s('in', 'p', 'j'), s('out', 'j', 'q')]
	};
	const { graph, did, data } = resolved(g, ['in', 'out']);
	expect(did).toBe(false);
	expect(graph.segments.size).toBe(3);
	const crossingsOf = (d: GraphData) => {
		const road = buildModel(d).scene.road('r')!;
		return {
			crossings: road.crossings.length,
			lines: road.signs.filter((x) => x.kind === 'yield' || x.kind === 'stop').length
		};
	};
	expect(crossingsOf(data)).toEqual({ crossings: 0, lines: 0 });
	// Its bend moved out well past the far curb: it crosses twice, once each
	// way.
	data.nodes.find((x) => x.id === 'j')!.y = 16;
	expect(crossingsOf(data).crossings).toBe(2);
});

test('a street lying over another where a footpath crosses only the first: the other takes nothing', () => {
	const g: GraphData = {
		nodes: [
			...ends,
			n('c', -20, 2.8),
			n('d', 20, 2.8),
			n('p', 0, -12),
			n('q', 0, 3.8),
			n('m', 0, 0)
		],
		segments: [road, s('other', 'c', 'd', street), s('in', 'p', 'm'), s('out', 'm', 'q')]
	};
	const { scene } = buildModel(g);
	expect(
		scene.road('other')!.crossings.filter((c) => c.runs.some((r) => r.kind === 'zebra'))
	).toEqual([]);
	expect(scene.road('other')!.signs.filter((x) => x.kind === 'yield')).toEqual([]);
	expect(scene.road('street')!.signs.filter((x) => x.kind === 'yield')).toHaveLength(2);
});

// The owner's street with a walkway down its middle: sidewalk 2, a lane
// each way 3.5 with the walkway 4 between them, sidewalk 2. Its back lane
// (`l1`) lies 2 to 5.5 m left of its line, its forward lane (`l3`) as far
// right.
const parted = (['pedestrian', 'vehicle', 'pedestrian', 'vehicle', 'pedestrian'] as const).map(
	(role, i): Lane => ({
		id: `l${i}`,
		role,
		material: role === 'vehicle' ? 'asphalt' : 'concrete',
		width: [2, 3.5, 4, 3.5, 2][i],
		direction: i === 1 ? 'backward' : i === 3 ? 'forward' : 'bidirectional'
	})
);
const partedRoad = s('street', 'a', 'b', parted);
// Every point of the zebra stripes drawn, how far right of the street's line.
const zebraAcross = (g: GraphData) =>
	piecesOfScene(g).flatMap((d) =>
		d.crossings.flatMap((c) =>
			c.runs.filter((r) => r.kind === 'zebra').flatMap((r) => r.rings.flat().map((p) => p.y))
		)
	);
const yieldLanes = (g: GraphData) =>
	stops(g)
		.map((x) => x.lanes.map((l) => l.lane).join())
		.sort();

test('a footpath ended on a walkway down the middle crosses the carriageway it came over alone', () => {
	const g: GraphData = {
		nodes: [...ends, n('p', 0, 14), n('m', 0, 0)],
		segments: [partedRoad, s('in', 'p', 'm')]
	};
	expect(zebras(g)).toHaveLength(1);
	for (const y of zebraAcross(g)) expect(y > 1.9 && y < 5.6).toBe(true);
	expect(yieldLanes(g)).toEqual(['l3']);
});

test('a footpath right across a street with a walkway down the middle crosses each carriageway', () => {
	const g: GraphData = {
		nodes: [...ends, n('p', 0, 14), n('q', 0, -14)],
		segments: [partedRoad, s('across', 'p', 'q')]
	};
	expect(zebras(g)).toHaveLength(2);
	for (const y of zebraAcross(g)) expect(Math.abs(y) > 1.9 && Math.abs(y) < 5.6).toBe(true);
	expect(yieldLanes(g)).toEqual(['l1', 'l3']);
});

test("a footpath's end on a street goes to the walkway nearest, the middle one included", () => {
	const graph = new Graph();
	graph.fromJSON(structuredClone({ nodes: ends, segments: [partedRoad] }));
	const street = graph.segments.get('street')!;
	const at = (y: number, lane?: string) => sideOf(graph, street, 10, y, undefined, lane)?.y;
	// On the middle walkway, and over a lane nearer it than the sidewalk.
	expect(at(0.5)).toBeCloseTo(0, 9);
	expect(at(3)).toBeCloseTo(0, 9);
	// Over a lane nearer the sidewalk, and on it.
	expect(at(4.5)).toBeCloseTo(6.5, 9);
	expect(at(-7)).toBeCloseTo(-6.5, 9);
	// Held to one walkway, wherever the point.
	expect(at(-3, 'l4')).toBeCloseTo(6.5, 9);
	expect(at(0, 'l1')).toBeUndefined();
});

// A crossing lies on road ground alone, or is none (onJunction in
// core/networks.ts, `judge` below). Swept over junctions of the app's presets
// (unit/junctions.ts, a four-way of One-way lanes and two T's merged over a
// short road among them), with paths 2, 4 and 8 m wide, straight, curved and
// shifted (by a shift that changes along it), each stored either way:
// through the middle at several angles, square and slant across an arm slid
// step by step from 30 m out to the middle, across a corner at several
// distances, ending inside, and two at once (two through the middle, and one
// through with one across an arm well clear). Every path stores a stop for
// each arm and a control by the junction's node as a city saved with
// crossings over junctions held them. At every step each path is one of the
// two `judge` reads; one every stretch of whose paving over car ground
// reaches the junction (measured apart, on the car ground as drawn) is no
// crossing; the arm's crossing well clear stays one; and the footpath's own
// paving over the verges it walks lies on no car ground (but for slivers
// where it meets a curved curb).
test("a footpath's stretch reaching a junction's ground paints nothing, holds nothing and reads no control", () => {
	type Pt = { x: number; y: number };
	const one = [0, 90, 180, 270].map((a) => ({ to: at(a), kind: 'lane' as const }));
	const merged: GraphData = {
		nodes: [
			n('l', -65, 0),
			n('m', 0, 0),
			n('n', 3, 0),
			n('r', 65, 0),
			n('u', 0, 50),
			n('d', 3, -50)
		],
		segments: [
			s('arm0', 'n', 'r', street),
			s('middle', 'm', 'n', street),
			s('arm1', 'm', 'u', street),
			s('arm2', 'l', 'm', street),
			s('arm3', 'n', 'd', street)
		]
	};
	const sets: { name: string; graph: GraphData; arms: Pt[]; c: Pt }[] = [
		...[...junctions, { name: 'a four-way of One-way lanes', arms: one }].map(({ name, arms }) => ({
			name,
			graph: junction(arms, name.length % 2 === 0),
			arms: arms.map((a) => a.to),
			c: { x: 0, y: 0 }
		})),
		{
			name: "two T's merged",
			graph: merged,
			arms: [
				{ x: 65, y: 0 },
				{ x: 0, y: 50 },
				{ x: -65, y: 0 }
			],
			c: { x: 1.5, y: 0 }
		}
	];
	const unit = (p: Pt) => {
		const l = Math.hypot(p.x, p.y);
		return { x: p.x / l, y: p.y / l };
	};
	const along = (c: Pt, u: Pt, d: number) => ({ x: c.x + u.x * d, y: c.y + u.y * d });
	const turn = (u: Pt, deg: number) => {
		const r = (deg * Math.PI) / 180;
		return { x: u.x * Math.cos(r) - u.y * Math.sin(r), y: u.x * Math.sin(r) + u.y * Math.cos(r) };
	};
	// Each place a path lies, as its two ends.
	const places = (c: Pt, arms: Pt[]) => {
		const [u0, u1] = [
			unit({ x: arms[0].x - c.x, y: arms[0].y - c.y }),
			unit({ x: arms[1].x - c.x, y: arms[1].y - c.y })
		];
		const bis = unit({ x: u0.x + u1.x, y: u0.y + u1.y });
		const out: [string, Pt, Pt][] = [];
		for (const deg of [25, 60, 115]) {
			const u = turn(u0, deg);
			out.push([`through at ${deg}°`, along(c, u, -45), along(c, u, 45)]);
		}
		for (const slant of [0, 30])
			for (const d of [30, 20, 16, 13, 11, 9, 7, 5, 3, 0]) {
				const m = along(c, u0, d);
				const u = turn(u0, 90 + slant);
				out.push([`across an arm ${slant}° at ${d} m`, along(m, u, -25), along(m, u, 25)]);
			}
		for (const r of [7, 11, 15, 20]) {
			const m = along(c, bis, r);
			const u = turn(bis, 90);
			out.push([`across a corner at ${r} m`, along(m, u, -30), along(m, u, 30)]);
		}
		out.push(['ending inside', along(c, bis, 35), along(c, bis, 0.5)]);
		return out;
	};
	const pathSeg = (id: string, a: Pt, b: Pt, width: number, form: string, flip: boolean) => {
		const lanes: Lane[] = [{ ...path[0], width }];
		const normal = unit({ x: -(b.y - a.y), y: b.x - a.x });
		const mid = { x: (a.x + b.x) / 2 + normal.x * 6, y: (a.y + b.y) / 2 + normal.y * 6 };
		const shift = flip
			? { offsetStart: 0.5, offsetEnd: -1.5 }
			: { offsetStart: -1.5, offsetEnd: 0.5 };
		return {
			nodes: [n(`${id}a`, a.x, a.y), n(`${id}b`, b.x, b.y)],
			segment: {
				...s(id, flip ? `${id}b` : `${id}a`, flip ? `${id}a` : `${id}b`, lanes, {
					...(form === 'curved' && { controlX: mid.x, controlY: mid.y }),
					...(form === 'shifted' && shift)
				}),
				controls: [
					...['arm0', 'arm1', 'arm2', 'arm3'].map((r) => ({
						roads: [r],
						control: 'stop' as const
					})),
					{ roads: [], nodes: ['j', 'm', 'n'], control: 'signal' } as CrossingControl
				]
			}
		};
	};
	const withPathsAt = (g: GraphData, paths: ReturnType<typeof pathSeg>[]): GraphData => ({
		nodes: [...g.nodes, ...paths.flatMap((p) => p.nodes)],
		segments: [...g.segments, ...paths.map((p) => p.segment)]
	});
	const vergesOf = (scene: Scene) =>
		carPieces(scene).flatMap(([, d]) =>
			(d?.crossings ?? []).filter(paved).flatMap((c) => c.runs.flatMap((r) => r.rings.map(toPath)))
		);
	const sum = (paths: ReturnType<typeof union>) => paths.reduce((t, q) => t + area(q), 0);
	const problems: string[] = [];
	let reached = 0;
	let crossed = 0;
	for (const set of sets) {
		const bare = buildModel(set.graph).scene;
		const far = (k: number) => {
			const u0 = unit({ x: set.arms[0].x - set.c.x, y: set.arms[0].y - set.c.y });
			const m = along(set.c, u0, 30);
			const u = turn(u0, 90);
			return pathSeg('far', along(m, u, -25), along(m, u, 25), 2, 'straight', k % 2 === 1);
		};
		const withFar = buildModel(withPathsAt(set.graph, [far(0)])).scene;
		for (const width of [2, 4, 8])
			for (const form of ['straight', 'curved', 'shifted'])
				for (const [k, [where, a, b]] of places(set.c, set.arms).entries()) {
					const flip = (k + width) % 2 === 1;
					const cases: [string, ReturnType<typeof pathSeg>[]][] = [
						[where, [pathSeg('w', a, b, width, form, flip)]]
					];
					if (k === 0) {
						const u = turn(unit({ x: b.x - a.x, y: b.y - a.y }), 90);
						cases.push([
							'two through the middle',
							[
								pathSeg('w', a, b, width, form, flip),
								pathSeg('v', along(set.c, u, -45), along(set.c, u, 45), width, form, !flip)
							]
						]);
						cases.push([
							'one through, one across an arm',
							[pathSeg('w', a, b, width, form, flip), far(k)]
						]);
					}
					for (const [what, paths] of cases) {
						const label = `${set.name}, ${width} m ${form}, ${what}`;
						const g = withPathsAt(set.graph, paths);
						const { scene } = buildModel(g);
						const ground = union(
							carPieces(scene).flatMap(([, d, meets]) => (meets ? hardOf(d) : []))
						);
						const cars = union(carPieces(scene).flatMap(([, d]) => hardOf(d)));
						if (sum(intersect(union(vergesOf(scene)), offset(cars, -0.02))) > 0.01)
							problems.push(`${label}: a verge's paving lies on car ground`);
						for (const p of paths) {
							const id = p.segment.id;
							const others = paths.filter((q) => q !== p).map((q) => q.segment.id);
							const without = !others.length ? bare : others.join() === 'far' ? withFar : undefined;
							const { outcome, problems: found } = judge(g, [id], scene, without);
							problems.push(...found.map((x) => `${label}: ${id} ${x}`));
							const paving = union(
								scene.footpathPaving(id).flatMap((x) => x.description.surfaces.flatMap(shapeOf))
							);
							const parts = piecesOf(intersect(paving, cars));
							const reaching = parts.filter((part) => sum(intersect(part, ground)) > 1e-4);
							if (reaching.length) reached++;
							if (outcome === 'present') crossed++;
							if (outcome === 'present' && parts.length && reaching.length === parts.length)
								problems.push(
									`${label}: ${id} crosses, every stretch of its paving reaching the junction`
								);
							if (id === 'far' && outcome !== 'present')
								problems.push(`${label}: the arm's crossing is gone`);
						}
					}
				}
	}
	expect(problems).toEqual([]);
	expect(reached).toBeGreaterThan(1500);
	expect(crossed).toBeGreaterThan(300);
}, 120_000);

// A crossing lies on road ground alone, or is none (onJunction in
// core/networks.ts). Read off the drawing alone, a footpath (some of its
// segments, `ids`) is one of two:
//
// - `absent`: it holds no crossing, and the car roads are drawn exactly as
//   in the same city without it, but for its own paving over the verges it
//   walks;
// - `present`: it holds crossings, painted on road pieces alone (or
//   nowhere, under a crosswalk of the road's own), and every stop or
//   give-way line drawn otherwise than in the city without it stands across
//   the lanes of a road it crosses: no approach is held but the crossed
//   road's own. Each junction is drawn exactly as in the city without it
//   but for what the approach of a road it crosses puts down there (lines
//   and arrows across that road's lanes, that approach's badge and arrows)
//   and its own paving over the junction's verges.
//
// Anything else is a problem, named.
const json = (d: unknown) => JSON.stringify(d, (k, v) => (k === 'key' ? undefined : v));
const paved = (c: Description['crossings'][number]) =>
	!c.of && !c.body.length && c.runs.every((r) => r.kind === 'paved');
const carPieces = (scene: Scene) => [
	...scene.place.roads
		.filter((r) => r.lanes.some((l) => l.kind === 'drive'))
		.map((r) => [r.id, scene.road(r.id)] as const),
	...scene.place.junctions
		.filter((j) => !j.id.startsWith(WALK))
		.map((j) => [j.id, scene.node(j.id), j.ends.length > 2] as const)
];
const hardOf = (d: Description | undefined) =>
	union(
		(d?.surfaces ?? [])
			.filter((x) => x.role === 'lane' || x.role === 'paving' || x.role === 'median')
			.flatMap(shapeOf)
	);
const carsDrawn = (scene: Scene) =>
	carPieces(scene).map(([, d]) =>
		json(d && { ...d, crossings: d.crossings.filter((c) => !paved(c)) })
	);
const linesOf = (scene: Scene) =>
	carPieces(scene).flatMap(([, d]) =>
		(d?.signs ?? []).filter((x) => x.kind === 'stop' || x.kind === 'yield').map((x) => json(x))
	);
function judge(
	g: GraphData,
	ids: string[],
	scene = buildModel(g).scene,
	without = buildModel({ ...g, segments: g.segments.filter((x) => !ids.includes(x.id)) }).scene
) {
	const held = ids.flatMap((id) => scene.walking().runsOf(id));
	const problems: string[] = [];
	if (!held.length) {
		if (json(carsDrawn(scene)) !== json(carsDrawn(without)))
			problems.push('no crossing, but the car roads are drawn otherwise');
		return { outcome: 'absent' as const, problems };
	}
	const mine = (c: Description['crossings'][number]) =>
		ids.some((id) => c.of?.startsWith(`${id}~`));
	for (const [id, d, meets] of carPieces(scene))
		if (meets && d?.crossings.some(mine)) problems.push(`painted on the junction ${id}`);
	const crossed = new Set(held.flatMap((c) => c.roads));
	const drawn = new Map(carPieces(without).map(([id, d]) => [id, d]));
	const roadOf = (x: Sign) => ('lanes' in x ? x.lanes : [x.lane]).map((l) => l.road);
	for (const [id, d, meets] of carPieces(scene)) {
		const was = drawn.get(id);
		if (!meets || !d || !was || !('outline' in d) || !('outline' in was)) continue;
		const rest = (x: typeof d) =>
			json({ ...x, signs: [], approaches: [], crossings: x.crossings.filter((c) => !paved(c)) });
		if (rest(d) !== rest(was)) problems.push(`the junction ${id} drawn otherwise`);
		const apart = <T>(a: T[], b: T[]) => {
			const [as, bs] = [a.map(json), b.map(json)];
			return [
				...a.filter((_, k) => !bs.includes(as[k])),
				...b.filter((_, k) => !as.includes(bs[k]))
			];
		};
		for (const x of apart(d.signs, was.signs))
			if (!roadOf(x).every((r) => crossed.has(r)))
				problems.push(`the junction ${id} draws a ${x.kind} for ${roadOf(x).join()}`);
		for (const x of apart(d.approaches, was.approaches))
			if (!crossed.has(x.end.split(':')[0]))
				problems.push(`the junction ${id} changes its approach ${x.end}`);
	}
	const [now, was] = [linesOf(scene), linesOf(without)];
	for (const line of [
		...now.filter((x) => !was.includes(x)),
		...was.filter((x) => !now.includes(x))
	]) {
		const { lanes } = JSON.parse(line) as { lanes: { road: string }[] };
		if (!lanes.every((l) => crossed.has(l.road)))
			problems.push(`holds ${lanes.map((l) => l.road).join()}, not a road it crosses`);
	}
	return { outcome: 'present' as const, problems };
}

const fourWay = (lanes: Lane[]): GraphData => ({
	nodes: [
		{
			id: 'j',
			x: 0,
			y: 0,
			junction: {
				control: { 'e:start': 'none', 'w:start': 'none', 'n:start': 'none', 's:start': 'none' }
			}
		},
		n('E', 60, 0),
		n('W', -60, 0),
		n('N', 0, -60),
		n('S', 0, 60)
	],
	segments: [
		s('e', 'j', 'E', lanes),
		s('w', 'j', 'W', lanes),
		s('n', 'j', 'N', lanes),
		s('s', 'j', 'S', lanes)
	]
});
const bareStreet = street.filter((l) => l.role === 'vehicle');
const widthOf = (width: number): Lane[] => [{ ...path[0], width }];
const flipped = (x: ReturnType<typeof s>) => ({
	...x,
	startNodeId: x.endNodeId,
	endNodeId: x.startNodeId
});
const add = (g: GraphData, nodes: Node[], segments: ReturnType<typeof s>[]): GraphData => ({
	nodes: [...g.nodes, ...nodes],
	segments: [...g.segments, ...segments]
});

// A separate T beside a street a footpath crosses, its ground a gap (5 cm to
// 1 m) clear of the street's (its curb with no sidewalks, its sidewalk's
// outer edge with them), the footpath ending just past the far curb or in
// the gap: the T has no part in the crossing, whose paint is cut from a band
// reaching half a metre past the curb (bandOf), so it takes nothing from it.
// And dragged from 5 m off into that gap at a stroke, then out and step by
// step in and back out, the drawing kept from build to build is the one a
// fresh build makes.
test('a separate junction beside a crossing takes nothing from it, however near, and moving it keeps the drawing fresh', () => {
	const problems: string[] = [];
	const city = (walks: boolean, gap: number, end: number, flip: boolean) => {
		const y = (walks ? 5.5 : 3.5) + gap + 3.5;
		const walk = s('walk', 'p', 'q', path, {
			controls: [{ roads: ['street'], control: 'signal' }]
		});
		return {
			nodes: [
				...ends,
				n('j', 0, y),
				n('jw', -50, y),
				n('je', 50, y),
				n('jn', 0, y + 45),
				n('p', 0, -22),
				n('q', 0, end)
			],
			segments: [
				s('street', 'a', 'b', walks ? street : bareStreet),
				s('tw', 'j', 'jw', bareStreet),
				s('te', 'j', 'je', bareStreet),
				s('tn', 'j', 'jn', bareStreet),
				flip ? flipped(walk) : walk
			]
		} as GraphData;
	};
	for (const walks of [false, true])
		for (const gap of [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1])
			for (const end of [3.6, (walks ? 5.5 : 3.5) + gap / 2])
				for (const flip of [false, true]) {
					const { outcome, problems: found } = judge(city(walks, gap, end, flip), ['walk']);
					const label = `${walks ? 'sidewalks' : 'bare'}, gap ${gap} m, ending at ${end}`;
					if (outcome !== 'present') problems.push(`${label}: no crossing`);
					problems.push(...found.map((p) => `${label}: ${p}`));
				}
	for (const walks of [false, true]) {
		const live = liveShape(city(walks, 5, 3.6, false));
		const draw = editorDrawing();
		draw(live);
		const steps = [0.3, 5, 1, 0.75, 0.5, 0.3, 0.2, 0.1, 0.05, 0.1, 0.3, 0.5, 1, 5];
		for (const gap of steps) {
			const y = (walks ? 5.5 : 3.5) + gap + 3.5;
			for (const id of ['j', 'jw', 'je']) live.nodes.get(id)!.y = y;
			live.nodes.get('jn')!.y = y + 45;
			const kept = draw(live);
			const data = city(walks, gap, 3.6, false);
			if (json([...pieces(kept)]) !== json([...pieces(buildModel(data).scene)]))
				problems.push(
					`${walks ? 'sidewalks' : 'bare'}, dragged to ${gap} m: drawn otherwise than fresh`
				);
			if (judge(data, ['walk']).outcome !== 'present')
				problems.push(`${walks ? 'sidewalks' : 'bare'}, dragged to ${gap} m: no crossing`);
		}
	}
	expect(problems).toEqual([]);
});

// A curved footpath crossing a four-way's arm well out, then hugging the
// arm's curb on its sidewalk (its middle 0 to 20 mm further off than the
// sidewalk's) and curving back into the junction. Where its paving as drawn
// stays off the asphalt between, the asphalt it crosses and the junction's
// are two stretches of it, and it keeps its crossing of the arm: closing the
// seams of car ground moves no curb out over the sidewalk. Where its paving
// touches the asphalt there (its edge drawn in chords, which cut the curve
// by a few millimetres), it runs on in one piece and is none. Mirrored across
// the arm and stored either way.
test('a footpath leaving the asphalt by millimetres between an arm and the junction keeps its crossing of the arm', () => {
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const side of [1, -1])
		for (const flip of [false, true])
			for (const mm of [0, 1, 2, 3, 5, 6, 8, 10, 12, 15, 20]) {
				const apex = side * (-4.5 - mm / 1000);
				const w = s('w', 'p', 'q', path, {
					controlX: 17.5,
					controlY: 2 * apex - side * 10,
					controls: [{ roads: ['e'], control: 'stop' }]
				});
				const g = add(
					fourWay(street),
					[n('p', 35, side * 10), n('q', 0, side * 10)],
					[flip ? flipped(w) : w]
				);
				const { outcome, problems: found } = judge(g, ['w']);
				const label = `${side > 0 ? 'north' : 'south'}${flip ? ', flipped' : ''}, ${mm} mm off`;
				problems.push(...found.map((p) => `${label}: ${p}`));
				// Its paving as drawn over the car ground as drawn, measured apart.
				const { scene } = buildModel(g);
				const cars = union(carPieces(scene).flatMap(([, d]) => hardOf(d)));
				const paving = union(
					scene.footpathPaving('w').flatMap((x) => x.description.surfaces.flatMap(shapeOf))
				);
				const apart = piecesOf(intersect(paving, cars)).length > 1;
				if (outcome !== (apart ? 'present' : 'absent'))
					problems.push(`${label}: ${outcome}, its paving ${apart ? 'apart' : 'in one piece'}`);
				seen.add(outcome);
			}
	expect(problems).toEqual([]);
	expect([...seen].sort()).toEqual(['absent', 'present']);
});

// A slanted footpath ending just past an arm's curb near the junction's mouth
// (4 m wide, as wide as 8 m, and 2 m), stepped along the arm from inside the
// mouth to well clear of it, slanted either way, and steeply (15° off the
// arm, 4 m wide) round where its band's tip lies wholly in the gap before
// the zebra's first bar: its paint is cut from a band carried along the
// curb, which may reach past its paving onto the junction. It is a crossing
// exactly where its paving over the asphalt (measured apart, on the car
// ground as drawn) stays off the junction's, and the junction paints none
// of it either way.
test('a slanted footpath near a junction mouth is a crossing exactly where its paving stays off the junction', () => {
	const problems: string[] = [];
	const seen = new Set<string>();
	const step = (width: number, from: { x: number; y: number }, to: { x: number; y: number }) => {
		const w = s('w', 'p', 'q', widthOf(width), {
			controls: [{ roads: ['e'], control: 'stop' }]
		});
		const g = add(fourWay(street), [n('p', from.x, from.y), n('q', to.x, to.y)], [w]);
		const { outcome, problems: found } = judge(g, ['w']);
		const label = `${width} m from (${from.x}, ${from.y}) to (${to.x}, ${to.y})`;
		problems.push(...found.map((p) => `${label}: ${p}`));
		const { scene } = buildModel(g);
		const cars = union(carPieces(scene).flatMap(([, d]) => hardOf(d)));
		const junction = hardOf(scene.node('j'));
		const paving = union(
			scene.footpathPaving('w').flatMap((x) => x.description.surfaces.flatMap(shapeOf))
		);
		const sum = (paths: ReturnType<typeof union>) => paths.reduce((t, q) => t + area(q), 0);
		const reaches = sum(intersect(intersect(paving, cars), junction)) > 1e-4;
		if (outcome !== (reaches ? 'absent' : 'present'))
			problems.push(`${label}: ${outcome}, its paving ${reaches ? 'on' : 'off'} the junction`);
		seen.add(outcome);
		return outcome;
	};
	for (const width of [2, 4, 8])
		for (const lean of [10, -10])
			for (let x = 8; x <= 14; x += 0.25) step(width, { x, y: -3.7 }, { x: x + lean, y: 12 });
	for (let k = -4; k <= 4; k++) {
		const x = 10.05 + k / 8;
		step(4, { x, y: -3.55 }, { x: x + 60, y: 12 });
	}
	expect(problems).toEqual([]);
	expect([...seen].sort()).toEqual(['absent', 'present']);
	// One whose band reaches 0.048 m² onto the junction, and one whose band's
	// tip on it lies before the first bar.
	expect(step(4, { x: 10.5, y: -3.7 }, { x: 20.5, y: 12 })).toBe('present');
	expect(step(4, { x: 10.05, y: -3.55 }, { x: 70.05, y: 12 })).toBe('present');
});

// A square 2 m footpath across an arm stepped across the junction's seam in
// tenths of a millimetre, storing a stop: on the junction's ground it is no
// crossing; off it, a crossing whose stop holds the arm alone, never the
// junction's other approaches, even with its edge on the seam.
test('a footpath stepped across a junction seam is no crossing, then one holding its own arm alone', () => {
	const problems: string[] = [];
	const outcomes: string[] = [];
	for (let k = -20; k <= 20; k++) {
		const x = 9.5 + k / 10_000;
		const w = s('w', 'p', 'q', path, { controls: [{ roads: ['e'], control: 'stop' }] });
		const { outcome, problems: found } = judge(
			add(fourWay(street), [n('p', x, -20), n('q', x, 20)], [w]),
			['w']
		);
		outcomes.push(outcome);
		problems.push(...found.map((p) => `${k / 10} mm: ${p}`));
	}
	expect(problems).toEqual([]);
	// Absent while it lies on the junction, present from where it leaves it on.
	const first = outcomes.indexOf('present');
	expect(first).toBeGreaterThan(0);
	expect(outcomes.slice(first).every((o) => o === 'present')).toBe(true);
	expect(outcomes.slice(0, first).every((o) => o === 'absent')).toBe(true);
});

// A footpath crossing an arm, with a second footpath leaving its node and
// running into the junction: the crossing is its route from curb to curb
// alone, so it keeps its zebra, and the branch makes no crossing and paints
// nothing. Its node in the roadway (split there, the branch running into
// the junction or through it into the far arm, on a Street and along an
// Avenue's median) or just past the curb (the branch dipping back over the
// asphalt into the junction), at several distances along the arm.
test('a branch leaving a crossing footpath into a junction leaves the crossing as it is and paints nothing', () => {
	const problems: string[] = [];
	const avenue = preset('avenue');
	// Each split clear of the junction's mouth (8.5 m out on a Street, 15 m
	// on an Avenue), its joint too.
	for (const [name, lanes, mouth] of [
		['Street', street, 8.5],
		['Avenue', avenue, 15]
	] as const)
		for (const x of [3.5, 7.5, 11.5, 21.5].map((d) => mouth + d))
			for (const to of [0, -25]) {
				const g = add(
					fourWay(lanes),
					[n('fa', x, -25), n('fm', x, 0), n('fb', x, 25), n('fj', to, 0)],
					[
						s('f1', 'fa', 'fm', path, { controls: [{ roads: ['e'], control: 'stop' }] }),
						s('f2', 'fm', 'fb', path),
						s('spur', 'fm', 'fj', path)
					]
				);
				const label = `${name}, split at ${x}, branch to ${to}`;
				const crossing = judge(g, ['f1', 'f2']);
				if (crossing.outcome !== 'present') problems.push(`${label}: no crossing`);
				const branch = judge(g, ['spur']);
				if (branch.outcome !== 'absent') problems.push(`${label}: the branch crosses`);
				problems.push(...[...crossing.problems, ...branch.problems].map((p) => `${label}: ${p}`));
			}
	for (const x of [16, 24, 30])
		for (const y of [3.6, 4.5, 6]) {
			const g = add(
				fourWay(street),
				[n('pa', x, -22), n('pb', x, y), n('pd', 1, 0)],
				[
					s('path-a', 'pa', 'pb', path, { controls: [{ roads: ['e'], control: 'stop' }] }),
					s('path-b', 'pb', 'pd', path)
				]
			);
			const label = `joined at (${x}, ${y})`;
			const crossing = judge(g, ['path-a']);
			if (crossing.outcome !== 'present') problems.push(`${label}: no crossing`);
			const branch = judge(g, ['path-b']);
			if (branch.outcome !== 'absent') problems.push(`${label}: the branch crosses`);
			problems.push(...[...crossing.problems, ...branch.problems].map((p) => `${label}: ${p}`));
		}
	expect(problems).toEqual([]);
});

// The crossings a footpath holds of a car road, read on a Graph as the page
// builds it and on the plain objects a saved graph reads as (liveShape).
function heldOn(data: GraphData, walk: string) {
	const graph = new Graph();
	graph.fromJSON(structuredClone(data));
	return [graph, liveShape(data)].map((view) => {
		const cars = [...view.segments.values()].filter((x) => x.id !== walk);
		return crossingsHeldBy(
			view as never,
			view.segments.get(walk)! as never,
			cars as never,
			new Set()
		).length;
	});
}

test('which end of a curved road a footpath lies past is read square to its curve, its handle as stored', () => {
	// The far end and the handle: a short road bent hard, and a long one
	// leaving its start square to its handle, its first chords long.
	for (const lanes of ['street', 'avenue', 'highway', 'lane'])
		for (const reversed of [false, true])
			for (const [bx, by, cx, cy] of [
				[100, 0, 0, 30],
				[100, 0, 0, -30],
				[100, 0, 30, 45],
				[100, 0, 70, -20],
				[900, 1000, 100, 0],
				[900, -1000, 100, 0]
			])
				for (const [start, finish] of [
					[0, 0],
					[2, -2],
					[15, 15],
					[-15, -15]
				])
					for (const end of [0, 1]) {
						// Bent no tighter than the road is wide, its shift included.
						const k = Math.max(1, (getTotalWidth(preset(lanes)) + 2 * Math.abs(start)) / 12);
						const [p0, p1] = [n('p0', 0, 0), n('p1', bx * k, by * k)];
						const shape = {
							controlX: cx * k,
							controlY: cy * k,
							offsetStart: start,
							offsetEnd: finish
						};
						const car = s(
							'car',
							reversed ? 'p1' : 'p0',
							reversed ? 'p0' : 'p1',
							preset(lanes),
							shape
						);
						// The end, the way the road runs into it there (its curve's
						// tangent) and its normal, from the end of its shown line.
						const e = end ? p1 : p0;
						const [a, b] = reversed ? [p1, p0] : [p0, p1];
						const o = shownAt(shape, a, b, (end === 1) !== reversed ? 1 : 0).point;
						const l = Math.hypot(cx * k - e.x, cy * k - e.y);
						const t = { x: (cx * k - e.x) / l, y: (cy * k - e.y) / l };
						const nn = { x: -t.y, y: t.x };
						const far = getTotalWidth(car.lanes) / 2 + 10;
						const at = (along: number, across: number) => ({
							x: o.x + t.x * along + nn.x * across,
							y: o.y + t.y * along + nn.y * across
						});
						const pt = (id: string, p: Pt) => n(id, p.x, p.y);
						// Across the road 3 m in from its end, its width all inside the
						// end; and along it in through its dead end.
						const data: GraphData = {
							nodes: [
								p0,
								p1,
								pt('a0', at(3, -far)),
								pt('a1', at(3, far)),
								pt('d0', at(-20, 0.01)),
								pt('d1', at(4, 0.01))
							],
							segments: [car, s('across', 'a0', 'a1'), s('in', 'd0', 'd1')]
						};
						const label = `${lanes} ${reversed} ${bx},${by} ${cx},${cy} ${start},${finish} ${end}`;
						expect([label, heldOn(data, 'across')]).toEqual([label, [1, 1]]);
						expect([label, heldOn(data, 'in')]).toEqual([label, [0, 0]]);
					}
});
