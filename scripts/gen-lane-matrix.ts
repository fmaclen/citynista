import { writeFileSync } from 'node:fs';

// Generative lane-correspondence stress matrix (slice 1 of docs/lane-correspondence.md).
//
// Enumerates the realistic config space as one-step-neighbour TRANSITIONS: each
// cell is `config A → mid transition node → config B`, a straight horizontal road
// of two segments with dead-ends at both ends, so every cell isolates exactly one
// cross-section change. Cells are grouped by MUTATION CLASS (what kind of change),
// not by Cartesian-producting every pair — that is how the space stays finite and
// realistic. The mid node carries a `#i class: a→b` label (dev NodeLabels overlay).
//
// Output: static/fixtures/_lc-transitions.json (underscore = protected, never
// rewritten by dev saves) + _lc-manifest.json (nodeId → case, for the headless
// invariant harness). Run: `bun scripts/gen-lane-matrix.ts`.

type Material = 'asphalt' | 'concrete' | 'pavement' | 'grass' | 'dirt';
type Lane = {
	role: 'pedestrian' | 'vehicle' | 'buffer';
	material: Material;
	width: number;
	direction: 'forward' | 'backward' | 'bidirectional';
};

const ped = (w = 3): Lane => ({ role: 'pedestrian', material: 'pavement', width: w, direction: 'bidirectional' });
const verge = (w = 3, material: Material = 'grass'): Lane => ({ role: 'buffer', material, width: w, direction: 'bidirectional' });
const med = (material: Material, w = 2): Lane => ({ role: 'buffer', material, width: w, direction: 'bidirectional' });
const f = (material: Material = 'asphalt', w = 3.5): Lane => ({ role: 'vehicle', material, width: w, direction: 'forward' });
const b = (material: Material = 'asphalt', w = 3.5): Lane => ({ role: 'vehicle', material, width: w, direction: 'backward' });

// Cross-section builders, parameterised so mutations are one-liners.
const sidewalks = (lanes: Lane[]) => [ped(), ...lanes, ped()];

// n backward + n forward, optional centre divider between them.
const twoway = (back: number, fwd: number, divider?: Lane, mat: Material = 'asphalt') =>
	sidewalks([
		...Array.from({ length: back }, () => b(mat)),
		...(divider ? [divider] : []),
		...Array.from({ length: fwd }, () => f(mat))
	]);
const oneway = (n: number, mat: Material = 'asphalt') => sidewalks(Array.from({ length: n }, () => f(mat)));

interface Case {
	cls: string; // mutation class
	a: string; // human label of A
	bLabel: string; // human label of B
	A: Lane[];
	B: Lane[];
}

const cases: Case[] = [];
const add = (cls: string, a: string, bLabel: string, A: Lane[], B: Lane[]) =>
	cases.push({ cls, a, bLabel, A, B });

// ── same-section sanity (every cell here must render perfectly) ──
add('same', 'street', 'street', twoway(1, 1), twoway(1, 1));
add('same', 'avenue+grass', 'avenue+grass', twoway(2, 2, med('grass')), twoway(2, 2, med('grass')));
add('same', 'oneway2', 'oneway2', oneway(2), oneway(2));

// ── lane born / dropped, curb (outside) vs median side ──
add('born-outside', 'twoway 2x2', '2x3 (curb)', twoway(2, 2, med('grass')), twoway(2, 3, med('grass')));
add('born-median', 'twoway 2x2', '2x3 (median/turn pocket)', twoway(2, 2, med('grass')), sidewalks([b(), b(), med('grass'), f(), f(), f()].slice())); // extra fwd hugs the median — turn-pocket-like
add('born-outside-oneway', 'oneway2', 'oneway3 (curb)', oneway(2), oneway(3));
add('dropped-outside', 'twoway 3x3', '2x2 (curb drop)', twoway(3, 3, med('grass')), twoway(2, 2, med('grass')));
add('dropped-median', 'twoway 3x3', '2x2 (median drop)', twoway(3, 3, med('grass')), twoway(2, 2, med('grass')));

