import { writeFileSync } from 'node:fs';

// Stress fixture #2: focuses on RAISED vs FLUSH buffers (medians + side
// verges), plus 3-way and 4-way INTERSECTIONS and SLIGHT CURVES — the cases
// the original (straight, transition-only) matrix never covered. Each cell is
// spatially isolated; mid/centre nodes are labelled for the in-game overlay.

type Dir = 'forward' | 'backward' | 'bidirectional';
type Mat = 'pavement' | 'asphalt' | 'concrete' | 'grass' | 'dirt';
type Lane = {
	role: 'pedestrian' | 'vehicle' | 'buffer';
	material: Mat;
	width: number;
	direction: Dir;
	raised?: boolean;
};

const ped = (w = 2): Lane => ({ role: 'pedestrian', material: 'pavement', width: w, direction: 'bidirectional' });
const veh = (direction: 'forward' | 'backward', material: Mat = 'asphalt', width = 3.5): Lane => ({
	role: 'vehicle',
	material,
	width,
	direction
});
const buf = (material: Mat, width: number, raised: boolean): Lane => ({
	role: 'buffer',
	material,
	width,
	direction: 'bidirectional',
	...(raised ? { raised: true } : {})
});

// Cross-sections — every variant pair that differs only by the raised flag is
// deliberately present so a raised<->flush transition can be inspected.
const configs: Record<string, () => Lane[]> = {
	street: () => [ped(), veh('backward'), veh('forward'), ped()],
	raisedGrass: () => [ped(), veh('backward'), veh('backward'), buf('grass', 2, true), veh('forward'), veh('forward'), ped()],
	flushGrass: () => [ped(), veh('backward'), veh('backward'), buf('grass', 2, false), veh('forward'), veh('forward'), ped()],
	raisedConc: () => [ped(), veh('backward'), veh('backward'), buf('concrete', 2, true), veh('forward'), veh('forward'), ped()],
	flushConc: () => [ped(), veh('backward'), veh('backward'), buf('concrete', 2, false), veh('forward'), veh('forward'), ped()],
	raisedSide: () => [ped(), buf('grass', 1.5, true), veh('backward'), veh('forward'), buf('grass', 1.5, true), ped()],
	flushSide: () => [ped(), buf('grass', 1.5, false), veh('backward'), veh('forward'), buf('grass', 1.5, false), ped()],
	avenue: () => [
		ped(),
		buf('grass', 1, false),
		veh('backward'),
		veh('backward'),
		buf('concrete', 2, true),
		veh('forward'),
		veh('forward'),
		buf('grass', 1, false),
		ped()
	],
	dirtRaised: () => [ped(), veh('backward'), buf('dirt', 0.5, true), veh('forward'), ped()],
	wideRaised: () => [ped(), veh('backward'), veh('backward'), buf('grass', 5, true), veh('forward'), veh('forward'), ped()],
	onewayRaised: () => [ped(), buf('grass', 2, true), veh('forward'), veh('forward'), ped()],
	highway: () => [
		veh('backward'),
		veh('backward'),
		veh('backward'),
		buf('concrete', 3, true),
		veh('forward'),
		veh('forward'),
		veh('forward')
	]
};

// 14 transition pairs, each emitted straight AND slightly curved = 28 cells.
const transitions: [string, string][] = [
	['raisedGrass', 'flushGrass'],
	['raisedConc', 'flushConc'],
	['raisedGrass', 'raisedConc'],
	['flushGrass', 'flushConc'],
	['raisedGrass', 'flushConc'],
	['raisedGrass', 'street'],
	['flushGrass', 'street'],
	['raisedSide', 'flushSide'],
	['raisedSide', 'street'],
	['raisedSide', 'raisedGrass'],
	['avenue', 'street'],
	['avenue', 'raisedGrass'],
	['onewayRaised', 'raisedGrass'],
	['wideRaised', 'raisedGrass']
];

// 7 three-way + 7 four-way specs, each straight AND curved = 28 cells.
// 3-way order = [E, W, S] (E/W collinear through road, S branch).
const threeWays: [string, string, string][] = [
	['raisedGrass', 'raisedGrass', 'raisedGrass'],
	['raisedGrass', 'raisedGrass', 'street'],
	['avenue', 'avenue', 'street'],
	['raisedGrass', 'flushGrass', 'street'],
	['flushGrass', 'flushGrass', 'street'],
	['raisedSide', 'raisedSide', 'street'],
	['raisedGrass', 'street', 'street']
];
// 4-way order = [E, W, N, S] (E/W through, N/S cross).
const fourWays: [string, string, string, string][] = [
	['raisedGrass', 'raisedGrass', 'raisedGrass', 'raisedGrass'],
	['raisedGrass', 'raisedGrass', 'street', 'street'],
	['avenue', 'avenue', 'street', 'street'],
	['raisedGrass', 'raisedGrass', 'flushGrass', 'flushGrass'],
	['highway', 'highway', 'street', 'street'],
	['raisedGrass', 'street', 'raisedGrass', 'street'],
	['flushGrass', 'flushGrass', 'street', 'street']
];

