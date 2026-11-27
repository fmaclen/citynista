import { expect, test } from 'bun:test';
import {
	crossingPairs,
	findCrossingsBetweenSegments,
	linesOf,
	resolveCrossings
} from '../src/lib/core/crossings';
import { Graph } from '../src/lib/core/graph.svelte';
import { createLanesFrom } from '../src/lib/core/lane-template';
import type { GraphData } from '../src/lib/core/types';
import { cityOf, openEditor } from './editor.svelte';

// Two lines of one kind cross wherever each passes through the other away
// from a node they share, read on the lines as shown (shifts and all); a line
// that comes within 1 cm of another and goes back the side it came from, or
// rests on it all the way to its end, touches rather than crosses, however
// shallow the approach. A move is refused only where lines come to cross: a
// road's body over another's end is no crossing, but a line through a node
// whose roads leave it to both sides crosses them, whichever of the two moved.

type Road = [string, string, string, Partial<GraphData['segments'][number]>?];
const g = (points: [string, number, number][], roads: Road[]) => {
	const data: GraphData = {
		nodes: points.map(([id, x, y]) => ({ id, x, y })),
		segments: roads.map(([id, startNodeId, endNodeId, more]) => ({
			id,
			startNodeId,
			endNodeId,
			lanes: createLanesFrom('street'),
			...more
		}))
	};
	const graph = new Graph();
	graph.fromJSON(data);
	return graph;
};

for (const [past, joined] of [
	[0.005, false],
	[0.05, true]
] as const)
	test(`a road built ending ${past * 100} cm past a street's line at a shallow angle ${joined ? 'is' : 'is not'} joined to it`, () => {
		const graph = g(
			[
				['a', -80, 0],
				['b', 80, 0],
				['c', -65, -2],
				['d', 45, past]
			],
			[
				['same', 'a', 'b'],
				['shallow', 'c', 'd']
			]
		);
		expect(resolveCrossings(graph, ['shallow'])).toBe(joined);
		expect(graph.segments.size).toBe(joined ? 4 : 2);
	});

test("a street moved so its body covers another's ends, their lines apart, crosses nothing", () => {
	const graph = g(
		[
			['a', -65, 4],
			['b', 65, 4],
			['c', -25, 8],
			['d', 25, 8]
		],
		[
			['main', 'a', 'b'],
			['side', 'c', 'd']
		]
	);
	expect([...crossingPairs(linesOf(graph), ['main'])]).toEqual([]);
});

for (const [far, crosses] of [
	[35, true],
	[-35, false]
] as const)
	test(`a street whose line runs through a node ${crosses ? 'crosses the roads going on to both sides' : 'touches the roads all to one side'}`, () => {
		const graph = g(
			[
				['a', -65, 0],
				['b', 65, 0],
				['c', 25, -35],
				['j', 25, 0],
				['d', 30, far]
			],
			[
				['main', 'a', 'b'],
				['up', 'c', 'j'],
				['on', 'j', 'd']
			]
		);
		expect([...crossingPairs(linesOf(graph), ['main'])].sort()).toEqual(
			crosses ? ['main|on', 'main|up'] : []
		);
	});

test('a street moved until its line crosses another crosses it', () => {
	const graph = g(
		[
			['a', -65, 0],
			['b', 65, 0],
			['c', 25, -7],
			['d', 25, 35]
		],
		[
			['main', 'a', 'b'],
			['side', 'c', 'd']
		]
	);
	expect([...crossingPairs(linesOf(graph), ['main'])]).toEqual(['main|side']);
});

// A crossing inside ENDPOINT_EXCLUSION of a road's end is still a
// crossing, for a move and for a road built.
test('a street moved until its line crosses another 3 m from its end crosses it', () => {
	const graph = g(
		[
			['a', -65, 0],
			['b', 65, 0],
			['c', 0, -3],
			['d', 0, 40]
		],
		[
			['main', 'a', 'b'],
			['side', 'c', 'd']
		]
	);
	expect([...crossingPairs(linesOf(graph), ['side'])]).toEqual(['main|side']);
});

test("a road built ending 3 m past a street's line is joined where they cross", () => {
	const graph = g(
		[
			['a', -65, 0],
			['b', 65, 0],
			['c', 0, 40],
			['d', 0, -3]
		],
		[
			['s', 'a', 'b'],
			['built', 'c', 'd']
		]
	);
	expect(resolveCrossings(graph, ['built'])).toBe(true);
	expect(graph.segments.size).toBe(4);
	const joined = [...graph.nodes.values()].find((n) => Math.hypot(n.x, n.y) < 0.5);
	expect(joined?.connectedSegments).toHaveLength(4);
});