// ── turn pocket proper: median splits, a turn lane appears between flows ──
// Left-turn bay: the median narrows and a turn lane opens on its inner side.
add('turn-pocket', 'avenue+grass', 'left-turn bay', twoway(2, 2, med('grass', 3)), sidewalks([b(), b(), med('grass', 1), f(), f(), f()]));

// ── centre treatment appears / vanishes / changes ──
add('center-appears', 'undivided 2x2', '+grass median', twoway(2, 2), twoway(2, 2, med('grass')));
add('center-vanishes', '+grass median', 'undivided 2x2', twoway(2, 2, med('grass')), twoway(2, 2));
add('center-material', 'grass median', 'concrete median', twoway(2, 2, med('grass')), twoway(2, 2, med('concrete')));
add('center-material', 'grass median', 'dirt median', twoway(2, 2, med('grass')), twoway(2, 2, med('dirt', 0.5)));
add('center-width', 'grass median 2', 'grass median 6', twoway(2, 2, med('grass', 2)), twoway(2, 2, med('grass', 6)));
add('center-flush-raised', 'flush grass', 'raised grass', twoway(1, 1, med('grass', 3)), twoway(1, 1, med('grass', 2)));

// ── edges appear / vanish ──
add('edge-appears', 'no sidewalks', '+sidewalks', [b(), f()], twoway(1, 1));
add('edge-vanishes', '+sidewalks', 'no sidewalks', twoway(1, 1), [b(), f()]);
add('edge-verge', 'sidewalk', 'verge+sidewalk', twoway(1, 1), [ped(), verge(2), b(), f(), verge(2), ped()]);

// ── material seam (no geometry change, colour seam only) ──
add('material-seam', 'asphalt road', 'concrete road', twoway(1, 1, undefined, 'asphalt'), twoway(1, 1, undefined, 'concrete'));
add('material-seam', 'asphalt avenue', 'concrete avenue', twoway(2, 2, med('grass'), 'asphalt'), twoway(2, 2, med('grass'), 'concrete'));

// ── width-only change ──
add('width-only', 'lanes 3.5', 'lanes 3.0', twoway(2, 2), sidewalks([b('asphalt', 3), b('asphalt', 3), f('asphalt', 3), f('asphalt', 3)]));

// ── symmetric / asymmetric widen ──
add('symmetric-widen', 'street', 'avenue', twoway(1, 1), twoway(2, 2));
add('asymmetric', 'avenue+grass', 'off-centre 1|3', twoway(2, 2, med('grass')), sidewalks([b(), med('grass'), f(), f(), f()]));
add('big-jump', 'street', 'highway', twoway(1, 1), twoway(3, 3, med('concrete', 3)));

// ── one-way count change with alignment intent (the ambiguous case) ──
add('oneway-count', 'oneway2', 'oneway4 (2 turn + 2 straight)', oneway(2), oneway(4));

// ── the user's chained complex-intersection configs ──
add('user-chain', '2x2 grass median', '2back|3fwd no median', twoway(2, 2, med('grass')), sidewalks([b(), b(), f(), f(), f()]));
add('user-chain', '2back|3fwd', 'wide 5.5 median', sidewalks([b(), b(), f(), f(), f()]), twoway(2, 2, med('grass', 5.5)));
add('user-chain', '3back|2fwd off-median', '2x2 grass median', sidewalks([b(), b(), b(), med('grass', 3), f(), f()]), twoway(2, 2, med('grass')));

// ── orientation variants: mirror (flip the stack) + reversed draw direction ──
const mirror = (lanes: Lane[]): Lane[] =>
	[...lanes].reverse().map((l) => ({
		...l,
		direction: l.direction === 'forward' ? 'backward' : l.direction === 'backward' ? 'forward' : 'bidirectional'
	}));
add('orient-mirror', 'avenue+grass (mirrored)', '2x3 (mirrored)', mirror(twoway(2, 2, med('grass'))), mirror(twoway(2, 3, med('grass'))));

