import { expect, test } from 'bun:test';
import { STOP_ROOM } from '../src/lib/road-model/approach';
import type { GraphData, JunctionCrossing, Lane } from '../src/lib/core/types';
import {
	area,
	fromPath,
	intersect,
	subtract,
	toPath,
	union,
	type Paths
} from '../src/lib/road-model/clip';
import { check } from '../src/lib/road-model/checks';
import type { Description } from '../src/lib/road-model/description';
import { MIN_PIECE } from '../src/lib/road-model/paint';
import { paintOf } from '../src/lib/rendering/road-meshes';
import { buildModel } from './model';

// A dashed line cut short (by a crossing on a road, by a walkway at a node)
// keeps the dashes it had: each piece is painted in the whole line's rhythm,
// never one fitted afresh, and a dash cut to less than MIN_PIECE is left out.

const lane = (
	id: string,
	role: Lane['role'],
	width: number,
	direction: Lane['direction']
): Lane => ({
	id,
	role,
	material: role === 'pedestrian' ? 'concrete' : 'asphalt',
	width,
	direction
});
const STREET = [
	lane('w0', 'pedestrian', 2, 'bidirectional'),
	lane('l1', 'vehicle', 3.5, 'backward'),
	lane('l2', 'vehicle', 3.5, 'backward'),
	lane('l3', 'vehicle', 3.5, 'forward'),
	lane('l4', 'vehicle', 3.5, 'forward'),
	lane('w5', 'pedestrian', 2, 'bidirectional')
];

// The dashes of a description, as one shape.
function dashes(d: Description): Paths {
	const dashed = { ...d, markings: d.markings.filter((m) => m.dashed) };
	if ('signs' in dashed) dashed.signs = [];
	return union(paintOf(dashed)[0].rings.map(toPath));
}
const areaOf = (paths: Paths) => paths.reduce((s, p) => s + Math.abs(area(p)), 0);
// Paint in one and not the other, outside |x| < clear.
function moved(a: Paths, b: Paths, clear: number) {
	const zone = [toPath([-clear, clear, clear, -clear].map((x, i) => ({ x, y: i < 2 ? -50 : 50 })))];
	const [ka, kb] = [subtract(a, zone), subtract(b, zone)];
	return areaOf(subtract(ka, kb)) + areaOf(subtract(kb, ka));
}

test('a dashed line cut by a walkway across a node keeps its dashes either side', () => {
	// A four-lane street through m, both sides stopped 20 m back by hand, a
	// footpath across it there: its lines run 40 m across the node and the
	// walkway cuts them. How wide the footpath is changes only where, and
	// where the give-way lines behind it stand.
	const across = (width: number): GraphData => ({
		nodes: [
			{ id: 'w', x: -100, y: 0 },
			{ id: 'm', x: 0, y: 0, junction: { setbacks: { west: 20, east: 20 } } },
			{ id: 'e', x: 100, y: 0 },
			{ id: 'n', x: 0, y: -60 },
			{ id: 's', x: 0, y: 60 }
		],
		segments: [
			{ id: 'west', startNodeId: 'w', endNodeId: 'm', lanes: STREET },
			{ id: 'east', startNodeId: 'm', endNodeId: 'e', lanes: STREET },
			...['north', 'south'].map((id, i) => ({
				id,
				startNodeId: i ? 'm' : 'n',
				endNodeId: i ? 's' : 'm',
				lanes: [lane('f0', 'pedestrian', width, 'bidirectional')]
			}))
		]
	});
	const [wide, narrow] = [3, 1].map((w) => buildModel(across(w)).scene);
	const [a, b] = [wide, narrow].map((s) => dashes(s.node('m')!));
	// Two dashed lines of four 3 m dashes each, which the walkway and the
	// give-way lines behind it cut only near it.
	const none = across(3);
	none.segments = none.segments.filter((s) => s.id === 'west' || s.id === 'east');
	const bare = dashes(buildModel(none).scene.node('m')!);
	expect(areaOf(bare)).toBeGreaterThan(2 * 4 * 3 * 0.15 - 0.01);
	expect(moved(a, bare, 1.5 + STOP_ROOM + 0.5)).toBeLessThan(0.01);
	expect(moved(a, b, 1.5 + STOP_ROOM + 0.5)).toBeLessThan(0.01);
	expect(check(wide)).toEqual([]);
	expect(check(narrow)).toEqual([]);
});

test('a dashed line cut by a crossing on a road keeps its dashes either side, with no stub', () => {
	// A straight 100 m four-lane street, a crossing set by hand 3 m deep at
	// each place, or none.
	const street = (at: number[]): GraphData => ({
		nodes: [
			{
				id: 'a',
				x: -50,
				y: 0,
				junction: {
					crossings: at.map(
						(d): JunctionCrossing => ({ road: 'r', end: 'start', lanes: ['w0', 'w5'], at: d })
					)
				}
			},
			{ id: 'b', x: 50, y: 0 }
		],
		segments: [{ id: 'r', startNodeId: 'a', endNodeId: 'b', lanes: STREET }]
	});
	const plain = dashes(buildModel(street([])).scene.road('r')!);
	// Across a dash, across a gap, and leaving 0.5 m of a dash beside it.
	for (const at of [50, 54.5, 45]) {
		const { scene } = buildModel(street([at]));
		const road = scene.road('r')!;
		const cut = dashes(road);
		const zone = [
			toPath([at - 52, at - 48, at - 48, at - 52].map((x, i) => ({ x, y: i < 2 ? -50 : 50 })))
		];
		const ka = subtract(plain, zone);
		const kb = subtract(cut, zone);
		expect(areaOf(subtract(ka, kb)) + areaOf(subtract(kb, ka))).toBeLessThan(0.01);
		// Each dash left is a metre long or more.
		for (const p of cut.map(fromPath)) {
			const run = Math.max(...p.map((q) => q.x)) - Math.min(...p.map((q) => q.x));
			expect(run).toBeGreaterThan(MIN_PIECE - 0.01);
		}
		// Nothing of a dash lies over the crossing.
		expect(areaOf(intersect(cut, road.crossings[0].body.map(toPath)))).toBeLessThan(1e-4);
		expect(check(scene)).toEqual([]);
	}
});