// Drawn so with Ctrl held, where nothing snaps, the street is joined there
// all the same: building connects, whatever the snapping.
test("a street drawn with Ctrl held ending 3 m past a street's line is joined where they cross", () => {
	const ui = openEditor(
		cityOf({ a: [-65, 0], b: [65, 0] }, [{ id: 's', from: 'a', to: 'b', lanes: 'street' }])
	);
	ui.editor.activateSlot(0);
	ui.editor.setDrawStyle('straight');
	for (const y of [40, -3]) ui.click(0, y, { ctrl: true });
	ui.key('Escape');
	expect(ui.editor.graph.segments.size).toBe(4);
	const joined = [...ui.editor.graph.nodes.values()].find((n) => Math.hypot(n.x, n.y) < 0.5);
	expect(joined?.connectedSegments).toHaveLength(4);
});

test("a junction's roads passing 4.5 m from a street's end cross nothing", () => {
	const graph = g(
		[
			['a', -65, 0],
			['j', 0, 4],
			['b', 65, 0],
			['c', 25, 7],
			['d', 25, 35]
		],
		[
			['left', 'a', 'j'],
			['right', 'j', 'b'],
			['side', 'c', 'd']
		]
	);
	expect([...crossingPairs(linesOf(graph), ['left', 'right'])]).toEqual([]);
});

// Across the other kind a move always goes: a street and a footpath laid
// across each other, whichever moved, are no pair.
test('a street across a footpath, and a footpath across a street, make no crossing pair', () => {
	const graph = g(
		[
			['a', -60, 0],
			['b', 60, 0],
			['c', 0, -30],
			['d', 0, 30]
		],
		[
			['street', 'a', 'b'],
			['path', 'c', 'd', { lanes: createLanesFrom('path') }]
		]
	);
	expect(
		findCrossingsBetweenSegments(graph, graph.segments.values(), graph, graph.segments.values())
	).toEqual([]);
	expect([...crossingPairs(linesOf(graph), ['street'])]).toEqual([]);
	expect([...crossingPairs(linesOf(graph), ['path'])]).toEqual([]);
	// Two streets laid so do.
	const cars = g(
		[
			['a', -60, 0],
			['b', 60, 0],
			['c', 0, -30],
			['d', 0, 30]
		],
		[
			['street', 'a', 'b'],
			['across', 'c', 'd']
		]
	);
	expect([...crossingPairs(linesOf(cars), ['across'])]).toEqual(['across|street']);
});

// So a footpath's curve dragged by its handle across a street, twice, is
// kept, one undo step: nothing is cut, and a zebra (a badge each) shows
// where it crosses either side.
test("a footpath bent across a street twice by its curve's handle is kept, one undo step", () => {
	const ui = openEditor(
		cityOf({ a: [-70, 0], b: [70, 0], c: [-32, -20], d: [32, -20] }, [
			{ id: 'street', from: 'a', to: 'b', lanes: 'street' },
			{ id: 'walk', from: 'c', to: 'd', lanes: 'path' }
		])
	);
	const ids = () => [[...ui.editor.graph.nodes.keys()], [...ui.editor.graph.segments.keys()]];
	const before = ids();
	ui.click(16, -20);
	ui.drag({ x: 0, y: -20 }, { x: 0, y: 60 }, {}, 12);
	expect(ui.editor.graph.segments.get('walk')!.controlY).toBeGreaterThan(40);
	expect(ids()).toEqual(before);
	expect(ui.editor.crossingBadges.map((b) => Math.sign(b.x)).sort()).toEqual([-1, 1]);
	expect(ui.editor.canUndo).toBe(true);
	ui.editor.undo();
	expect(ui.editor.graph.segments.get('walk')!.hasControlPoint).toBe(false);
	expect(ui.editor.canUndo).toBe(false);
});

const crossings = (graph: Graph) =>
	findCrossingsBetweenSegments(graph, graph.segments.values(), graph, graph.segments.values());
// A street along y = 0, and a curve from (-40, 10) to (40, 10) whose lowest
// point is `low`.
const dipping = (low: number) =>
	g(
		[
			['a', -70, 0],
			['b', 70, 0],
			['p', -40, 10],
			['q', 40, 10]
		],
		[
			['street', 'a', 'b'],
			['curve', 'p', 'q', { controlX: 0, controlY: 2 * low - 10 }]
		]
	);

