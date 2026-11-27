import { expect, test } from 'bun:test';
import type { GraphData, Lane } from '../src/lib/core/types';
import { check } from '../src/lib/road-model/checks';
import { buildModel } from './model';

// A footpath across a widening: one lane coming in that the node of two
// sides parts into two is held by one line for the crossing, however far
// apart the two paths out of it have drawn there.

const lane = (id: string, role: Lane['role'], width: number, direction: Lane['direction']) =>
	({
		id,
		role,
		width,
		direction,
		material: role === 'pedestrian' ? 'concrete' : 'asphalt'
	}) as Lane;
const walk = (id: string) => lane(id, 'pedestrian', 2, 'bidirectional');
const drive = (id: string, direction: Lane['direction']) => lane(id, 'vehicle', 3.5, direction);

// Four lanes west of the node at the origin, two east of it: the westbound
// lane B of the east road parts into the west road's B and BB.
function widening(x: number): GraphData {
	const wide = [
		walk('L'),
		drive('B', 'backward'),
		drive('BB', 'backward'),
		drive('F', 'forward'),
		drive('FF', 'forward'),
		walk('R')
	];
	return {
		nodes: [
			{ id: 'a', x: -50, y: 0 },
			{ id: 'j', x: 0, y: 0 },
			{ id: 'b', x: 50, y: 0 },
			{ id: 'p', x, y: -22 },
			{ id: 'q', x, y: 22 }
		],
		segments: [
			{ id: 'west', startNodeId: 'a', endNodeId: 'j', lanes: wide },
			{
				id: 'east',
				startNodeId: 'j',
				endNodeId: 'b',
				lanes: [drive('B', 'backward'), drive('F', 'forward')]
			},
			{ id: 'path', startNodeId: 'p', endNodeId: 'q', lanes: [walk('P')] }
		]
	};
}

for (const x of [-12.5, -8, -4]) {
	test(`a footpath at x = ${x} across a widening holds each lane coming in by one line`, () => {
		const { scene } = buildModel(widening(x));
		const pieces = [
			...scene.place.roads.map((r) => scene.road(r.id)!),
			...scene.place.junctions.map((j) => scene.node(j.id)!)
		];
		const lines = pieces.flatMap((d) =>
			d.signs.flatMap((s) =>
				s.kind === 'yield' || s.kind === 'stop' ? s.lanes.map((l) => `${l.road}/${l.lane}`) : []
			)
		);
		const westbound = lines.filter((l) => l === 'east/B');
		expect(westbound).toHaveLength(1);
		expect(check(scene)).toEqual([]);
	});
}
