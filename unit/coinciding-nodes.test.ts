import { expect, test } from 'bun:test';
import { crossingPairs, linesOf } from '../src/lib/core/crossings';
import { Graph } from '../src/lib/core/graph.svelte';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { roadLine } from '../src/lib/core/road-line';
import type { GraphData } from '../src/lib/core/types';

// Two streets each cut at a node, moved so the two nodes show at one spot:
// every road ends there, yet the way through one node crosses the way
// through the other where their roads go on to both sides of each other.

// A street along y = 0 cut at (0, 0), and one along x = `x` cut at (x, `y`),
// running up at `slant` metres across for each metre along.
const streets = (x: number, y: number, slant = 0, far = 40) => {
	const data: GraphData = {
		nodes: [
			{ id: 'a', x: -60, y: 0 },
			{ id: 'm', x: 0, y: 0 },
			{ id: 'b', x: 60, y: 0 },
			{ id: 'c', x: x - slant * far, y: y - far },
			{ id: 'n', x, y },
			{ id: 'd', x: x + slant * far, y: y + far }
		],
		segments: [
			['west', 'a', 'm'],
			['east', 'm', 'b'],
			['south', 'c', 'n'],
			['north', 'n', 'd']
		].map(([id, startNodeId, endNodeId]) => ({
			id,
			startNodeId,
			endNodeId,
			lanes: createLanesFrom('street')
		}))
	};
	const graph = new Graph();
	graph.fromJSON(data);
	return graph;
};

for (const [x, y] of [
	[0, 0],
	[0.004, -0.003],
	[0.1, 0],
	[-0.1, 0]
])
	test(`a cut street moved so its node shows ${Math.hypot(x, y) * 100} cm from another's crosses it`, () => {
		const graph = streets(x, y, 0.3);
		for (const moved of [['south', 'north'], ['south'], ['west', 'east']])
			expect(crossingPairs(linesOf(graph), moved).size).toBeGreaterThan(0);
	});

test("a cut street's node on another's, both its roads to one side, crosses nothing", () => {
	const graph = streets(0, 0);
	// Both of the second street's roads leave the node upward.
	graph.nodes.get('c')!.x = -30;
	graph.nodes.get('c')!.y = 40;
	expect([...crossingPairs(linesOf(graph), ['south', 'north'])]).toEqual([]);
	expect([...crossingPairs(linesOf(graph), ['west', 'east'])]).toEqual([]);
});

test("a dead end moved onto a cut street's node crosses nothing", () => {
	const graph = streets(0, 0);
	graph.deleteSegment('north');
	graph.deleteNode('d');
	expect([...crossingPairs(linesOf(graph), ['south'])]).toEqual([]);
	expect([...crossingPairs(linesOf(graph), ['west', 'east'])]).toEqual([]);
});

