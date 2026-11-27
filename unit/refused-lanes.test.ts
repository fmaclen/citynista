import { expect, test } from 'bun:test';
import { Graph } from '../src/lib/core/graph.svelte';
import { createLanesFrom } from '../src/lib/core/lane-template';
import type { Lane } from '../src/lib/core/types';

// Lanes given to several roads as one edit (Graph.setLanes) are all set or
// none: one list refused leaves every road holding the cross-section it
// held, the same object, so nothing kept by it is read again.

test('a lane edit refused leaves every road its own cross-section, the same object', () => {
	const graph = new Graph();
	graph.fromJSON({
		nodes: [
			{ id: 'a', x: 0, y: 0 },
			{ id: 'b', x: 50, y: 0 },
			{ id: 'c', x: 100, y: 0 }
		],
		segments: [
			{ id: 'one', startNodeId: 'a', endNodeId: 'b', lanes: createLanesFrom('street') },
			{ id: 'two', startNodeId: 'b', endNodeId: 'c', lanes: createLanesFrom('street') }
		]
	});
	const [one, two] = [graph.segments.get('one')!, graph.segments.get('two')!];
	const held = [one.lanes, two.lanes];
	const broken = null as unknown as Lane[];
	expect(() =>
		graph.setLanes([
			[one, createLanesFrom('avenue')],
			[two, broken]
		])
	).toThrow();
	expect(one.lanes).toBe(held[0]);
	expect(two.lanes).toBe(held[1]);
});
