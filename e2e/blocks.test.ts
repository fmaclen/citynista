import { expect, test } from '@playwright/test';
import { buildBlocks } from '../src/lib/core/blocks';
import type { Graph } from '../src/lib/core/graph.svelte';
import type { SegmentTrims } from '../src/lib/core/road-geometry';

// Pure-geometry test (no browser): face tracing is exactly the kind of
// topological code that breaks silently — an off-by-one in the ring walk
// gives one giant block instead of the enclosed cells. We pass an explicit
// (empty) trims map so buildBlocks never reaches into full lane data, keeping
// the duck-typed graph minimal.

interface DuckNode {
	id: string;
	x: number;
	y: number;
	connectedSegments: string[];
}

interface DuckSegment {
	id: string;
	startNodeId: string;
	endNodeId: string;
	controlX?: number;
	controlY?: number;
	hasControlPoint: boolean;
	totalWidth: number;
}

const NO_TRIMS: SegmentTrims = new Map();

function makeGraph(
	nodes: { id: string; x: number; y: number }[],
	edges: { id: string; start: string; end: string }[]
): Graph {
	const nodeMap = new Map<string, DuckNode>(
		nodes.map((n) => [n.id, { ...n, connectedSegments: [] }])
	);
	const segmentMap = new Map<string, DuckSegment>();
	for (const edge of edges) {
		segmentMap.set(edge.id, {
			id: edge.id,
			startNodeId: edge.start,
			endNodeId: edge.end,
			hasControlPoint: false,
			totalWidth: 10
		});
		nodeMap.get(edge.start)?.connectedSegments.push(edge.id);
		nodeMap.get(edge.end)?.connectedSegments.push(edge.id);
	}
	return { nodes: nodeMap, segments: segmentMap } as unknown as Graph;
}

// A 100×100 square loop.
const SQUARE = makeGraph(
	[
		{ id: 'n0', x: 0, y: 0 },
		{ id: 'n1', x: 100, y: 0 },
		{ id: 'n2', x: 100, y: 100 },
		{ id: 'n3', x: 0, y: 100 }
	],
	[
		{ id: 's0', start: 'n0', end: 'n1' },
		{ id: 's1', start: 'n1', end: 'n2' },
		{ id: 's2', start: 'n2', end: 'n3' },
		{ id: 's3', start: 'n3', end: 'n0' }
	]
);

// 3×3 node lattice wired into a 2×2 grid of cells.
function gridGraph(): Graph {
	const nodes: { id: string; x: number; y: number }[] = [];
	for (let row = 0; row < 3; row++) {
		for (let col = 0; col < 3; col++) {
			nodes.push({ id: `n${row}${col}`, x: col * 100, y: row * 100 });
		}
	}
	const edges: { id: string; start: string; end: string }[] = [];
	for (let row = 0; row < 3; row++) {
		for (let col = 0; col < 3; col++) {
			if (col < 2) edges.push({ id: `h${row}${col}`, start: `n${row}${col}`, end: `n${row}${col + 1}` });
			if (row < 2) edges.push({ id: `v${row}${col}`, start: `n${row}${col}`, end: `n${row + 1}${col}` });
		}
	}
	return makeGraph(nodes, edges);
}

// The square plus a dead-end spur — the dangle is a slit, not a face.
const DANGLE = makeGraph(
	[
		{ id: 'n0', x: 0, y: 0 },
		{ id: 'n1', x: 100, y: 0 },
		{ id: 'n2', x: 100, y: 100 },
		{ id: 'n3', x: 0, y: 100 },
		{ id: 'n4', x: 200, y: 0 }
	],
	[
		{ id: 's0', start: 'n0', end: 'n1' },
		{ id: 's1', start: 'n1', end: 'n2' },
		{ id: 's2', start: 'n2', end: 'n3' },
		{ id: 's3', start: 'n3', end: 'n0' },
		{ id: 's4', start: 'n1', end: 'n4' }
	]
);

test.describe('Blocks', () => {
	test('a square loop encloses exactly one block', () => {
		const blocks = buildBlocks(SQUARE, NO_TRIMS);
		expect(blocks.length).toBe(1);
		expect(blocks[0].polygons().length).toBeGreaterThan(0);
	});

	test('a 2×2 grid encloses four blocks', () => {
		const blocks = buildBlocks(gridGraph(), NO_TRIMS);
		expect(blocks.length).toBe(4);
		for (const block of blocks) {
			expect(block.polygons().length).toBeGreaterThan(0);
		}
	});

	test('a dead-end spur adds no block', () => {
		expect(buildBlocks(DANGLE, NO_TRIMS).length).toBe(1);
	});
});
