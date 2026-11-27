import { expect, test } from 'bun:test';
import type { Scene } from '../src/lib/core/networks';
import type { Lane } from '../src/lib/core/types';
import { check } from '../src/lib/road-model/checks';
import type { NodeDescription } from '../src/lib/road-model/description';
import type { Pt } from '../src/lib/road-model/model';
import { buildModel } from './model';

// The rule that car lanes never cross a sidewalk but under a crossing reads
// the crossing's own ground, never the clearance behind it where lane lines
// stop for its sign.

const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
	{ x: x0, y: y0 },
	{ x: x1, y: y0 },
	{ x: x1, y: y1 },
	{ x: x0, y: y1 }
];

// A node whose car path runs east along y = 0 and whose sidewalk crosses it
// at x = 3.5, with a zebra from x = 5 to 6 and, behind it, `clear`.
function crossedAt(clear?: Pt[][]) {
	const d = {
		outline: { rings: [], corners: [], mouths: [] },
		ends: [],
		paths: [
			{
				kind: 'drive',
				line: [
					{ x: 0, y: 0 },
					{ x: 10, y: 0 }
				],
				widths: [2, 2]
			},
			{
				kind: 'walk',
				line: [
					{ x: 3.5, y: -1.5 },
					{ x: 3.5, y: 1.5 }
				],
				widths: [1, 1]
			}
		],
		surfaces: [{ role: 'lane', material: 'asphalt', shape: [rect(0, -1, 10, 1)] }],
		markings: [],
		signs: [],
		crossings: [
			{
				id: 'z',
				line: [
					{ x: 5.5, y: -1 },
					{ x: 5.5, y: 1 }
				],
				body: [rect(5, -1, 6, 1)],
				...(clear && { clear }),
				runs: [{ kind: 'zebra', rings: [rect(5, -0.2, 6, 0.2)] }]
			}
		],
		faults: [],
		approaches: []
	} as unknown as NodeDescription;
	return {
		place: { roads: [], junctions: [{ id: 'j' }] },
		node: () => d,
		road: () => undefined,
		footpathNodes: () => null
	} as unknown as Scene;
}

test('a sidewalk across car lanes behind a zebra, where its lines stop, is no crossing', () => {
	const fault = 'car lanes across a sidewalk with no crossing: j (3.5, -0.8)';
	expect(check(crossedAt())).toContain(fault);
	expect(check(crossedAt([rect(3, -1, 5, 1)]))).toContain(fault);
});

// A footpath straight across a street mid-block: the street's crossing is
// as deep as the footpath is wide, and the lanes' lines stop behind it, from
// its give-way rows up to it, outside it.
test('a crossing on a street is the footpath ground alone, its lines stopped behind it', () => {
	const lane = (id: string, role: Lane['role'], direction: Lane['direction']) =>
		({
			id,
			role,
			width: role === 'vehicle' ? 3.5 : 2,
			direction,
			material: role === 'vehicle' ? 'asphalt' : 'concrete'
		}) as Lane;
	const { scene } = buildModel({
		nodes: [
			{ id: 'a', x: -50, y: 0 },
			{ id: 'b', x: 50, y: 0 },
			{ id: 'p', x: 0, y: -20 },
			{ id: 'q', x: 0, y: 20 }
		],
		segments: [
			{
				id: 'street',
				startNodeId: 'a',
				endNodeId: 'b',
				lanes: [
					lane('L', 'pedestrian', 'bidirectional'),
					lane('B', 'vehicle', 'backward'),
					lane('F', 'vehicle', 'forward'),
					lane('R', 'pedestrian', 'bidirectional')
				]
			},
			{
				id: 'path',
				startNodeId: 'p',
				endNodeId: 'q',
				lanes: [lane('P', 'pedestrian', 'bidirectional')]
			}
		]
	});
	const road = scene.road('street')!;
	const zebra = road.crossings.find((c) => c.runs.some((r) => r.kind === 'zebra'))!;
	const xs = zebra.body.flat().map((p) => p.x);
	expect(Math.min(...xs)).toBeGreaterThan(-1.01);
	expect(Math.max(...xs)).toBeLessThan(1.01);
	expect(road.signs.filter((s) => s.kind === 'yield')).toHaveLength(2);
	// No lane line runs on between a row of teeth (2.5 m either side) and
	// the crossing.
	for (const m of road.markings) for (const p of m.line) expect(Math.abs(p.x)).toBeGreaterThan(2.5);
	expect(check(scene)).toEqual([]);
});
