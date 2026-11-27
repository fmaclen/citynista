import { expect, test } from 'bun:test';
import { resolveCrossings } from '../src/lib/core/crossings';
import { Graph } from '../src/lib/core/graph.svelte';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { roadLine } from '../src/lib/core/road-line';

// A road built over a node of its kind where the node shows joins it there,
// its pieces showing off the node as the node shows off where it lies (as
// near as a shift at the cut puts them): built right through where a node
// shows, it stays all but straight, whether the node shows where it lies or
// its roads' shifts show it off there.

// Two footpaths along y = 0 joined at (0, 0), shifted `shift` m right of
// their way east (so they and their node show along y = shift), and a
// footpath built from (-20, shift - 20) to (20, shift + 20), right through
// where the node shows.
const across = (shift: number) => {
	const graph = new Graph();
	const path = createLanesFrom('path');
	const shifted = { lanes: path, offsetStart: shift, offsetEnd: shift };
	graph.fromJSON({
		nodes: [
			{ id: 'w', x: -30, y: 0 },
			{ id: 'j', x: 0, y: 0 },
			{ id: 'e', x: 30, y: 0 },
			{ id: 'p', x: -20, y: shift - 20 },
			{ id: 'q', x: 20, y: shift + 20 }
		],
		segments: [
			{ id: 'west', startNodeId: 'w', endNodeId: 'j', ...shifted },
			{ id: 'east', startNodeId: 'j', endNodeId: 'e', ...shifted },
			{ id: 'new', startNodeId: 'p', endNodeId: 'q', lanes: path }
		]
	});
	return graph;
};

// How far the pieces of the road built show from the line it was built on
// (y = x + shift), at the most; each a piece from the node.
const bent = (graph: Graph, shift: number) => {
	const pieces = [...graph.segments.values()].filter((s) => !['west', 'east'].includes(s.id));
	expect(pieces.length).toBe(2);
	expect(pieces.every((s) => s.startNodeId === 'j' || s.endNodeId === 'j')).toBe(true);
	return Math.max(
		...pieces.flatMap((s) =>
			roadLine(graph, s, 16).map((p) => Math.abs(p.y - p.x - shift) / Math.SQRT2)
		)
	);
};

for (const shift of [0, 2, -3])
	test(`a footpath built through where a footpath node shows ${shift} m off where it lies joins it there all but straight`, () => {
		const graph = across(shift);
		expect(resolveCrossings(graph, ['new'])).toBe(true);
		expect(bent(graph, shift)).toBeLessThan(0.1);
	});
