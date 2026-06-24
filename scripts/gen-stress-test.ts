import { writeFileSync } from 'node:fs';

// Transition stress-test: a grid of "config A -> mid node -> config B" pairs.
// Each cell is one straight horizontal road of two segments meeting at a
// transition node, with dead-ends at both outer ends, so every cell isolates a
// single cross-section transition. Deliberately conflicting-but-realistic.

type Lane = {
	role: 'pedestrian' | 'vehicle' | 'buffer';
	material: 'pavement' | 'asphalt' | 'concrete' | 'grass' | 'dirt';
	width: number;
	direction: 'forward' | 'backward' | 'bidirectional';
	raised?: boolean;
};

const ped = (w = 3): Lane => ({
	role: 'pedestrian',
	material: 'pavement',
	width: w,
	direction: 'bidirectional'
});
const veh = (
	direction: 'forward' | 'backward',
	material: Lane['material'] = 'asphalt',
	width = 3.5
): Lane => ({ role: 'vehicle', material, width, direction });
const median = (material: Lane['material'], width = 2, raised = true): Lane => ({
	role: 'buffer',
	material,
	width,
	direction: 'bidirectional',
	raised
});

const configs: Record<string, () => Lane[]> = {
	street: () => [ped(), veh('backward'), veh('forward'), ped()],
	avenue: () => [ped(), veh('backward'), veh('backward'), veh('forward'), veh('forward'), ped()],
	grassMedian: () => [
		ped(),
		veh('backward'),
		veh('backward'),
		median('grass', 2, true),
		veh('forward'),
		veh('forward'),
		ped()
	],
	concreteMedian: () => [
		ped(),
		veh('backward'),
		veh('backward'),
		median('concrete', 2, true),
		veh('forward'),
		veh('forward'),
		ped()
	],
	dirtMedian: () => [ped(), veh('backward'), median('dirt', 0.5, true), veh('forward'), ped()],
	flushGrass: () => [ped(), veh('backward'), median('grass', 3, false), veh('forward'), ped()],
	oneway2: () => [ped(), veh('forward'), veh('forward'), ped()],
	highway: () => [
		ped(),
		veh('backward'),
		veh('backward'),
		veh('backward'),
		median('concrete', 3, true),
		veh('forward'),
		veh('forward'),
		veh('forward'),
		ped()
	],
	path: () => [ped(5)],
	concreteRoad: () => [ped(), veh('backward', 'concrete'), veh('forward', 'concrete'), ped()],
	narrowStreet: () => [ped(2), veh('backward', 'asphalt', 3), veh('forward', 'asphalt', 3), ped(2)],
	wideGrassMedian: () => [
		ped(),
		veh('backward'),
		veh('backward'),
		median('grass', 6, true),
		veh('forward'),
		veh('forward'),
		ped()
	],
	offcenter: () => [
		ped(),
		veh('backward'),
		median('grass', 2, true),
		veh('forward'),
		veh('forward'),
		veh('forward'),
		ped()
	]
};

const pairs: [string, string][] = [
	['street', 'avenue'],
	['avenue', 'grassMedian'],
	['grassMedian', 'concreteMedian'],
	['grassMedian', 'dirtMedian'],
	['grassMedian', 'flushGrass'],
	['concreteMedian', 'avenue'],
	['grassMedian', 'street'],
	['highway', 'avenue'],
	['avenue', 'oneway2'],
	['street', 'concreteRoad'],
	['street', 'narrowStreet'],
	['wideGrassMedian', 'grassMedian'],
	['grassMedian', 'offcenter'],
	['avenue', 'path'],
	['highway', 'street'],
	['flushGrass', 'concreteMedian'],
	['dirtMedian', 'grassMedian'],
	['oneway2', 'avenue'],
	['concreteRoad', 'concreteMedian'],
	['narrowStreet', 'avenue'],
	['offcenter', 'grassMedian'],
	['path', 'street'],
	['wideGrassMedian', 'flushGrass'],
	['street', 'highway'],
	['grassMedian', 'highway'],
	['concreteMedian', 'dirtMedian'],
	['avenue', 'concreteRoad'],
	['dirtMedian', 'street']
];

const COLS = 5;
const CELL_W = 140;
const CELL_H = 60;
const SEG_LEN = 50;

const nodes: { id: string; x: number; y: number }[] = [];
const segments: {
	id: string;
	startNodeId: string;
	endNodeId: string;
	lanes: Lane[];
}[] = [];

const index: string[] = [];
pairs.forEach(([a, b], i) => {
	const col = i % COLS;
	const row = Math.floor(i / COLS);
	const x0 = col * CELL_W;
	const y = row * CELL_H;

	const start = `node-${i}-s`;
	const mid = `node-${i}-m`;
	const end = `node-${i}-e`;
	nodes.push({ id: start, x: x0, y });
	nodes.push({ id: mid, x: x0 + SEG_LEN, y });
	nodes.push({ id: end, x: x0 + 2 * SEG_LEN, y });

	segments.push({ id: `segment-${i}-a`, startNodeId: start, endNodeId: mid, lanes: configs[a]() });
	segments.push({ id: `segment-${i}-b`, startNodeId: mid, endNodeId: end, lanes: configs[b]() });

	index.push(`#${i} (col ${col}, row ${row}, x≈${x0}-${x0 + 2 * SEG_LEN}, y=${y}): ${a} -> ${b}`);
});

writeFileSync('static/fixtures/stress-test.json', JSON.stringify({ nodes, segments }, null, '\t'));
console.log(`wrote ${pairs.length} transition variations (${nodes.length} nodes, ${segments.length} segments)`);
console.log('grid extent: x 0..' + (COLS - 1) * CELL_W + (2 * SEG_LEN) + ', y 0..' + (Math.ceil(pairs.length / COLS) - 1) * CELL_H);
console.log('\n=== cell index ===');
for (const line of index) console.log(line);
