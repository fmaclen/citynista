import { expect, test } from 'bun:test';
import { splitSegment } from '../src/lib/core/crossings';
import { Graph } from '../src/lib/core/graph.svelte';
import { Segment, type SegmentWrites } from '../src/lib/core/segment.svelte';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { carries } from '../src/lib/core/lane-types';
import type { GraphData, Lane } from '../src/lib/core/types';

// A node holds car roads or footpaths, never both, and the Graph keeps it so
// on every edit, whichever tool makes it (Graph.createSegment, a segment's
// lanes replaced through Graph.setLanes, a road cut at a node): the roads that
// stood at a node stay there, those just added or turned into the other
// kind take a node of their own at the same place. Each of the graph's own
// mutators is driven here with every combination of kinds; after each no
// node holds both, no car node or car segment that was there changed (but
// one the edit itself turned into a footpath), and the graph reads back from
// its saved form as it is (undo and redo restore a saved graph).

const lanes = (kind: Kind): Lane[] =>
	createLanesFrom(kind === 'car' ? 'street' : 'path').map((l, i) => ({ ...l, id: `l${i}` }));
type Kind = 'car' | 'walk';
const KINDS: Kind[] = ['car', 'walk'];
// Where a new road may end: a node holding car roads, one holding
// footpaths, or a new node holding nothing.
type At = Kind | 'empty';
const ATS: At[] = ['car', 'walk', 'empty'];

// A street from c to c2 and a footpath from w to w2 running alongside it,
// and two more of each joined end to end at their middle nodes (cm, wm).
// Two car nodes hold edits, as stored, an empty list too: an edit at them
// that the footpaths take leaves them byte for byte.
function base() {
	const graph = new Graph();
	const data: GraphData = {
		nodes: [
			{ id: 'c', x: 0, y: 0, junction: { added: [], removed: [] } },
			{ id: 'c2', x: 60, y: 0 },
			{ id: 'w', x: 0, y: 40 },
			{ id: 'w2', x: 60, y: 40 },
			{ id: 'ca', x: -60, y: 100 },
			{ id: 'cm', x: 0, y: 100, junction: { removed: [], setbacks: { 'car-b': 3 } } },
			{ id: 'cb', x: 60, y: 100 },
			{ id: 'wa', x: -60, y: 140 },
			{ id: 'wm', x: 0, y: 140 },
			{ id: 'wb', x: 60, y: 140 }
		],
		segments: [
			{ id: 'street', startNodeId: 'c', endNodeId: 'c2', lanes: lanes('car') },
			{ id: 'path', startNodeId: 'w', endNodeId: 'w2', lanes: lanes('walk') },
			{ id: 'car-a', startNodeId: 'ca', endNodeId: 'cm', lanes: lanes('car') },
			{ id: 'car-b', startNodeId: 'cm', endNodeId: 'cb', lanes: lanes('car') },
			{ id: 'walk-a', startNodeId: 'wa', endNodeId: 'wm', lanes: lanes('walk') },
			{ id: 'walk-b', startNodeId: 'wm', endNodeId: 'wb', lanes: lanes('walk') }
		]
	};
	graph.fromJSON(data);
	return graph;
}

const nodeOf = (graph: Graph, at: At) =>
	at === 'car' ? 'c' : at === 'walk' ? 'w' : graph.createNode(30, -30).id;

// The car part of a graph: each car segment as saved, and each node holding
// car roads with the car roads it lists.
function cars(graph: Graph) {
	const segments = [...graph.segments.values()].filter((s) => carries(s.lanes));
	return {
		segments: new Map(segments.map((s) => [s.id, JSON.stringify(s.toJSON())])),
		nodes: new Map(
			[...graph.nodes.values()].flatMap((n) => {
				const here = n.connectedSegments.filter((id) => segments.some((s) => s.id === id));
				return here.length ? [[n.id, JSON.stringify([n.x, n.y, n.junction, here])] as const] : [];
			})
		)
	};
}

const mixed = (graph: Graph) =>
	[...graph.nodes.values()]
		.filter((n) => {
			const kinds = new Set(n.connectedSegments.map((s) => carries(graph.segments.get(s)!.lanes)));
			return kinds.size > 1;
		})
		.map((n) => n.id);

// Whether every car segment and car node there before an edit is as it was,
// but the segments the edit turned from car roads into footpaths (`turned`)
// and the nodes holding only those.
function unchanged(before: ReturnType<typeof cars>, graph: Graph, turned: string[] = []) {
	const now = cars(graph);
	const lost: string[] = [];
	for (const [id, json] of before.segments)
		if (!turned.includes(id) && now.segments.get(id) !== json) lost.push(`segment ${id}`);
	for (const [id, json] of before.nodes) {
		const [x, y, junction, here] = JSON.parse(json) as [number, number, unknown, string[]];
		const kept = here.filter((s) => !turned.includes(s));
		if (!kept.length) continue;
		const at = now.nodes.get(id);
		const [nx, ny, nj, nhere] = at ? (JSON.parse(at) as [number, number, unknown, string[]]) : [];
		const same =
			nx === x &&
			ny === y &&
			JSON.stringify(nj) === JSON.stringify(junction) &&
			kept.every((s) => nhere?.includes(s));
		if (!same) lost.push(`node ${id}`);
	}
	return lost;
}