const COLS = 6;
const CELL = 210;

type NodeOut = { id: string; x: number; y: number; label?: string };
type SegOut = { id: string; startNodeId: string; endNodeId: string; lanes: Lane[]; controlX?: number; controlY?: number };
const nodes: NodeOut[] = [];
const segments: SegOut[] = [];
let nid = 0;
let sid = 0;
const pos = new Map<string, { x: number; y: number }>();

const node = (x: number, y: number, label?: string) => {
	const id = `n${nid++}`;
	nodes.push(label ? { id, x, y, label } : { id, x, y });
	pos.set(id, { x, y });
	return id;
};
const seg = (a: string, b: string, lanes: Lane[], curve = 0) => {
	const id = `s${sid++}`;
	const A = pos.get(a)!;
	const B = pos.get(b)!;
	const out: SegOut = { id, startNodeId: a, endNodeId: b, lanes };
	if (curve !== 0) {
		const dx = B.x - A.x;
		const dy = B.y - A.y;
		const len = Math.hypot(dx, dy) || 1;
		out.controlX = (A.x + B.x) / 2 + (-dy / len) * curve;
		out.controlY = (A.y + B.y) / 2 + (dx / len) * curve;
	}
	segments.push(out);
	return id;
};

let cell = 0;
const cellCenter = () => {
	const col = cell % COLS;
	const row = Math.floor(cell / COLS);
	cell++;
	return { cx: col * CELL + CELL / 2, cy: row * CELL + CELL / 2 };
};

const addTransition = (a: string, b: string, curved: boolean, idx: number) => {
	const { cx, cy } = cellCenter();
	const s = node(cx - 60, cy);
	const m = node(cx, cy, `T${idx}${curved ? 'c' : ''} ${a}→${b}`);
	const e = node(cx + 60, cy);
	seg(s, m, configs[a](), 0);
	seg(m, e, configs[b](), curved ? 9 : 0);
};

const addIntersection = (cfgs: string[], angles: number[], curved: boolean, idx: number, kind: string) => {
	const { cx, cy } = cellCenter();
	const c = node(cx, cy, `${kind}${idx}${curved ? 'c' : ''} ${cfgs.join('/')}`);
	for (let k = 0; k < cfgs.length; k++) {
		const ox = cx + Math.cos(angles[k]) * 60;
		const oy = cy + Math.sin(angles[k]) * 60;
		const o = node(ox, oy);
		seg(o, c, configs[cfgs[k]](), curved ? 6 : 0);
	}
};

// Lay everything out: transitions, then 3-ways, then 4-ways. Each twice
// (straight then curved).
transitions.forEach(([a, b], i) => addTransition(a, b, false, i));
transitions.forEach(([a, b], i) => addTransition(a, b, true, i));

const THREE_ANGLES = [0, Math.PI, Math.PI * 1.5]; // E, W, S
threeWays.forEach((c, i) => addIntersection(c, THREE_ANGLES, false, i, 'Y'));
threeWays.forEach((c, i) => addIntersection(c, THREE_ANGLES, true, i, 'Y'));

const FOUR_ANGLES = [0, Math.PI, Math.PI * 0.5, Math.PI * 1.5]; // E, W, N, S
fourWays.forEach((c, i) => addIntersection(c, FOUR_ANGLES, false, i, 'X'));
fourWays.forEach((c, i) => addIntersection(c, FOUR_ANGLES, true, i, 'X'));

writeFileSync('static/fixtures/stress2.json', JSON.stringify({ nodes, segments }, null, '\t'));
const rows = Math.ceil(cell / COLS);
console.log(`wrote stress2: ${cell} cells, ${nodes.length} nodes, ${segments.length} segments`);
console.log(`grid ${COLS}x${rows}, extent x 0..${COLS * CELL}, y 0..${rows * CELL}`);
console.log(`  transitions: ${transitions.length * 2}, three-way: ${threeWays.length * 2}, four-way: ${fourWays.length * 2}`);
