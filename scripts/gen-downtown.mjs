// Generates static/fixtures/downtown.json — a DC-ish sampler: a street grid,
// a divided avenue, a diagonal avenue through the squares, turn-lane
// approaches, a roundabout, and a footpath. Run: bun scripts/gen-downtown.mjs
import { writeFileSync } from 'node:fs';

const nodes = [];
const segments = [];
const nodeId = new Map();

function node(id, x, y) {
	if (!nodeId.has(id)) {
		nodeId.set(id, true);
		nodes.push({ id, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 });
	}
	return id;
}

function seg(id, start, end, lanes, control) {
	const s = { id, startNodeId: start, endNodeId: end, lanes };
	if (control) {
		s.controlX = Math.round(control.x * 100) / 100;
		s.controlY = Math.round(control.y * 100) / 100;
	}
	segments.push(s);
}

const L = {
	street: () => [
		{ type: 'sidewalk', width: 2, direction: 'bidirectional' },
		{ type: 'road', width: 3, direction: 'backward' },
		{ type: 'road', width: 3, direction: 'forward' },
		{ type: 'sidewalk', width: 2, direction: 'bidirectional' }
	],
	avenue: () => [
		{ type: 'sidewalk', width: 3, direction: 'bidirectional' },
		{ type: 'road', width: 3.5, direction: 'backward' },
		{ type: 'road', width: 3.5, direction: 'backward' },
		{ type: 'median', width: 2, direction: 'bidirectional' },
		{ type: 'road', width: 3.5, direction: 'forward' },
		{ type: 'road', width: 3.5, direction: 'forward' },
		{ type: 'sidewalk', width: 3, direction: 'bidirectional' }
	],
	// An avenue approach with a dedicated right-turn pocket on the forward side.
	avenueTurn: () => [
		{ type: 'sidewalk', width: 3, direction: 'bidirectional' },
		{ type: 'road', width: 3.5, direction: 'backward' },
		{ type: 'road', width: 3.5, direction: 'backward' },
		{ type: 'median', width: 2, direction: 'bidirectional' },
		{ type: 'road', width: 3.5, direction: 'forward' },
		{ type: 'road', width: 3.5, direction: 'forward' },
		{ type: 'turn', width: 3, direction: 'forward', turn: 'right' },
		{ type: 'sidewalk', width: 3, direction: 'bidirectional' }
	],
	// A street approach with a left-turn pocket between the two travel lanes.
	streetTurn: () => [
		{ type: 'sidewalk', width: 2, direction: 'bidirectional' },
		{ type: 'road', width: 3, direction: 'backward' },
		{ type: 'turn', width: 3, direction: 'forward', turn: 'left' },
		{ type: 'road', width: 3, direction: 'forward' },
		{ type: 'sidewalk', width: 2, direction: 'bidirectional' }
	],
	path: () => [{ type: 'sidewalk', width: 2.5, direction: 'bidirectional' }]
};

// --- Street grid (6x6 nodes, 5x5 blocks) ----------------------------------
const N = 6;
const S = 95;
const O = -((N - 1) * S) / 2;
const g = (r, c) => `g-${r}-${c}`;
for (let r = 0; r < N; r++) {
	for (let c = 0; c < N; c++) {
		node(g(r, c), O + c * S, O + r * S);
	}
}

const AVENUE_ROW = 2; // one horizontal divided avenue cutting across
for (let r = 0; r < N; r++) {
	for (let c = 0; c < N - 1; c++) {
		const lanes = r === AVENUE_ROW ? L.avenue() : L.street();
		seg(`h-${r}-${c}`, g(r, c), g(r, c + 1), lanes);
	}
}
for (let r = 0; r < N - 1; r++) {
	for (let c = 0; c < N; c++) {
		seg(`v-${r}-${c}`, g(r, c), g(r + 1, c), L.street());
	}
}

// NOTE: a 45° diagonal through the grid nodes makes 5–6-arm blobs and
// shallow-angle merges (the renderer wants traffic circles at those crossings,
// like real DC). Left out until the circle-integrated version is built.

// --- Turn-lane approaches into the central square --------------------------
// Replace the four arms touching g(2,3) with turn-pocket approaches so a busy
// junction shows turn lanes (both the avenue and a cross street).
const turnH = segments.find((s) => s.id === 'h-2-2');
if (turnH) turnH.lanes = L.avenueTurn();
const turnV = segments.find((s) => s.id === 'v-1-3');
if (turnV) turnV.lanes = L.streetTurn();

// --- Footpath cutting across a block --------------------------------------
node('park-a', O + 0.5 * S, O + 3.5 * S);
node('park-b', O + 1.5 * S, O + 4.5 * S);
seg('path-0', 'park-a', 'park-b', L.path(), { x: O + 1.5 * S, y: O + 3.5 * S });
seg('path-link-a', g(3, 0), 'park-a', L.path());
seg('path-link-b', g(4, 1), 'park-b', L.path());

// --- Roundabout east of the grid ------------------------------------------
const RC = { x: O + (N - 1) * S + 70, y: 0 };
const RR = 26;
const RING = 6;
const ringId = (i) => `rb-${i}`;
for (let i = 0; i < RING; i++) {
	const a = (i / RING) * Math.PI * 2;
	node(ringId(i), RC.x + Math.cos(a) * RR, RC.y + Math.sin(a) * RR);
}
const ringControl = RR / Math.cos(Math.PI / RING);
for (let i = 0; i < RING; i++) {
	const next = (i + 1) % RING;
	const mid = ((i + 0.5) / RING) * Math.PI * 2;
	seg(`rb-seg-${i}`, ringId(i), ringId(next), [{ type: 'road', width: 5, direction: 'forward' }], {
		x: RC.x + Math.cos(mid) * ringControl,
		y: RC.y + Math.sin(mid) * ringControl
	});
}
// Connect the roundabout to the grid (west spoke) and give it three stubs.
seg('rb-spoke-w', g(3, N - 1), ringId(3), L.street());
const spokes = [
	{ i: 0, dx: 60, dy: 0 },
	{ i: 1, dx: 35, dy: -55 },
	{ i: 5, dx: 35, dy: 55 }
];
for (const sp of spokes) {
	const end = `rb-stub-${sp.i}`;
	const a = (sp.i / RING) * Math.PI * 2;
	node(
		end,
		RC.x + Math.cos(a) * (RR + 55) + sp.dx * 0.4,
		RC.y + Math.sin(a) * (RR + 55) + sp.dy * 0.4
	);
	seg(`rb-spoke-${sp.i}`, ringId(sp.i), end, L.street());
}

writeFileSync(
	new URL('../static/fixtures/downtown.json', import.meta.url),
	JSON.stringify({ nodes, segments }, null, '\t') + '\n'
);
console.log(`downtown.json: ${nodes.length} nodes, ${segments.length} segments`);
