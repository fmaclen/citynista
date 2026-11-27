import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { createLanesFrom } from '../src/lib/core/lane-template';
import type { GraphData, JunctionData, Lane } from '../src/lib/core/types';
import { buildModel, carDiff, carPart, readScene, withoutFootpaths } from './model';

// The car roads are built as if no footpath were drawn (core/networks.ts):
// for every scene, the neighbourhood example and the graphs below,
// everything about the car roads but their paint (roads, trims, lane paths,
// junction outlines, connections, every surface) is what the same graph
// draws with its footpaths, and the edits naming them, taken away.

const preset = (id: string, width?: number): Lane[] =>
	createLanesFrom(id).map((l, i) => ({ ...l, id: `l${i}`, ...(width && { width }) }));
const node = (id: string, x: number, y: number, junction?: JunctionData) => ({
	id,
	x,
	y,
	junction
});
const road = (id: string, a: string, b: string, lanes: Lane[], more = {}) => ({
	id,
	startNodeId: a,
	endNodeId: b,
	lanes,
	...more
});
const street = preset('street');
const path = preset('path', 3);
const median: Lane = {
	id: 'med',
	role: 'buffer',
	material: 'grass',
	width: 3,
	direction: 'bidirectional'
};
const divided = [street[1], median, street[2]];

// Graphs where a footpath's edits sit beside the car roads' at a node, or a
// footpath crosses where a car road's paint stands back from it.
const edited: [string, GraphData][] = [
	[
		'a footpath across a controlled divided road at its stop line',
		{
			nodes: [
				node('w', -60, 0),
				node('j', 0, 0, { control: { 'west:end': 'stop' } }),
				node('e', 60, 0),
				node('n', 0, -60),
				node('p', -5.1, -16),
				node('q', -5.1, 16)
			],
			segments: [
				road('west', 'w', 'j', divided),
				road('east', 'j', 'e', divided),
				road('north', 'j', 'n', street.slice(1, 3)),
				road('path', 'p', 'q', path)
			]
		}
	],
	[
		'a footpath with its own setback where a street bends',
		{
			nodes: [
				node('w', -60, 0),
				node('a', 0, 0, { setbacks: { mid: 13 } }),
				node('b', 18, 0, { setbacks: { south: 8.85 } }),
				node('e', 40, 40),
				node('n', 18, -30),
				node('s', 18, 30)
			],
			segments: [
				road('left', 'w', 'a', street),
				road('mid', 'a', 'b', street),
				road('right', 'b', 'e', street),
				road('north', 'n', 'b', path),
				road('south', 'b', 's', path)
			]
		}
	],
	[
		'a footpath joined by hand to the sidewalk of a street carrying on',
		{
			nodes: [
				node('a', -60, 0),
				node('m', 0, 0, {
					added: [
						{
							from: { road: 'path', end: 'start', lane: 'l0' },
							to: { road: 'west', end: 'end', lane: 'l0' }
						}
					]
				}),
				node('e', 60, 0),
				node('p', 32, 10)
			],
			segments: [
				road('west', 'a', 'm', street),
				road('east', 'm', 'e', street),
				road('path', 'm', 'p', path)
			]
		}
	]
];

const graphs: [string, GraphData][] = [
	...readdirSync('e2e/scenes').map((file): [string, GraphData] => [
		file,
		readScene(file.replace('.json', ''))
	]),
	['neighbourhood', JSON.parse(readFileSync('static/examples/neighbourhood.json', 'utf8')).graph],
	...edited
];

const car = (lanes: { role: string }[]) => lanes.some((l) => l.role === 'vehicle');

// The car part of a graph's model, and its car segments' spans.
function cars(graph: GraphData) {
	const { derived, scene } = buildModel(graph);
	const ids = new Set(graph.segments.filter((s) => car(s.lanes)).map((s) => s.id));
	return { part: carPart(scene), spans: [...derived.spans].filter(([id]) => ids.has(id)) };
}

for (const [name, graph] of graphs) {
	if (graph.segments.every((s) => car(s.lanes))) continue;
	test(`the car roads of ${name} are drawn as if it had no footpaths`, () => {
		const [all, alone] = [cars(graph), cars(withoutFootpaths(graph))];
		expect(carDiff(all.part, alone.part)).toEqual([]);
		expect(all.spans).toEqual(alone.spans);
	}, 30_000);
}
