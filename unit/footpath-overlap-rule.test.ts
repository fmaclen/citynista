import { expect, test } from 'bun:test';
import type { GraphData, Lane } from '../src/lib/core/types';
import { check } from '../src/lib/road-model/checks';
import { buildModel } from './model';

// One owner per ground among footpaths: a strip lying on a bend's paving it
// doesn't end at is ground drawn twice, as much as one lying on a strip.

const path = (width: number) =>
	[
		{ id: 'p', role: 'pedestrian', width, direction: 'bidirectional', material: 'concrete' }
	] as Lane[];

test('a narrow footpath inside a bend it does not join is reported drawn over it', () => {
	// Two 4 m footpaths meeting at a right angle at the origin, and a 0.5 m
	// one on the bend's paving inside the corner.
	const graph: GraphData = {
		nodes: [
			{ id: 'a', x: 25, y: 0 },
			{ id: 'j', x: 0, y: 0 },
			{ id: 'b', x: 0, y: 25 },
			{ id: 'p', x: 1.2, y: 1.2 },
			{ id: 'q', x: 3, y: 3 }
		],
		segments: [
			{ id: 'west', startNodeId: 'a', endNodeId: 'j', lanes: path(4) },
			{ id: 'north', startNodeId: 'j', endNodeId: 'b', lanes: path(4) },
			{ id: 'path', startNodeId: 'p', endNodeId: 'q', lanes: path(0.5) }
		]
	};
	const { scene } = buildModel(graph);
	expect(scene.footpathBend('j')).toBeTruthy();
	expect(check(scene).some((w) => w.startsWith('double cover: path and walk:j'))).toBe(true);
});