// ───────────────────────────────────────────────────────────────────────────
// Max 3 cells per row so the matrix reads top-to-bottom.
const COLS = 3;
const CELL_W = 190;
const CELL_H = 80;
const SEG_LEN = 60;

interface NodeOut {
	id: string;
	x: number;
	y: number;
	label?: string;
}
interface SegOut {
	id: string;
	startNodeId: string;
	endNodeId: string;
	lanes: Lane[];
}
interface ManifestEntry {
	index: number;
	cls: string;
	a: string;
	b: string;
	midNodeId: string;
	reversed: boolean;
}

const nodes: NodeOut[] = [];
const segments: SegOut[] = [];
const manifest: ManifestEntry[] = [];

cases.forEach((c, i) => {
	const col = i % COLS;
	const row = Math.floor(i / COLS);
	const x0 = col * CELL_W;
	const y = row * CELL_H;

	const start = `node-${i}-s`;
	const mid = `node-${i}-m`;
	const end = `node-${i}-e`;
	// Half the cells draw B→A (reversed draw direction) so the start/end frame is
	// exercised on both sides — an arm that starts at the node vs ends at it.
	const reversed = i % 2 === 1;

	nodes.push({ id: start, x: x0, y });
	nodes.push({ id: mid, x: x0 + SEG_LEN, y, label: `#${i} ${c.cls}` });
	nodes.push({ id: end, x: x0 + 2 * SEG_LEN, y });

	if (!reversed) {
		segments.push({ id: `segment-${i}-a`, startNodeId: start, endNodeId: mid, lanes: c.A });
		segments.push({ id: `segment-${i}-b`, startNodeId: mid, endNodeId: end, lanes: c.B });
	} else {
		segments.push({ id: `segment-${i}-a`, startNodeId: mid, endNodeId: start, lanes: c.A });
		segments.push({ id: `segment-${i}-b`, startNodeId: end, endNodeId: mid, lanes: c.B });
	}

	manifest.push({ index: i, cls: c.cls, a: c.a, b: c.bLabel, midNodeId: mid, reversed });
});

writeFileSync('static/fixtures/_lc-transitions.json', JSON.stringify({ nodes, segments }, null, '\t'));
writeFileSync('static/fixtures/_lc-manifest.json', JSON.stringify({ kind: 'transitions', cols: COLS, cases: manifest }, null, '\t'));

// ───────────────────────────────────────────────────────────────────────────
// Junctions: 3 / 4 / 5-arm intersections with the variations to stress the
// connector-derived turn-pocket + buffer-taper work. Each arm is drawn
// centre→outer, so BACKWARD lanes are incoming (the approach) and FORWARD lanes
// are outgoing. Connectivity is left at default — toggle a lane's straight
// connector off in-app to make it turn-only (a turn pocket).
interface JArm {
	deg: number;
	lanes: Lane[];
}
interface JCase {
	label: string;
	arms: JArm[];
	slip?: [number, number]; // one-way bypass between two arm outers (rough slip)
}
const a = (deg: number, lanes: Lane[]): JArm => ({ deg, lanes });
const road = (inn: number, out: number, div?: Lane) => twoway(inn, out, div);
const grass = () => med('grass');

