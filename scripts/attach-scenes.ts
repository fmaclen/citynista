import { writeFileSync } from 'node:fs';
import { createLanesFrom } from '../src/lib/core/lane-template';

// Scenes for roads attached at another road's edge: an on-ramp, an off-ramp,
// and an avenue splitting into two one-way roads. Writes graph JSON files
// into the given folder.
const out = process.argv[2] ?? '.';
const lanes = (id: string) => createLanesFrom(id).map((l, i) => ({ ...l, id: `l${i}` }));
const one = (direction: 'forward' | 'backward') => [
	{ id: 'l0', role: 'vehicle', material: 'asphalt', width: 3.5, direction }
];

// A freeway drawn southward with an on-ramp joining from the west into an
// acceleration lane, slid half a lane so the median runs straight.
const accel = lanes('highway');
accel.push({ ...accel[accel.length - 1], id: 'l7' });
writeFileSync(
	`${out}/onramp.json`,
	JSON.stringify({
		nodes: [
			{ id: 'n', x: 0, y: -200 },
			{ id: 'm', x: 0, y: 0, junction: { connections: [], sides: { ramp: 'left' } } },
			{ id: 's', x: 0, y: 200 },
			{ id: 'r', x: -60, y: -150 }
		],
		segments: [
			{ id: 'north', startNodeId: 'n', endNodeId: 'm', lanes: lanes('highway') },
			{ id: 'south', startNodeId: 'm', endNodeId: 's', lanes: accel, offset: 1.75 },
			{ id: 'ramp', startNodeId: 'r', endNodeId: 'm', lanes: one('forward') }
		]
	})
);
// An avenue splitting into two one-way roads, each carrying on its own side.
const avenue = lanes('avenue');
const half = (dir: 'forward' | 'backward') =>
	avenue.filter((l) => l.role === 'vehicle' && l.direction === dir);
writeFileSync(
	`${out}/split.json`,
	JSON.stringify({
		nodes: [
			{ id: 'w', x: -200, y: 0 },
			{
				id: 'm',
				x: 0,
				y: 0,
				junction: { connections: [], sides: { westbound: 'left', eastbound: 'right' } }
			},
			{ id: 'a', x: 200, y: -12 },
			{ id: 'b', x: 200, y: 12 }
		],
		segments: [
			{ id: 'avenue', startNodeId: 'w', endNodeId: 'm', lanes: avenue },
			{ id: 'westbound', startNodeId: 'm', endNodeId: 'a', lanes: half('backward') },
			{ id: 'eastbound', startNodeId: 'm', endNodeId: 'b', lanes: half('forward') }
		]
	})
);
console.log('written to', out);
