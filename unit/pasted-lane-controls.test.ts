import { expect, test } from 'bun:test';
import { controlOf } from '../src/lib/core/crossing-controls';
import { carriagewaysOf } from '../src/lib/core/attach';
import { Graph } from '../src/lib/core/graph.svelte';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { Networks } from '../src/lib/core/networks';
import type { Lane } from '../src/lib/core/types';

// Lanes pasted onto a car road carry each crossing control to the
// carriageway counted the same from the road's edge, however many of the
// road's segments are pasted onto at once and whatever ids the pasted lanes
// hold: a street cut in two, its left carriageway's crossing set to stop,
// keeps the stop on its left carriageway alone.

const lane = (id: string, role: Lane['role']): Lane => ({
	id,
	role,
	material: role === 'vehicle' ? 'asphalt' : 'concrete',
	width: role === 'vehicle' ? 3.5 : 2,
	direction: role === 'vehicle' ? 'forward' : 'bidirectional'
});
// A street with a walkway down its middle, its car lanes `left` and `right`.
const divided = (left: string, right: string) => [
	lane('w0', 'pedestrian'),
	lane(left, 'vehicle'),
	lane('mid', 'pedestrian'),
	lane(right, 'vehicle'),
	lane('w1', 'pedestrian')
];

test('lanes pasted onto both halves of a divided street keep a stop on its left carriageway alone', () => {
	const graph = new Graph();
	graph.fromJSON({
		nodes: [
			{ id: 'w', x: -40, y: 0 },
			{ id: 'm', x: 0, y: 0 },
			{ id: 'e', x: 40, y: 0 },
			{ id: 'p', x: -10, y: -20 },
			{ id: 'q', x: -10, y: 20 }
		],
		segments: [
			{ id: 'west', startNodeId: 'w', endNodeId: 'm', lanes: divided('a', 'b') },
			{ id: 'east', startNodeId: 'm', endNodeId: 'e', lanes: divided('a', 'b') },
			{
				id: 'path',
				startNodeId: 'p',
				endNodeId: 'q',
				lanes: createLanesFrom('path'),
				controls: [{ roads: ['east', 'west'], lanes: ['a'], control: 'stop' }]
			}
		]
	});
	const pasted = divided('b', 'a');
	graph.setLanes(
		['west', 'east'].map((id) => [graph.segments.get(id)!, pasted] as const),
		true
	);
	const stored = graph.segments.get('path')!.controls;
	const [left, right] = carriagewaysOf(graph.segments.get('west')!.lanes);
	const roads = ['east', 'west'];
	expect(controlOf(stored, { roads, lanes: left.lanes })).toBe('stop');
	expect(controlOf(stored, { roads, lanes: right.lanes })).toBe('yield');
});

// Swept: a divided street cut into two or three pieces, stored either way,
// a footpath across each piece, each with a stop set on the carriageway
// counted `held` from the street's stored left edge; lanes pasted onto any
// set of the pieces, their car lane ids the same, swapped or new. Every
// crossing drawn then reads stop on that carriageway and give-way on the
// other, and saving writes it so.
const stopped = (pieces: number, reversed: boolean, held: number) => {
	const xs = Array.from({ length: pieces + 1 }, (_, k) => -45 + (90 * k) / pieces);
	const ids = xs.slice(1).map((_, k) => `s${k}`);
	const graph = new Graph();
	const lanes = reversed ? divided('a', 'b').reverse() : divided('a', 'b');
	const cars = reversed ? ['b', 'a'] : ['a', 'b'];
	graph.fromJSON({
		nodes: [
			...xs.map((x, k) => ({ id: `n${k}`, x, y: 0 })),
			...ids.flatMap((_, k) => {
				const x = (xs[k] + xs[k + 1]) / 2;
				return [
					{ id: `p${k}`, x: x - 3, y: -20 },
					{ id: `q${k}`, x: x + 3, y: 20 }
				];
			})
		],
		segments: [
			...ids.map((id, k) => ({
				id,
				startNodeId: reversed ? `n${k + 1}` : `n${k}`,
				endNodeId: reversed ? `n${k}` : `n${k + 1}`,
				lanes
			})),
			...ids.map((_, k) => ({
				id: `path${k}`,
				startNodeId: `p${k}`,
				endNodeId: `q${k}`,
				lanes: createLanesFrom('path'),
				controls: [{ roads: [...ids].sort(), lanes: [cars[held]], control: 'stop' as const }]
			}))
		]
	});
	return { graph, ids };
};
// Each crossing footpath k draws over piece k: where its carriageway lies
// on the piece, counted from the stored left edge, and its control.
const readCrossings = (graph: Graph, ids: string[]) => {
	const networks = new Networks();
	networks.build(graph);
	return {
		networks,
		read: ids.map((id, k) =>
			networks
				.crossingsOn([`path${k}`])
				.map((c) => networks.crossingOf(c)!)
				.map((c) => ({
					place: carriagewaysOf(graph.segments.get(id)!.lanes).findIndex((w) =>
						w.lanes.some((l) => c.across.lanes.includes(l))
					),
					control: c.control
				}))
				.sort((p, q) => p.place - q.place)
		)
	};
};
for (const pieces of [2, 3])
	test(`lanes pasted onto any pieces of a divided street in ${pieces} keep each stop on its carriageway`, () => {
		const wrong: string[] = [];
		for (const reversed of [false, true])
			for (const held of [0, 1])
				for (let set = 1; set < 1 << pieces; set++)
					for (const [name, left, right] of [
						['same', 'a', 'b'],
						['swapped', 'b', 'a'],
						['new', 'c', 'd']
					]) {
						const { graph, ids } = stopped(pieces, reversed, held);
						const onto = ids.filter((_, k) => (set >> k) & 1);
						const pasted = reversed ? divided(left, right).reverse() : divided(left, right);
						graph.setLanes(
							onto.map((id) => [graph.segments.get(id)!, pasted] as const),
							true
						);
						const want = ids.map(() =>
							[0, 1].map((place) => ({ place, control: place === held ? 'stop' : 'yield' }))
						);
						const first = readCrossings(graph, ids);
						// Saving writes each footpath's entries as its crossings read.
						for (const [id, kept] of first.networks.settle())
							graph.segments.get(id)!.controls = kept;
						const saved = readCrossings(graph, ids).read;
						const label = `${reversed ? 'reversed, ' : ''}stop at ${held}, ${name} onto ${onto}`;
						if (JSON.stringify(first.read) !== JSON.stringify(want))
							wrong.push(`${label}: ${JSON.stringify(first.read)}`);
						else if (JSON.stringify(saved) !== JSON.stringify(want))
							wrong.push(`${label}, saved: ${JSON.stringify(saved)}`);
					}
		expect(wrong).toEqual([]);
	});