test('a curve dipping through a street crosses it twice; one touching it, or 4 mm past it, not at all', () => {
	expect(new Set(crossings(dipping(-7.5)).map((c) => Math.round(c.x)))).toEqual(new Set([-26, 26]));
	expect(crossingPairs(linesOf(dipping(-7.5)), ['curve'])).toEqual(new Set(['curve|street']));
	expect(crossings(dipping(0))).toEqual([]);
	expect(crossings(dipping(-0.004))).toEqual([]);
	// Nor for a move, which reads the pairs.
	expect([...crossingPairs(linesOf(dipping(0)), ['curve'])]).toEqual([]);
	expect([...crossingPairs(linesOf(dipping(-0.004)), ['curve'])]).toEqual([]);
});

test('a curve whose last stretch rests within a centimetre of a street is not joined to it', () => {
	const graph = g(
		[
			['a', -80, 0],
			['b', 80, 0],
			['p', -65, -2],
			['q', 60, 0.005]
		],
		[
			['street', 'a', 'b'],
			['curve', 'p', 'q', { controlX: 0, controlY: 0.02 }]
		]
	);
	expect([...crossingPairs(linesOf(graph), ['curve'])]).toEqual([]);
	expect(resolveCrossings(graph, ['curve'])).toBe(false);
	expect(graph.segments.size).toBe(2);
});

test("a junction's roads leaving to both sides of a street its node lies on cross it, read from the roads", () => {
	const graph = g(
		[
			['a', -65, 0],
			['b', 5, 0],
			['n', 60, -27],
			['j', 0, 0],
			['s', 0, 45]
		],
		[
			['main', 'a', 'b'],
			['north', 'n', 'j'],
			['south', 'j', 's']
		]
	);
	expect([...crossingPairs(linesOf(graph), ['north', 'south'])].sort()).toEqual([
		'main|north',
		'main|south'
	]);
});

test('a road through a node whose roads both draw to one side of it, one shifted, touches them', () => {
	const graph = g(
		[
			['a', -64, 0],
			['b', 64, 0],
			['l', -48, -4],
			['j', 0, 0],
			['r', 48, 1]
		],
		[
			['main', 'a', 'b'],
			['left', 'j', 'l'],
			// Drawn toward (48, 1), it shows toward (48, -2).
			['right', 'j', 'r', { offsetEnd: -3 }]
		]
	);
	expect([...crossingPairs(linesOf(graph), ['main'])]).toEqual([]);
});

// A footpath is never laid over footpaths already there: one built over
// both nodes of a shorter one runs on through it, its piece between them
// taken out. Car roads may lie two between two nodes.
for (const kind of ['path', 'street'] as const)
	test(`a ${kind} built over both nodes of a shorter one ${kind === 'path' ? 'runs on through it' : 'lies beside it between them'}`, () => {
		const lanes = createLanesFrom(kind);
		const graph = g(
			[
				['c', -24, 0.7],
				['d', 25, 0.7],
				['a', -40, 0],
				['b', 40, 0]
			],
			[
				['short', 'c', 'd', { lanes }],
				['long', 'a', 'b', { lanes }]
			]
		);
		expect(resolveCrossings(graph, ['long'])).toBe(true);
		const between = [...graph.segments.values()].filter(
			(s) => [s.startNodeId, s.endNodeId].sort().join() === 'c,d'
		);
		expect(between.map((s) => s.id)).toEqual(
			kind === 'path' ? ['short'] : ['short', expect.any(String)]
		);
		expect(graph.nodes.get('c')!.connectedSegments).toHaveLength(kind === 'path' ? 2 : 3);
		expect(graph.nodes.get('d')!.connectedSegments).toHaveLength(kind === 'path' ? 2 : 3);
	});

// Only a piece whose strip lies within the footpaths there is taken out: a
// wide curve cut at both nodes of a straight path, bowing 15 m off it
// between them, is a way of its own, and so is one wider than the path it
// lies along; a narrower one lying within a wide path's strip is not.
for (const [under, over, control, kept] of [
	[2, 10, 30, true],
	[2, 10, 0.5, true],
	[10, 2, 0.5, false]
] as const)
	test(`a ${over} m footpath built between two nodes a ${under} m path joins, bowing ${control / 2} m off it, ${kept ? 'stays' : 'is taken out'}`, () => {
		const width = (w: number) => createLanesFrom('path').map((l) => ({ ...l, width: w }));
		const graph = g(
			[
				['a', -37, 0],
				['b', 37, 0]
			],
			[
				['straight', 'a', 'b', { lanes: width(under) }],
				['built', 'a', 'b', { lanes: width(over), controlX: 0, controlY: control }]
			]
		);
		expect(resolveCrossings(graph, ['built'])).toBe(!kept);
		expect([...graph.segments.keys()]).toEqual(kept ? ['straight', 'built'] : ['straight']);
	});
