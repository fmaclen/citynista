import { writeFileSync } from 'node:fs';

// Acceptance fixture for S2 (graceful taper): transitions where a buffer/strip
// has NO counterpart on the other side and must wind down to a point — never a
// square cut. Each pair emitted straight and slightly curved.

type Dir = 'forward' | 'backward' | 'bidirectional';
type Mat = 'pavement' | 'asphalt' | 'concrete' | 'grass' | 'dirt';
type Lane = { role: 'pedestrian' | 'vehicle' | 'buffer'; material: Mat; width: number; direction: Dir };

const ped = (w = 2): Lane => ({ role: 'pedestrian', material: 'pavement', width: w, direction: 'bidirectional' });
const veh = (direction: 'forward' | 'backward', material: Mat = 'asphalt', width = 3.5): Lane => ({ role: 'vehicle', material, width, direction });
const buf = (material: Mat, width: number): Lane => ({ role: 'buffer', material, width, direction: 'bidirectional' });

const configs: Record<string, () => Lane[]> = {
	street: () => [ped(), veh('backward'), veh('forward'), ped()],
	median: () => [ped(), veh('backward'), veh('backward'), buf('grass', 2), veh('forward'), veh('forward'), ped()],
	sideBuf: () => [ped(), buf('grass', 1.5), veh('backward'), veh('forward'), buf('grass', 1.5), ped()],
	both: () => [ped(), buf('grass', 1.5), veh('backward'), veh('backward'), buf('grass', 2), veh('forward'), veh('forward'), buf('grass', 1.5), ped()],
	wideMedian: () => [ped(), veh('backward'), veh('backward'), buf('grass', 5), veh('forward'), veh('forward'), ped()],
	concMedian: () => [ped(), veh('backward'), veh('backward'), buf('concrete', 2), veh('forward'), veh('forward'), ped()]
};

const pairs: [string, string][] = [
	['median', 'street'],
	['sideBuf', 'street'],
	['both', 'street'],
	['wideMedian', 'median'],
	['both', 'median'],
	['concMedian', 'street']
];

const COLS = 4;
const CELL = 200;
const nodes: { id: string; x: number; y: number; label?: string }[] = [];
const segments: { id: string; startNodeId: string; endNodeId: string; lanes: Lane[]; controlX?: number; controlY?: number }[] = [];
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
	const A = pos.get(a)!;
	const B = pos.get(b)!;
	const out = { id: `s${sid++}`, startNodeId: a, endNodeId: b, lanes } as (typeof segments)[number];
	if (curve !== 0) {
		const dx = B.x - A.x;
		const dy = B.y - A.y;
		const len = Math.hypot(dx, dy) || 1;
		out.controlX = (A.x + B.x) / 2 + (-dy / len) * curve;
		out.controlY = (A.y + B.y) / 2 + (dx / len) * curve;
	}
	segments.push(out);
};

let cell = 0;
const add = (a: string, b: string, curved: boolean, idx: number) => {
	const col = cell % COLS;
	const row = Math.floor(cell / COLS);
	cell++;
	const cx = col * CELL + CELL / 2;
	const cy = row * CELL + CELL / 2;
	const s = node(cx - 60, cy);
	const m = node(cx, cy, `${idx}${curved ? 'c' : ''} ${a}→${b}`);
	const e = node(cx + 60, cy);
	seg(s, m, configs[a](), 0);
	seg(m, e, configs[b](), curved ? 9 : 0);
};

pairs.forEach(([a, b], i) => add(a, b, false, i));
pairs.forEach(([a, b], i) => add(a, b, true, i));

writeFileSync('static/fixtures/graceful-taper.json', JSON.stringify({ nodes, segments }, null, '\t'));
console.log(`wrote graceful-taper: ${cell} cells, ${nodes.length} nodes, ${segments.length} segments`);