const junctions: JCase[] = [
	{ label: '4-way divided', arms: [a(0, road(2, 2, grass())), a(90, road(2, 2, grass())), a(180, road(2, 2, grass())), a(270, road(2, 2, grass()))] },
	{ label: '4-way undivided', arms: [a(0, road(2, 2)), a(90, road(2, 2)), a(180, road(2, 2)), a(270, road(2, 2))] },
	{ label: 'T 3-way', arms: [a(0, road(2, 2)), a(180, road(2, 2)), a(270, road(2, 2))] },
	{ label: 'Y 3-way', arms: [a(90, road(1, 1)), a(210, road(1, 1)), a(330, road(1, 1))] },
	{ label: '5-way', arms: [a(0, road(1, 1)), a(72, road(1, 1)), a(144, road(1, 1)), a(216, road(1, 1)), a(288, road(1, 1))] },
	{ label: '4-way sharp angles', arms: [a(0, road(2, 2)), a(55, road(2, 2)), a(180, road(2, 2)), a(235, road(2, 2))] },
	{ label: 'asymmetric major/minor', arms: [a(0, road(3, 3)), a(180, road(3, 3)), a(90, road(1, 1)), a(270, road(1, 1))] },
	{ label: 'turn pocket (W +1 in)', arms: [a(0, road(2, 2)), a(90, road(2, 2)), a(180, road(3, 2)), a(270, road(2, 2))] },
	{ label: '2 turn lanes (W +2 in)', arms: [a(0, road(2, 2)), a(90, road(2, 2)), a(180, road(4, 2)), a(270, road(2, 2))] },
	{ label: 'divided through + buffer (#379)', arms: [a(0, road(2, 2, grass())), a(180, road(2, 2, grass())), a(90, road(1, 1)), a(270, road(1, 1))] },
	{ label: 'slip lane (approx, refine manually)', arms: [a(0, road(2, 2)), a(90, road(2, 2)), a(180, road(2, 2)), a(270, road(2, 2))], slip: [2, 3] }
];

const JCOLS = 3;
const JCELL = 280;
const ARM_LEN = 62;
const round2 = (n: number) => Math.round(n * 100) / 100;
const jNodes: NodeOut[] = [];
const jSegs: SegOut[] = [];
const jManifest: { index: number; label: string; centerNodeId: string; arms: number }[] = [];

junctions.forEach((jc, i) => {
	const col = i % JCOLS;
	const row = Math.floor(i / JCOLS);
	const cx = col * JCELL;
	const cy = row * JCELL;
	const center = `node-j${i}c`;
	jNodes.push({ id: center, x: cx, y: cy, label: `J#${i} ${jc.label}` });
	const outerIds: string[] = [];
	jc.arms.forEach((arm, k) => {
		const rad = (arm.deg * Math.PI) / 180;
		const outer = `node-j${i}a${k}`;
		jNodes.push({ id: outer, x: round2(cx + Math.cos(rad) * ARM_LEN), y: round2(cy + Math.sin(rad) * ARM_LEN) });
		outerIds.push(outer);
		jSegs.push({ id: `segment-j${i}s${k}`, startNodeId: center, endNodeId: outer, lanes: arm.lanes });
	});
	if (jc.slip) {
		jSegs.push({
			id: `segment-j${i}slip`,
			startNodeId: outerIds[jc.slip[0]],
			endNodeId: outerIds[jc.slip[1]],
			lanes: oneway(1)
		});
	}
	jManifest.push({ index: i, label: jc.label, centerNodeId: center, arms: jc.arms.length });
});

writeFileSync('static/fixtures/_lc-junctions.json', JSON.stringify({ nodes: jNodes, segments: jSegs }, null, '\t'));
writeFileSync('static/fixtures/_lc-junctions-manifest.json', JSON.stringify({ kind: 'junctions', cols: JCOLS, cases: jManifest }, null, '\t'));

const byClass = new Map<string, number>();
for (const c of cases) byClass.set(c.cls, (byClass.get(c.cls) ?? 0) + 1);

console.log(`wrote ${cases.length} transition cells (${nodes.length} nodes, ${segments.length} segments)`);
console.log(`grid: ${COLS} cols × ${Math.ceil(cases.length / COLS)} rows, extent x 0..${(COLS - 1) * CELL_W + 2 * SEG_LEN}, y 0..${(Math.ceil(cases.length / COLS) - 1) * CELL_H}`);
console.log('\n=== mutation-class coverage ===');
for (const [cls, n] of [...byClass].sort()) console.log(`  ${cls.padEnd(22)} ${n}`);
console.log(`\nwrote ${junctions.length} junction cells (${jNodes.length} nodes, ${jSegs.length} segments) in ${JCOLS} cols`);
for (const jc of junctions) console.log(`  J ${jc.label} (${jc.arms.length} arms)`);
console.log('\nload in-app:  /?fixture=_lc-transitions   ·   /?fixture=_lc-junctions');
