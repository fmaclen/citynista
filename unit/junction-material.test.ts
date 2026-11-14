import { expect, test } from 'bun:test';
import type { GraphData } from '../src/lib/core/types';
import { buildModel, nodeOf, readScene, segmentOf } from './model';

// A node is paved in the material of the arms with the most car-lane width
// (pavingOf in road-model/drawing.ts). The places of
// e2e/scenes/junction-materials.json, each car lane 5 m unless said:
// - tee: asphalt west and east, concrete south;
// - mix: concrete north and south, 3 m asphalt west and east;
// - tie: concrete north and south, asphalt west and east;
// - dirt: dirt every way;
// - bend: two 8 m concrete roads meeting at a node.

// The materials of a node's ground, by role, each once.
const ground = (graph: GraphData, node: string, role: 'paving' | 'lane') => [
	...new Set(
		buildModel(graph)
			.scene.node(node)!
			.surfaces.filter((s) => s.role === role)
			.map((s) => s.material)
	)
];
const paving = (graph: GraphData, node: string) => ground(graph, node, 'paving');

test('a junction takes the material with the most car-lane width', () => {
	const graph = readScene('junction-materials');
	expect(paving(graph, 'tee')).toEqual(['asphalt']);
	expect(paving(graph, 'mix')).toEqual(['concrete']);
	// Equal widths: asphalt wins the tie.
	expect(paving(graph, 'tie')).toEqual(['asphalt']);
	// Not only asphalt and concrete.
	expect(paving(graph, 'dirt')).toEqual(['dirt']);
	// Where two roads meet, their lanes' own bands cover the node, in the
	// arms' material.
	expect(ground(graph, 'bend', 'lane')).toEqual(['concrete']);
});

test('moving a road end keeps the junction material; changing an arm to concrete repaves it', () => {
	const graph = readScene('junction-materials');
	nodeOf(graph, 'mix-e').y = -70;
	expect(paving(graph, 'mix')).toEqual(['concrete']);

	// Concrete west and south now outweigh the asphalt left east.
	for (const lane of segmentOf(graph, 'tee-west').lanes) lane.material = 'concrete';
	expect(paving(graph, 'tee')).toEqual(['concrete']);
});
