import { expect, test } from 'bun:test';
import { sideToward } from '../src/lib/core/attach';
import { splitSegment, type ShownRoads } from '../src/lib/core/crossings';
import { Graph } from '../src/lib/core/graph.svelte';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { Networks } from '../src/lib/core/networks';
import { roadAt } from '../src/lib/core/road-line';
import type { GraphData } from '../src/lib/core/types';
import { fromPath, toPath } from '../src/lib/road-model/clip';
import { Drawing, type Over } from '../src/lib/road-model/drawing';
import { type Box, boxOf, type Crossed, overlap } from '../src/lib/road-model/overlay';
import { describeRoad } from '../src/lib/road-model/road';
import { buildModel, liveShape } from './model';

// Reading the roads as an edit would leave them (Networks.shownIn, what a
// drop held over its marker is checked against) reads what the edit
// changes, whatever the size of the map: a footpath's line is made of its
// own nodes alone, so the footpaths it runs on into through nodes of two
// are not read.

// A zigzag footpath of `n` segments, and a street beside it.
const zigzag = (n: number): GraphData => ({
	nodes: [
		...Array.from({ length: n + 1 }, (_, k) => ({ id: `n${k}`, x: k * 10, y: k % 2 ? 6 : 0 })),
		{ id: 'w', x: -40, y: -30 },
		{ id: 'e', x: 40, y: -30 }
	],
	segments: [
		...Array.from({ length: n }, (_, k) => ({
			id: `s${k}`,
			startNodeId: `n${k}`,
			endNodeId: `n${k + 1}`,
			lanes: [
				{
					role: 'pedestrian' as const,
					material: 'concrete' as const,
					width: 2,
					direction: 'bidirectional' as const
				}
			]
		})),
		{
			id: 'street',
			startNodeId: 'w',
			endNodeId: 'e',
			lanes: [
				{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'backward' },
				{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' }
			]
		}
	]
});

// How many segments reading the graph as an edit of its first footpath
// segments would leave it looks up.
const lookups = (n: number) => {
	const graph = liveShape(zigzag(n));
	const networks = new Networks();
	networks.build(graph as never);
	let count = 0;
	const segments = new Map(graph.segments);
	const get = segments.get.bind(segments);
	segments.get = (id: string) => {
		count++;
		return get(id);
	};
	const roads = networks.shownIn({ nodes: graph.nodes, segments } as never, ['s0', 's1', 's2']);
	expect([...roads.relined]).toEqual([]);
	return count;
};

test('reading a footpath edit as it will show reads as much on a long footpath as on a short one', () => {
	expect(lookups(200)).toBe(lookups(20));
});

// Swept: chains of car roads, each a road of its own bending at every node
// (sharply, gently, every other one stored backward), or one straight road
// cut in pieces, no end attached anywhere, read as an edit of their first
// segments, look up as much on a long chain as a short one; and for those
// and a road, bowed or straight, cut in pieces whose first piece ends
// attached at an edge of a cross street (so its end is placed as the whole
// road places it), each edit read as it will show shows every road's line
// as a fresh build of the edited graph draws it.
const carLanes = () => [
	{
		role: 'vehicle' as const,
		material: 'asphalt' as const,
		width: 3.5,
		direction: 'backward' as const
	},
	{
		role: 'vehicle' as const,
		material: 'asphalt' as const,
		width: 3.5,
		direction: 'forward' as const
	}
];
const carChain = (n: number, rise: number, flip: boolean): GraphData => ({
	nodes: Array.from({ length: n + 1 }, (_, k) => ({ id: `n${k}`, x: k * 10, y: k % 2 ? rise : 0 })),
	segments: Array.from({ length: n }, (_, k) => {
		const back = flip && k % 2 === 1;
		return {
			id: `s${k}`,
			startNodeId: back ? `n${k + 1}` : `n${k}`,
			endNodeId: back ? `n${k}` : `n${k + 1}`,
			lanes: carLanes()
		};
	})
});
const chainLookups = (data: GraphData) => {
	const graph = liveShape(data);
	const networks = new Networks();
	networks.build(graph as never);
	let count = 0;
	const segments = new Map(graph.segments);
	const get = segments.get.bind(segments);
	segments.get = (id: string) => {
		count++;
		return get(id);
	};
	networks.shownIn({ nodes: graph.nodes, segments } as never, ['s0', 's1', 's2']);
	return count;
};
for (const [rise, flip] of [
	[6, false],
	[0.6, false],
	[6, true],
	[0, false],
	[0, true]
] as const)
	test(`reading an edit of a chain of car ${rise ? `bends rising ${rise} m` : 'pieces in line'}${flip ? ', every other stored backward,' : ''} reads as much on a long chain as a short one`, () => {
		expect(chainLookups(carChain(200, rise, flip))).toBe(chainLookups(carChain(20, rise, flip)));
	});

// A road from (0, 0) bowed through (60, `bow`) to (120, 0), cut in
// `pieces`, its first piece ending at (0, 0) attached at the east edge of a
// cross street there.
const attachedChain = (pieces: number, bow = 40) => {
	const graph = new Graph();
	graph.fromJSON({
		nodes: [
			{ id: 'o', x: 0, y: 0 },
			{ id: 'xa', x: 0, y: -50 },
			{ id: 'xb', x: 0, y: 50 },
			{ id: 'e', x: 120, y: 0 }
		],
		segments: [
			{ id: 'xs', startNodeId: 'xa', endNodeId: 'o', lanes: createLanesFrom('avenue') },
			{ id: 'xn', startNodeId: 'o', endNodeId: 'xb', lanes: createLanesFrom('avenue') },
			{
				id: 'road',
				startNodeId: 'o',
				endNodeId: 'e',
				lanes: carLanes(),
				...(bow && { controlX: 60, controlY: bow })
			}
		]
	});
	const side = sideToward(graph, graph.segments.get('road')!, 'o', { x: 1, y: 0 })!;
	graph.nodes.get('o')!.junction = { sides: { road: side } };
	let last = graph.segments.get('road')!;
	for (let k = pieces; k > 1; k--) {
		const at = roadAt(graph, last, 1 / k)!.line;
		last = splitSegment(graph, last, 1 / k, graph.createNode(at.x, at.y).id)!.right;
	}
	return graph;
};
const lineOf = (roads: ShownRoads, id: string) => JSON.stringify(roads.road(id)?.line ?? null);
test('an edit read as it will show shows each car road where a fresh build draws it', () => {
	const wrong: string[] = [];
	const cases: [string, () => Graph][] = [
		...([6, 0.6, 0].map((rise) => [
			`bends rising ${rise}`,
			() => {
				const g = new Graph();
				g.fromJSON(carChain(8, rise, true));
				return g;
			}
		]) as [string, () => Graph][]),
		...[2, 4].map((k): [string, () => Graph] => [
			`a road in ${k} attached`,
			() => attachedChain(k)
		]),
		['a straight road in 4 attached', () => attachedChain(4, 0)]
	];
	for (const [name, make] of cases) {
		const graph = make();
		const ids = [...graph.segments.keys()];
		// Each edit: one segment's far node moved a metre.
		for (const id of ids) {
			const s = graph.segments.get(id)!;
			for (const nodeId of [s.startNodeId, s.endNodeId]) {
				const networks = new Networks();
				networks.build(graph);
				const node = graph.nodes.get(nodeId)!;
				node.x += 1;
				const changed = new Set([id, ...node.connectedSegments]);
				const trial = networks.shownIn(graph, changed);
				const fresh = new Networks();
				fresh.build(graph);
				const now = fresh.shown();
				for (const other of ids)
					if (lineOf(trial, other) !== lineOf(now, other))
						wrong.push(`${name}: ${nodeId} moved, ${other}`);
				node.x -= 1;
			}
		}
	}
	expect(wrong).toEqual([]);
});

// Painting a long street again after one of the crossings on it moved reads,
// of every other crossing on it, what drawing the street itself reads and
// no more, however many there are: where traffic meeting each is held is
// decided again only where something it read changed (the moved one reads
// the crossings near it alone), and kept from paint to paint otherwise.
// The crossings are laid over it as core/networks.ts lays them: each found
// by its box, keyed by its id and version.
const othersRead = (n: number) => {
	const lanes = [
		{
			role: 'pedestrian' as const,
			material: 'concrete' as const,
			width: 2,
			direction: 'bidirectional' as const
		},
		...carLanes(),
		{
			role: 'pedestrian' as const,
			material: 'concrete' as const,
			width: 2,
			direction: 'bidirectional' as const
		}
	].map((l, k) => ({ ...l, id: `l${k}` }));
	const { derived } = buildModel({
		nodes: [
			{ id: 'w', x: 0, y: 0 },
			{ id: 'e', x: 1000, y: 0 }
		],
		segments: [{ id: 'road', startNodeId: 'w', endNodeId: 'e', lanes }]
	});
	const reads = new Map<string, number>();
	const boxes = new Map<Crossed, Box>();
	const crossing = (id: string, x: number) => {
		const rings = [
			toPath([
				{ x: x - 1, y: -3.5 },
				{ x: x + 1, y: -3.5 },
				{ x: x + 1, y: 3.5 },
				{ x: x - 1, y: 3.5 }
			])
		];
		const c: Crossed = {
			id,
			along: { x: 1, y: 0 },
			stripes: { mid: 0, wide: 7 },
			traffic: true,
			on: ['road'],
			across: { roads: ['road'], lanes: ['l1', 'l2'] },
			control: { kind: 'yield', at: { x, y: 0 } },
			get rings() {
				reads.set(id, (reads.get(id) ?? 0) + 1);
				return rings;
			}
		};
		boxes.set(c, boxOf(fromPath(rings[0])));
		return c;
	};
	const versions = new Map<Crossed, number>();
	const overOf =
		(ground: Crossed[]): Over =>
		(box, id) => {
			const near = ground.filter((c) => c.on!.includes(id) && overlap(boxes.get(c)!, box));
			for (const c of near) if (!versions.has(c)) versions.set(c, versions.size);
			return { ground: near, key: near.map((c) => `${c.id}:${versions.get(c)}`).join('&') };
		};
	const others = Array.from({ length: n - 1 }, (_, k) => crossing(`c${k + 1}`, 70 + 20 * k));
	const first = crossing('c0', 50);
	const drawing = new Drawing(derived.place, derived.geos);
	drawing.build();
	drawing.paint(overOf([first, ...others]), [...boxes.values()]);
	const moved = crossing('c0', 51);
	reads.clear();
	drawing.build();
	drawing.paint(overOf([moved, ...others]), [boxes.get(first)!, boxes.get(moved)!]);
	const painted = others.map((c) => reads.get(c.id!) ?? 0);
	// What drawing the street with them reads of each.
	reads.clear();
	const geo = derived.geos.get('road')!;
	const free = { paint: 0, nose: null };
	describeRoad(geo.road, geo.path, { start: free, end: free }, [moved, ...others]);
	return { painted, own: others.map((c) => reads.get(c.id!) ?? 0) };
};

test('a crossing moved on a long street reads no other crossing past what drawing the street does', () => {
	for (const n of [5, 40]) {
		const { painted, own } = othersRead(n);
		expect([n, painted]).toEqual([n, own]);
	}
});