// Swept: two ways of two roads each, through two nodes showing at one
// spot, each road leaving at a heading of its own. The second way crosses
// the first exactly where one of its roads leaves strictly between the
// first's two, anticlockwise, and the other strictly outside them; a road
// leaving along one of the first's lies on it, and only touches it. Every
// pair of headings a multiple of 45°, each road stored from the node out
// or toward it, footpaths and streets alike, read with either way moved.
const deg = Math.PI / 180;
const ways = (kind: string, first: [number, number], second: [number, number], stored: number) => {
	const nodes: GraphData['nodes'] = [
		{ id: 'm', x: 0, y: 0 },
		{ id: 'n', x: 0, y: 0 }
	];
	const segments: GraphData['segments'] = [];
	const arms: [string, number, number][] = [
		['m', first[0], 20],
		['m', first[1], 20],
		['n', second[0], 15],
		['n', second[1], 25]
	];
	for (const [k, [node, heading, length]] of arms.entries()) {
		const far = `far${k}`;
		nodes.push({
			id: far,
			x: Math.cos(heading * deg) * length,
			y: Math.sin(heading * deg) * length
		});
		const out = (stored >> k) % 2 === 0;
		segments.push({
			id: `arm${k}`,
			startNodeId: out ? node : far,
			endNodeId: out ? far : node,
			lanes: createLanesFrom(kind)
		});
	}
	const graph = new Graph();
	graph.fromJSON({ nodes, segments });
	return graph;
};
const between = (from: number, to: number, h: number) => {
	const turn = (a: number, b: number) => (((b - a) % 360) + 360) % 360;
	return turn(from, h) > 0 && turn(from, h) < turn(from, to);
};
for (const kind of ['path', 'street'])
	test(`two ${kind === 'path' ? 'footpath' : 'street'} ways through one spot cross exactly where one separates the other`, () => {
		const headings = [0, 45, 90, 135, 180, 225, 270, 315];
		const wrong: string[] = [];
		for (const first of [
			[0, 90],
			[0, 180],
			[45, 270]
		] as [number, number][])
			for (const [i, b0] of headings.entries())
				for (const b1 of headings.slice(i + 1)) {
					const along = (h: number) => first.includes(h);
					const inside = (h: number) => between(first[0], first[1], h);
					const want =
						!along(b0) && !along(b1) && inside(b0) !== inside(b1) ? 'crosses' : 'touches';
					for (let stored = 0; stored < 16; stored += 5)
						for (const moved of [
							['arm2', 'arm3'],
							['arm0', 'arm1']
						]) {
							const graph = ways(kind, first, [b0, b1], stored);
							const got = crossingPairs(linesOf(graph), moved).size ? 'crosses' : 'touches';
							if (got !== want)
								wrong.push(`${first} by ${b0},${b1} stored ${stored} moved ${moved[0]}: ${got}`);
						}
				}
		expect(wrong).toEqual([]);
	});

// The same with one street's shift moving its end there: off the spot
// (shifted alike along it), or leaving it at a slant (shifted at its far
// end alone), either way across. A way runs through the spot only along
// roads whose ends show there, so one whose end its shift shows away from
// the spot is a line of its own, ending where it shows: the ways cross
// where both run through the spot and one separates the other, read on the
// headings they show leaving it, or where a street of one passes through a
// street of the other away from their ends.
const shifts: [string, number, number][] = [
	['off it', 3, 3],
	['off it the other way', -3, -3],
	['slanting', 0, 3],
	['slanting the other way', 0, -3]
];
test('two street ways through one spot cross exactly as their shown lines do, one shifted', () => {
	const headings = [0, 45, 90, 135, 180, 225, 270, 315];
	const wrong: string[] = [];
	const arms = ['arm0', 'arm1', 'arm2', 'arm3'];
	const nodeOfArm = (k: number) => (k < 2 ? 'm' : 'n');
	for (const first of [
		[0, 90],
		[0, 180],
		[45, 270]
	] as [number, number][])
		for (const [i, b0] of headings.entries())
			for (const b1 of headings.slice(i + 1))
				for (const [name, atSpot, atFar] of shifts)
					for (const shifted of [0, 1, 2, 3])
						for (const stored of [0, 5, 10, 15]) {
							const graph = ways('street', first, [b0, b1], stored);
							const arm = graph.segments.get(arms[shifted])!;
							const out = arm.startNodeId === nodeOfArm(shifted);
							arm.offsetStart = out ? atSpot : -atFar;
							arm.offsetEnd = out ? atFar : -atSpot;
							// Each street as it shows from its node's end out.
							const line = (k: number) => {
								const s = graph.segments.get(arms[k])!;
								const pts = roadLine(graph, s, 1);
								return s.startNodeId === nodeOfArm(k) ? pts : [...pts].reverse();
							};
							const lines = arms.map((_, k) => line(k));
							const onSpot = (k: number) => Math.hypot(lines[k][0].x, lines[k][0].y) < 0.01;
							const heading = (k: number) => {
								const [p, q] = [lines[k][0], lines[k].at(-1)!];
								return (((Math.atan2(q.y - p.y, q.x - p.x) / deg) % 360) + 360) % 360;
							};
							const same = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180) < 1e-6;
							const through = onSpot(0) && onSpot(1) && onSpot(2) && onSpot(3);
							const [f0, f1, s0, s1] = [0, 1, 2, 3].map(heading);
							const along = (h: number) => same(h, f0) || same(h, f1);
							const inside = (h: number) => between(f0, f1, h);
							const atSpotCross = through && !along(s0) && !along(s1) && inside(s0) !== inside(s1);
							const passing = [0, 1].some((a) => [2, 3].some((b) => properly(lines[a], lines[b])));
							const want = atSpotCross || passing ? 'crosses' : 'touches';
							for (const moved of [
								['arm2', 'arm3'],
								['arm0', 'arm1']
							]) {
								const pairs = [...crossingPairs(linesOf(graph), moved)].filter((p) => {
									const [x, y] = p.split('|').map((id) => arms.indexOf(id));
									return x < 2 !== y < 2;
								});
								const got = pairs.length ? 'crosses' : 'touches';
								if (got !== want)
									wrong.push(
										`${first} by ${b0},${b1} arm${shifted} ${name} stored ${stored} moved ${moved[0]}: ${got}`
									);
							}
						}
	expect(wrong).toEqual([]);
});