// After an edit: no node holding both kinds, the car roads as they were,
// and the graph read back from its saved form as it is.
function holds(label: string, graph: Graph, before: ReturnType<typeof cars>, turned?: string[]) {
	expect([label, mixed(graph)]).toEqual([label, []]);
	expect([label, unchanged(before, graph, turned)]).toEqual([label, []]);
	const saved = graph.toJSON();
	const again = new Graph();
	again.fromJSON(structuredClone(saved));
	expect([label, again.toJSON()]).toEqual([label, saved]);
}

test('a road added between nodes of any kinds leaves no node holding both, and the car roads as they were', () => {
	for (const kind of KINDS)
		for (const from of ATS)
			for (const to of ATS) {
				const graph = base();
				const before = cars(graph);
				const [a, b] = [nodeOf(graph, from), nodeOf(graph, to)];
				if (a === b) continue;
				const label = `a ${kind} road from a ${from} node to a ${to} node`;
				const s = graph.createSegment(a, b, lanes(kind));
				holds(label, graph, before);
				// It still ends where it was drawn, on a node of its own kind.
				for (const [id, was] of [
					[s.startNodeId, a],
					[s.endNodeId, b]
				]) {
					const [node, at] = [graph.nodes.get(id)!, graph.nodes.get(was)!];
					expect([label, node.x, node.y]).toEqual([label, at.x, at.y]);
					expect([label, (from === kind || from === 'empty') === (s.startNodeId === a)]).toEqual([
						label,
						true
					]);
				}
			}
});

test("a road's lanes replaced by the other kind's leaves no node holding both, and the other car roads as they were", () => {
	for (const id of ['street', 'path', 'car-a', 'walk-a']) {
		const graph = base();
		const before = cars(graph);
		const s = graph.segments.get(id)!;
		const kind: Kind = carries(s.lanes) ? 'walk' : 'car';
		graph.setLanes([[s, lanes(kind)]]);
		holds(`${id} made a ${kind} road`, graph, before, kind === 'walk' ? [id] : []);
		// Joined end to end, the one turned takes a node of its own; the one
		// left keeps theirs.
		if (id === 'car-a') expect(graph.segments.get('car-b')!.startNodeId).toBe('cm');
		if (id === 'walk-a') expect(graph.segments.get('walk-b')!.startNodeId).toBe('wm');
		if (id === 'car-a' || id === 'walk-a')
			expect(s.endNodeId).not.toBe(id === 'car-a' ? 'cm' : 'wm');
	}
});

test('roads given new lanes together stay joined to each other, and leave no node holding both', () => {
	const cases: [string, [string, Kind][], [string, string] | null][] = [
		[
			'two joined car roads made footpaths',
			[
				['car-a', 'walk'],
				['car-b', 'walk']
			],
			['car-a', 'car-b']
		],
		[
			'two joined footpaths made car roads',
			[
				['walk-a', 'car'],
				['walk-b', 'car']
			],
			['walk-a', 'walk-b']
		],
		['one of two joined car roads made a footpath', [['car-a', 'walk']], null],
		[
			'joined footpaths and car roads swapped',
			[
				['walk-a', 'car'],
				['car-a', 'walk']
			],
			null
		]
	];
	for (const [label, changes, together] of cases) {
		const graph = base();
		const before = cars(graph);
		graph.setLanes(changes.map(([id, kind]) => [graph.segments.get(id)!, lanes(kind)] as const));
		const turned = changes.filter(([, k]) => k === 'walk').map(([id]) => id);
		holds(label, graph, before, turned);
		if (together) {
			const [a, b] = together.map((id) => graph.segments.get(id)!);
			expect([label, a.endNodeId]).toEqual([label, b.startNodeId]);
		}
	}
});

test('a road cut at a node holding the other kind is cut at a node of its own there', () => {
	for (const [road, at] of [
		['path', 'cm'],
		['street', 'wm']
	] as const) {
		const graph = base();
		const before = cars(graph);
		const s = graph.segments.get(road)!;
		const node = graph.nodes.get(at)!;
		const halves = splitSegment(graph, s, 0.5, node.id)!;
		const label = `${road} cut at ${at}`;
		holds(label, graph, before, road === 'street' ? ['street'] : []);
		expect([label, halves.left.endNodeId]).toEqual([label, halves.right.startNodeId]);
		expect([label, halves.left.endNodeId === at]).toEqual([label, false]);
	}
});

