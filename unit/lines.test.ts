import { expect, test } from 'bun:test';
// First: the drawing's modules import each other, lines.ts among them.
import { buildModel } from './model';
import type { Lane as EditorLane } from '../src/lib/core/types';
import type { Description } from '../src/lib/road-model/description';
import { laneLines, linesAcross, type Slot } from '../src/lib/road-model/lines';
import type { Lane } from '../src/lib/road-model/model';

// The lane-line rule (road-model/lines.ts), case by case. A cross-section is written
// lane by lane from offset 0: B and F are car lanes backward and forward, T a
// two-way one, W a sidewalk, H hatching, M a median, each with its width. The
// lines come back in order across: w or y, s(olid) or d(ashed), the offset.

const KINDS: Record<string, Pick<Lane, 'kind' | 'dir' | 'surface'>> = {
	B: { kind: 'drive', dir: 'back', surface: 'asphalt' },
	F: { kind: 'drive', dir: 'fwd', surface: 'asphalt' },
	T: { kind: 'drive', dir: 'both', surface: 'asphalt' },
	W: { kind: 'walk', dir: 'none', surface: 'pavement' },
	H: { kind: 'buffer', dir: 'none', surface: 'hatch' },
	M: { kind: 'buffer', dir: 'none', surface: 'concrete' }
};

const show = (marks: ReturnType<typeof linesAcross>) =>
	marks
		.sort((a, b) => a.o - b.o)
		.map((m) => `${m.colour[0]}${m.dashed ? 'd' : 's'}${+m.o.toFixed(2)}`)
		.join(' ');

function lanes(section: string, from = 0) {
	let left = from;
	return section.split(' ').map((code, i) => {
		const width = Number(code.slice(1));
		const span = { lane: { id: `l${i}`, width, ...KINDS[code[0]] }, left, right: left + width };
		left = span.right;
		return span;
	});
}

const ROADS: [string, string, string][] = [
	['a street', 'W2 B3.5 F3.5 W2', 'ws2.2 ys5.3 ys5.7 ws8.8'],
	['four lanes', 'B3.5 B3.5 F3.5 F3.5', 'ws0.2 wd3.5 ys6.8 ys7.2 wd10.5 ws13.8'],
	['no dashes beside a lane under 2 m', 'F1.9 F3.5', 'ys0.2 ws5.2'],
	['a two-way lane', 'T5', 'ys0.2 yd2.5 ys4.8'],
	['a two-way lane between car lanes', 'B3.5 T3.5 F3.5', 'ws0.2 yd5.25 ws10.3'],
	['a median parting opposing traffic', 'B3.5 M2 F3.5', 'ws0.2 ys3.3 ys5.7 ws8.8'],
	['a median between lanes one way', 'F3.5 M2 F3.5', 'ys0.2 ws3.3 ws5.7 ws8.8'],
	['a sidewalk between lanes one way', 'F3.5 W2 F3.5', 'ys0.2 ws3.3 ys5.7 ws8.8'],
	['hatching between car lanes has no outline', 'B3.5 H2 F3.5', 'ws0.2 ys3.3 ys5.7 ws8.8'],
	['hatching beside a median is outlined', 'B3.5 H2 M2 F3.5', 'ws0.2 ys3.3 ys5.3 ys7.7 ws10.8'],
	['hatching with traffic on one side only', 'F3.5 H2 M2 W2', 'ys0.2 ws3.3 ws5.3'],
	['a car lane under 0.5 m is left out', 'B3.5 F0.4 F3.5', 'ws0.2 ys3.3 ys4.1 ws7.2'],
	['a two-way lane under 0.5 m is left out', 'B3.5 T0.1 F3.5', 'ws0.2 ys3.3 ys3.8 ws6.9']
];

for (const [name, section, lines] of ROADS)
	test(`across a road: ${name}`, () => expect(show(laneLines(lanes(section)))).toBe(lines));

test('a lane exactly 2 m wide gets its dashes wherever the road sits', () => {
	const spans = lanes('F2 F2', 0.1);
	expect(spans[1].right - spans[1].left).toBeLessThan(2);
	expect(show(laneLines(spans))).toBe('ys0.3 wd2.1 ws3.9');
});

// Car paths across a node at one station: they overlap or stand apart.
const path = (lo: number, way: 1 | -1): Slot => ({ lo, hi: lo + 3.5, kind: 'travel', way });
const NODES: [string, Slot[], string][] = [
	['paths sharing road have nothing between', [path(0, 1), path(3, 1)], 'ys0.2 ws6.3'],
	[
		'opposing paths apart keep their own edges',
		[path(0, -1), path(4, 1)],
		'ws0.2 ys3.3 ys4.2 ws7.3'
	],
	['paths over 0.6 m apart get edge lines', [path(0, 1), path(4.5, 1)], 'ys0.2 ws3.3 ws4.7 ws7.8'],
	['a path beside two sharing road', [path(0, 1), path(3, 1), path(6.5, 1)], 'ys0.2 wd6.5 ws9.8']
];

for (const [name, slots, lines] of NODES)
	test(`across a node: ${name}`, () => expect(show(linesAcross(slots))).toBe(lines));

test('across a node: nothing is painted beside paths that swap sides', () => {
	const slots = [path(0, 1), path(3, 1), path(6.5, 1)];
	expect(show(linesAcross(slots, (p, q) => p !== q))).toBe('ys0.2 ws9.8');
});

// A straight road through m of the given lanes (car lanes forward, F, or
// sidewalks, W): the lines on the road and on across the node.
function straightOn(section: string) {
	const lanes: EditorLane[] = section.split(' ').map((code, i) => ({
		id: `l${i}`,
		role: code[0] === 'W' ? 'pedestrian' : 'vehicle',
		material: code[0] === 'W' ? 'concrete' : 'asphalt',
		width: Number(code.slice(1)),
		direction: code[0] === 'W' ? 'bidirectional' : 'forward'
	}));
	const { scene } = buildModel({
		nodes: [
			{ id: 'a', x: -50, y: 0 },
			{ id: 'm', x: 0, y: 0 },
			{ id: 'b', x: 50, y: 0 }
		],
		segments: [
			{ id: 'one', startNodeId: 'a', endNodeId: 'm', lanes },
			{ id: 'two', startNodeId: 'm', endNodeId: 'b', lanes }
		]
	});
	const show = (d: Description, end: 'first' | 'last') =>
		d.markings
			.map((m) => ({ m, p: end === 'first' ? m.line[0] : m.line[m.line.length - 1] }))
			.sort((a, b) => a.p.y - b.p.y)
			.map(({ m, p }) => `${m.colour[0]}${m.dashed ? 'd' : 's'}${+p.y.toFixed(2)}`)
			.join(' ');
	return { road: show(scene.road('one')!, 'last'), node: show(scene.node('m')!, 'first') };
}

test('across a node: carriageways one way either side of a sidewalk keep the road’s colours', () => {
	const { road, node } = straightOn('F3.5 W2 F3.5');
	expect(road).toBe('ys-4.3 ws-1.2 ys1.2 ws4.3');
	expect(node).toBe(road);
});

test('across a node: an edge line beside a lane too thin to count runs on where the road’s does', () => {
	const { road, node } = straightOn('F0.4 F3.5');
	expect(road).toBe('ys-1.35 ws1.75');
	expect(node).toBe(road);
});
