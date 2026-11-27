import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { GraphData } from '../src/lib/core/types';
import { check } from '../src/lib/road-model/checks';
import { buildModel, readScene } from './model';

// Car-only cities draw as they did before footpaths were a network of their
// own: every scene's car roads, its footpaths taken away, and the graphs
// below are built into the model recorded in unit/car-only.json (each road's
// drawn ends, and each junction's nodes: a road merged away is drawn by
// none). The hairpins, whose tight pieces the room each node of two roads
// leaves the other decides, also hold to what the drawing checks
// (road-model/checks.ts) found in them before (`checks`). RECORD=1 writes
// the file afresh from the model as it builds now; RECORD=<name>,<name>
// writes only those graphs.

const FILE = 'unit/car-only.json';

const street = [
	{ role: 'pedestrian', material: 'concrete', width: 2, direction: 'bidirectional' },
	{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'backward' },
	{ role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' },
	{ role: 'pedestrian', material: 'concrete', width: 2, direction: 'bidirectional' }
] as GraphData['segments'][number]['lanes'];

// A street doubling back on itself through a short piece: two nodes whose
// roads leave each within a right angle of each other, close enough to
// merge.
const hairpin: GraphData = {
	nodes: [
		{ id: 'p', x: 38, y: -10 },
		{ id: 'q', x: 0, y: 0 },
		{ id: 'r', x: 7, y: 0 },
		{ id: 's', x: 8, y: 40 }
	],
	segments: [
		{ id: 'left', startNodeId: 'p', endNodeId: 'q', lanes: street },
		{ id: 'link', startNodeId: 'q', endNodeId: 'r', lanes: street },
		{ id: 'right', startNodeId: 'r', endNodeId: 's', lanes: street }
	]
};

// A graph's car roads and the nodes they meet at.
function carsOf(graph: GraphData): GraphData {
	const segments = graph.segments.filter((s) => s.lanes.some((l) => l.role === 'vehicle'));
	const used = new Set(segments.flatMap((s) => [s.startNodeId, s.endNodeId]));
	return { nodes: graph.nodes.filter((n) => used.has(n.id)), segments };
}

// The same, its short piece 5 m long: its two nodes merge.
const tighter: GraphData = {
	nodes: hairpin.nodes.map((n) =>
		n.id === 'r' ? { ...n, x: 5 } : n.id === 's' ? { ...n, x: 6 } : n
	),
	segments: hairpin.segments
};

const graphs: [string, GraphData][] = [
	['hairpin', hairpin],
	['tighter hairpin', tighter],
	...readdirSync('e2e/scenes')
		.filter((f) => f.endsWith('.json'))
		.sort()
		.map((f): [string, GraphData] => [f, carsOf(readScene(f.slice(0, -5)))])
];

const round = (v: number) => Math.round(v * 1000) / 1000;

function modelOf(graph: GraphData, checked: boolean) {
	const { derived, scene } = buildModel(graph);
	const ends = (id: string) => {
		const pts = derived.geos.get(id)?.path.pts ?? [];
		return [pts[0], pts.at(-1)].map((p) => p && [round(p.x), round(p.y)]);
	};
	return {
		roads: derived.place.roads.map((r) => [r.id, ...ends(r.id)]),
		junctions: derived.place.junctions.map((j) => [...(j.members ?? [j.id])].sort()).sort(),
		...(checked && { checks: check(scene) })
	};
}

const checked = new Set(['hairpin', 'tighter hairpin']);
const models = Object.fromEntries(graphs.map(([name, g]) => [name, modelOf(g, checked.has(name))]));
const only = process.env.RECORD?.split(',');
if (only) {
	const was = JSON.parse(readFileSync(FILE, 'utf8'));
	const keep = (name: string) => only[0] === '1' || only.includes(name);
	const out = Object.fromEntries(
		graphs.map(([name]) => [name, keep(name) ? models[name] : was[name]])
	);
	writeFileSync(FILE, JSON.stringify(out, null, '\t') + '\n');
}
const recorded = JSON.parse(readFileSync(FILE, 'utf8'));

for (const [name] of graphs)
	test(`${name}: its car roads draw as before`, () => {
		expect(models[name]).toEqual(recorded[name]);
	});