// Whether two straight lines pass through each other away from both's ends.
function properly(p: { x: number; y: number }[], q: { x: number; y: number }[]) {
	const [a, b, c, d] = [p[0], p.at(-1)!, q[0], q.at(-1)!];
	const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
	if (Math.abs(den) < 1e-9) return false;
	const u = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
	const v = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
	const [lp, lq] = [Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(d.x - c.x, d.y - c.y)];
	const margin = 0.05;
	return u * lp > margin && (1 - u) * lp > margin && v * lq > margin && (1 - v) * lq > margin;
}

// A road leaving along one of the first way's and bowing off it is on the
// side it bows to.
for (const [bow, other, want] of [
	[6, 225, 1],
	[-6, 225, 0],
	[6, 45, 0],
	[-6, 45, 1]
] as const)
	test(`a footpath leaving along another's arm and bowing ${bow > 0 ? 'inside' : 'outside'} it, its other arm at ${other}°, ${want ? 'crosses' : 'touches'}`, () => {
		const graph = ways('path', [0, 90], [other, other], 0);
		const arm = graph.segments.get('arm2')!;
		graph.nodes.get('far2')!.x = 20;
		graph.nodes.get('far2')!.y = bow;
		arm.setControlPoint(10, 0);
		expect(crossingPairs(linesOf(graph), ['arm2', 'arm3']).size > 0).toBe(!!want);
	});

test('an elbow of footpaths moved onto another sharing an arm stays where it was let go', async () => {
	const { openEditor, cityOf } = await import('./editor.svelte');
	const ui = openEditor(
		cityOf({ a: [0, 0], an: [0, 20], ae: [20, 0], b: [0, -10], bs: [0, -30], be: [20, -10] }, [
			{ id: 'north', from: 'a', to: 'an', lanes: 'path' },
			{ id: 'east', from: 'a', to: 'ae', lanes: 'path' },
			{ id: 'south', from: 'b', to: 'bs', lanes: 'path' },
			{ id: 'east2', from: 'b', to: 'be', lanes: 'path' }
		])
	);
	ui.click(0, -20);
	ui.click(10, -10, { shift: true });
	expect([...ui.editor.selectedSegments].sort()).toEqual(['east2', 'south']);
	ui.drag({ x: 15, y: -10 }, { x: 15, y: 0 });
	const b = ui.node('b');
	expect([b.x, b.y]).toEqual([0, 0]);
});