test('a graph saved with a node holding both kinds reads as two nodes there, the car roads as they were', () => {
	const data = base().toJSON();
	data.segments.push({ id: 'onto', startNodeId: 'w2', endNodeId: 'c2', lanes: lanes('walk') });
	const graph = new Graph();
	graph.fromJSON(data);
	expect(mixed(graph)).toEqual([]);
	expect(graph.segments.get('street')!.endNodeId).toBe('c2');
	expect(graph.segments.get('onto')!.endNodeId).not.toBe('c2');
});

// A crossing is paint and stores nothing, and a footpath node holds no
// edits: one saved holding a crossing's control, or any other edit, reads as
// a plain footpath node.
test("a footpath node saved holding a crossing's control or a setback reads without either", () => {
	const data = base().toJSON();
	const at = (id: string) => data.nodes.find((n) => n.id === id)!;
	at('w').junction = { control: { crossing: 'stop' } } as never;
	at('wm').junction = { control: { crossing: 'yield' }, setbacks: { 'walk-b': 2 } } as never;
	const graph = new Graph();
	graph.fromJSON(data);
	expect(graph.nodes.get('w')!.junction).toBeUndefined();
	expect(graph.nodes.get('wm')!.junction).toBeUndefined();
	expect(graph.segments.get('path')!.startNodeId).toBe('w');
	expect(graph.nodes.size).toBe(data.nodes.length);
});

// What the rule rests on (the nodes each segment ends at, the roads each
// node lists, each segment's lanes and their roles) is written only through
// the graph's own mutators: whatever is reached through what
// core/graph.svelte.ts and core/segment.svelte.ts export refuses to be
// written, and the graph is left as it was.
test("the graph's rule can't be bypassed through what it hands out", () => {
	const graph = base();
	const saved = JSON.stringify(graph.toJSON());
	const street = graph.segments.get('street')!;
	const path = graph.segments.get('path')!;
	const node = graph.nodes.get('c')!;
	const attempts: [string, () => void][] = [
		['an end set', () => ((street as { startNodeId: string }).startNodeId = 'w')],
		['the other end set', () => ((path as { endNodeId: string }).endNodeId = 'c')],
		['lanes set', () => ((street as unknown as { lanes: Lane[] }).lanes = lanes('walk'))],
		['a lane role changed', () => ((street.lanes[1] as Lane).role = 'pedestrian')],
		['a lane added', () => (street.lanes as Lane[]).push(lanes('car')[1])],
		['a road listed at a node', () => (node.connectedSegments as string[]).push('path')],
		[
			'a segment put in the map',
			() => (graph.segments as Map<string, unknown>).set('x', new Segment('x', 'c', 'w', []))
		],
		['a node taken out of the map', () => (graph.nodes as Map<string, unknown>).delete('c')]
	];
	for (const [label, attempt] of attempts) {
		expect(attempt).toThrow();
		expect([label, mixed(graph)]).toEqual([label, []]);
		expect([label, JSON.stringify(graph.toJSON())]).toEqual([label, saved]);
	}
	// A segment made outside the graph writes only itself.
	let writes: SegmentWrites | null = null;
	const own = new Segment('own', 'c', 'w', lanes('walk'), (w) => (writes = w));
	writes!.ends('w', 'c');
	expect([own.startNodeId, graph.segments.has('own')]).toEqual(['w', false]);
	expect(JSON.stringify(graph.toJSON())).toBe(saved);
});

test('a mutator that fails part-way leaves the graph as it was', () => {
	const graph = base();
	const saved = JSON.stringify(graph.toJSON());
	const [carA, walkA] = [graph.segments.get('car-a')!, graph.segments.get('walk-a')!];
	const failures: [string, () => void][] = [
		[
			'setLanes with changes that fail after the first',
			() =>
				graph.setLanes(
					(function* () {
						yield [carA, lanes('walk')] as const;
						throw new Error('no next change');
					})()
				)
		],
		[
			'setLanes with a second change that is no lane list',
			() =>
				graph.setLanes([
					[carA, lanes('walk')],
					[walkA, null as unknown as Lane[]]
				])
		],
		[
			'setLanes with a segment of another graph',
			() =>
				graph.setLanes([
					[carA, lanes('walk')],
					[base().segments.get('walk-a')!, lanes('car')]
				])
		],
		['createSegment with no lane list', () => graph.createSegment('c', 'w', null as never)],
		[
			'fromJSON with a segment that has no lane list',
			() =>
				graph.fromJSON({
					nodes: [{ id: 'a', x: 0, y: 0 }],
					segments: [{ id: 's', startNodeId: 'a', endNodeId: 'a', lanes: null as never }]
				})
		]
	];
	for (const [label, fail] of failures) {
		expect(fail).toThrow();
		expect([label, mixed(graph)]).toEqual([label, []]);
		expect([label, JSON.stringify(graph.toJSON())]).toEqual([label, saved]);
	}
	// Still whole: the graph's next edit keeps the rule as ever.
	graph.setLanes([[carA, lanes('walk')]]);
	expect(mixed(graph)).toEqual([]);
});
