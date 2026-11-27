import { expect, test } from 'bun:test';
import type { GraphData, Lane } from '../src/lib/core/types';
import { check } from '../src/lib/road-model/checks';
import { buildModel } from './model';

// A footpath across one carriageway of a street with a walkway down its
// middle, near the junction that carriageway runs into: the junction takes
// the crossing as its approach's own, and the lines along the lanes coming
// in stop behind the approach's line, while the other carriageway's, leaving
// the junction, run on to it as they would with no footpath there.

const lane = (id: string, role: Lane['role'], width: number, direction: Lane['direction']) =>
	({
		id,
		role,
		width,
		direction,
		material: role === 'pedestrian' ? 'concrete' : 'asphalt'
	}) as Lane;
const walk = (id: string, width = 2) => lane(id, 'pedestrian', width, 'bidirectional');
const drive = (id: string, direction: Lane['direction']) => lane(id, 'vehicle', 3.5, direction);

const street = [
	walk('L'),
	drive('B', 'backward'),
	drive('BB', 'backward'),
	walk('M', 4),
	drive('F', 'forward'),
	drive('FF', 'forward'),
	walk('R')
];

// A T junction at the origin: the divided street runs on west and east of
// it, a two-lane street leaves it to the north.
function tee(path?: number): GraphData {
	return {
		nodes: [
			{ id: 'a', x: -50, y: 0 },
			{ id: 'j', x: 0, y: 0 },
			{ id: 'b', x: 50, y: 0 },
			{ id: 'c', x: 0, y: 50 },
			...(path === undefined
				? []
				: [
						{ id: 'p', x: path, y: 0 },
						{ id: 'q', x: path, y: 20 }
					])
		],
		segments: [
			{ id: 'west', startNodeId: 'a', endNodeId: 'j', lanes: street },
			{ id: 'east', startNodeId: 'j', endNodeId: 'b', lanes: street },
			{
				id: 'south',
				startNodeId: 'j',
				endNodeId: 'c',
				lanes: street.filter((l) => !['M', 'BB', 'FF'].includes(l.id!))
			},
			...(path === undefined
				? []
				: [{ id: 'path', startNodeId: 'p', endNodeId: 'q', lanes: [walk('P')] }])
		]
	};
}

// Where each lane line of the west road stops nearest the junction, by
// which side of the walkway down the middle it lies on (y < 0: the
// carriageway leaving the junction).
function lineEnds(graph: GraphData) {
	const { scene } = buildModel(graph);
	const ends = scene
		.road('west')!
		.markings.map((m) => m.line.reduce((best, p) => (p.x > best.x ? p : best)));
	return { scene, leaving: ends.filter((p) => p.y < 0), coming: ends.filter((p) => p.y > 0) };
}

for (const x of [-12, -14]) {
	test(`a crossing at x = ${x} over the carriageway coming in leaves the other's lines as they were`, () => {
		const bare = lineEnds(tee());
		const crossed = lineEnds(tee(x));
		expect(crossed.leaving.map((p) => p.x)).toEqual(bare.leaving.map((p) => p.x));
		// The lines along the lanes coming in stop behind the crossing.
		for (const p of crossed.coming) expect(p.x).toBeLessThan(x);
		expect(check(crossed.scene)).toEqual([]);
	});
}
