import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import type { GraphData } from '../src/lib/core/types';
import { check } from '../src/lib/road-model/checks';
import type { Scene as Drawing } from '../src/lib/core/networks';
import {
	carDiff,
	carPart,
	editorDrawing,
	liveShape,
	logged,
	pieces,
	withoutFootpaths
} from './model';

// The drawing while things move (bun run test:jitter; the file name keeps it
// out of `bun test ./unit`). Every test graph and the neighbourhood example
// is rebuilt through one Networks as the editor rebuilds on every drag frame,
// told what each move wrote as the editor's graph tells it (`logged`),
// and each frame has to pass the drawing rules in road-model/checks.ts and
// draw exactly what a Networks built from scratch draws, so a cache that misses a change fails. Three parts: every
// node nudged one at a time and put back, nodes dragged by seeded random
// amounts, and a node walked into its neighbour until their junctions merge
// and back until they split. A failure names the graph and the move: rerun
// it to reproduce.

const GRAPHS: [string, GraphData][] = [
	...readdirSync('e2e/scenes')
		.filter((f) => f.endsWith('.json'))
		.sort()
		.map((f): [string, GraphData] => [
			f.replace('.json', ''),
			JSON.parse(readFileSync(`e2e/scenes/${f}`, 'utf8'))
		]),
	['neighbourhood', JSON.parse(readFileSync('static/examples/neighbourhood.json', 'utf8')).graph]
];

// Rules a graph already breaks on the current drawing, left out for that
// graph only.
const KNOWN: Record<string, string[]> = {
	// tee nudged south, or tee-e or tee-w north: tee-west's and tee-east's
	// lines cross tee's.
	'junction-materials': ['lines cross'],
	// b or c moved 5 m north or south: the merged junction's own lines cross.
	'tight-junction': ['lines cross: b+c and b+c'],
	// The same, its middle piece's lanes named apart (the merge walk's scene).
	'tight-link': ['lines cross: b+c and b+c'],
	// a or b moved toward the other, tightening the hairpin: the sidewalk on
	// the inside of the fold lies over the far lanes and their paint.
	'tight-bend': ['paint on sidewalk', 'sidewalk over asphalt']
};

type Live = ReturnType<typeof liveShape>;

let builds = 0;
let compared = 0;

function problems(name: string, scene: Drawing, more: string[] = []) {
	const known = [...(KNOWN[name] ?? []), ...more];
	return check(scene).filter((p) => !known.some((k) => p.startsWith(k)));
}

// The pieces drawn differently in `a` and `b`, or in only one of them.
function differ(a: Map<string, unknown>, b: Map<string, unknown>) {
	compared++;
	const ids = new Set([...a.keys(), ...b.keys()]);
	return [...ids].filter((id) => !Bun.deepEquals(a.get(id), b.get(id)));
}

// One drag frame through the reused drawing: what breaks the rules (unless
// `rules` is false), and every piece that differs from a fresh build.
function frame(
	name: string,
	graph: Live,
	draw: (g: Live) => Drawing,
	skip: string[] = [],
	rules = true
) {
	builds += 2;
	const scene = draw(graph);
	const stale = differ(pieces(scene), pieces(editorDrawing()(graph)));
	const found = [
		...(rules ? problems(name, scene, skip) : []),
		...stale.map((id) => `${id} differs from a fresh build`),
		...carsMoved(graph, scene)
	];
	return { scene, found };
}

// Where the graph has footpaths, whether its car roads draw (but for their
// paint) as a fresh build of the graph without them does (core/networks.ts).
function carsMoved(graph: Live, scene: Drawing) {
	const cars = [...graph.segments].filter(([, s]) => s.lanes.some((l) => l.role === 'vehicle'));
	if (cars.length === graph.segments.size) return [];
	builds++;
	const alone = liveShape(
		withoutFootpaths({
			nodes: [...graph.nodes.values()].map(({ id, x, y, junction }) => ({ id, x, y, junction })),
			segments: [...graph.segments.values()]
		})
	);
	return carDiff(carPart(scene), carPart(editorDrawing()(alone))).map(
		(d) => `the car roads differ from a build without the footpaths: ${d}`
	);
}

// A seeded generator (mulberry32), so a seed always makes the same drags.
function random(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Moves a node as select mode drags one: each curved road it ends keeps its
// control point in the frame of its two nodes.
function moveNode(graph: Live, id: string, x: number, y: number) {
	const node = graph.nodes.get(id)!;
	const frames = node.connectedSegments.flatMap((sid) => {
		const s = graph.segments.get(sid)!;
		if (!s.hasControlPoint) return [];
		const a = graph.nodes.get(s.startNodeId)!;
		const b = graph.nodes.get(s.endNodeId)!;
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const l2 = dx * dx + dy * dy;
		if (l2 < 1e-4) return [];
		const rx = s.controlX! - a.x;
		const ry = s.controlY! - a.y;
		return [{ s, a, b, u: (rx * dx + ry * dy) / l2, v: (dx * ry - dy * rx) / l2 }];
	});
	node.x = x;
	node.y = y;
	for (const { s, a, b, u, v } of frames) {
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		s.controlX = a.x + u * dx - v * dy;
		s.controlY = a.y + u * dy + v * dx;
	}
}

// Puts nodes and the control points of their roads back exactly where they
// are now, so the drawing at home can be compared with the one before.
function holdHome(graph: Live, ids: string[]) {
	const nodes = ids.map((id) => {
		const n = graph.nodes.get(id)!;
		return [n, n.x, n.y] as const;
	});
	const controls = ids.flatMap((id) =>
		graph.nodes.get(id)!.connectedSegments.map((sid) => {
			const s = graph.segments.get(sid)!;
			return [s, s.controlX, s.controlY] as const;
		})
	);
	return () => {
		for (const [n, x, y] of nodes) [n.x, n.y] = [x, y];
		for (const [s, x, y] of controls) [s.controlX, s.controlY] = [x, y];
	};
}

// A whole city takes seconds to check and most of a second to build fresh,
// so its nodes are not nudged one at a time: a sample spread across the map
// (each node, in id order, kept if it is SPREAD m from every one kept
// before) moves together, far enough apart that no road or junction feels
// two of them. Only the large moves east and west are checked against the
// rules there; every move is put back and compared with the drawing before.
const CITY_NODES = 100;
const SPREAD = 80;
// A city's nudges take a minute and a half: three rule checks of it, most
// of the time, and in each frame two builds of it from scratch, one without
// its footpaths. Twice that leaves room for a busy machine.
const CITY_TIME = 240_000;

function moveGroups(graph: Live) {
	const ids = [...graph.nodes.keys()].sort();
	if (ids.length <= CITY_NODES) return ids.map((id) => [id]);
	const kept: { x: number; y: number }[] = [];
	const sample = ids.filter((id) => {
		const n = graph.nodes.get(id)!;
		if (kept.some((k) => Math.hypot(k.x - n.x, k.y - n.y) < SPREAD)) return false;
		kept.push(n);
		return true;
	});
	return [sample];
}

// Each node moves east, west, north and south by a small and a large step.
const NUDGES = [0.5, 5];
const DIRECTIONS = [
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1]
];

for (const [name, data] of GRAPHS) {
	test(
		`${name}: every node nudged and put back draws cleanly and freshly`,
		() => {
			const city = data.nodes.length > CITY_NODES;
			const graph = logged(liveShape(structuredClone(data)));
			const draw = editorDrawing();
			const first = frame(name, graph, draw);
			const failures = first.found.map((p) => `${name} at rest: ${p}`);
			const home = pieces(first.scene);
			for (const group of moveGroups(graph)) {
				const label = group.length === 1 ? group[0] : `${group.length} spread nodes`;
				const back = holdHome(graph, group);
				for (const d of NUDGES)
					for (const [dx, dy] of DIRECTIONS) {
						const move = `${label} moved (${dx * d}, ${dy * d})`;
						for (const id of group) {
							const n = graph.nodes.get(id)!;
							moveNode(graph, id, n.x + dx * d, n.y + dy * d);
						}
						const rules = !city || (d === NUDGES.at(-1) && dy === 0);
						for (const p of frame(name, graph, draw, [], rules).found)
							failures.push(`${name} ${move}: ${p}`);
						back();
						builds++;
						for (const id of differ(pieces(draw(graph)), home))
							failures.push(`${name} ${move} and put back: ${id} differs from before`);
					}
			}
			expect(failures).toEqual([]);
		},
		CITY_TIME
	);
}

// Random drags, for moves the nudges never combine: each step moves
// MOVED_PER_NODE of the graph's nodes (at least one) by STEP, never further
// than DRIFT from home.
const SEEDS = [1, 2];
const STEPS = 8;
const CITY = { seeds: [1], steps: 1 };
const MOVED_PER_NODE = 1 / 20;
const STEP = { min: 0.25, max: 3 };
const DRIFT = 6;

for (const [name, data] of GRAPHS) {
	const city = data.nodes.length > CITY_NODES;
	const seeds = city ? CITY.seeds : SEEDS;
	const steps = city ? CITY.steps : STEPS;
	test(`${name}: nodes dragged at random draw cleanly and freshly`, () => {
		const failures: string[] = [];
		for (const seed of seeds) {
			const rand = random(seed);
			const graph = logged(liveShape(structuredClone(data)));
			const draw = editorDrawing();
			const ids = [...graph.nodes.keys()];
			const home = new Map([...graph.nodes].map(([id, n]) => [id, { x: n.x, y: n.y }]));
			const moved = Math.max(1, Math.round(ids.length * MOVED_PER_NODE));
			// The nudges have checked the graph at rest.
			draw(graph);
			for (let step = 1; step <= steps; step++) {
				for (let k = 0; k < moved; k++) {
					const id = ids[Math.floor(rand() * ids.length)];
					const n = graph.nodes.get(id)!;
					const h = home.get(id)!;
					const a = rand() * Math.PI * 2;
					const d = STEP.min + rand() * (STEP.max - STEP.min);
					let x = n.x + Math.cos(a) * d;
					let y = n.y + Math.sin(a) * d;
					const off = Math.hypot(x - h.x, y - h.y);
					if (off > DRIFT) {
						x = h.x + ((x - h.x) * DRIFT) / off;
						y = h.y + ((y - h.y) * DRIFT) / off;
					}
					moveNode(graph, id, x, y);
				}
				const { found } = frame(name, graph, draw);
				if (found.length) {
					failures.push(`${name} seed ${seed} step ${step}: ${found.join('; ')}`);
					break;
				}
			}
		}
		expect(failures).toEqual([]);
	}, 120_000);
}

// Graphs walked: a node of two or more roads moved toward the nearest node
// it shares a road with, which also has two or more (2 m steps, 0.5 m in the
// last 15 m), until the road between them is gone and their junctions draw as
// one, two steps on, then back home, where they are two again and draw just
// as before the walk. Where they first draw as one, the walk steps back and
// crosses that last step again in FINE steps; walking home crosses it the
// same way. Each lists the rules it breaks on the current drawing, left out
// of its walk.
const WALKS: Record<string, string[]> = {
	// Nearing the merge, sidewalk runs over asphalt, w1j1's lines cross j1's,
	// and in the last 1.5 m before the two junctions draw as one their corner
	// sidewalks lie over each other.
	offset: ['sidewalk over asphalt', 'lines cross', 'double cover: j1 and j2 walk|concrete'],
	// tight-junction's road, its 5 m middle piece's lanes named apart from the
	// rest, so b and c are nodes of two roads (not one road carried on).
	'tight-link': []
};
const PAST_MERGE = 2;
const FINE = 0.05;

for (const [name, skip] of Object.entries(WALKS)) {
	test(`${name}: a junction walked into its neighbour merges, and splits walked back`, () => {
		const data = GRAPHS.find(([n]) => n === name)![1];
		const graph = logged(liveShape(structuredClone(data)));
		const draw = editorDrawing();
		const length = (sid: string) => {
			const s = graph.segments.get(sid)!;
			const a = graph.nodes.get(s.startNodeId)!;
			const b = graph.nodes.get(s.endNodeId)!;
			return Math.hypot(b.x - a.x, b.y - a.y);
		};
		const link = [...graph.segments.values()]
			.filter((s) =>
				[s.startNodeId, s.endNodeId].every(
					(id) => graph.nodes.get(id)!.connectedSegments.length >= 2
				)
			)
			.sort((a, b) => length(a.id) - length(b.id))[0];
		const node = graph.nodes.get(link.startNodeId)!;
		const toward = graph.nodes.get(link.endNodeId)!;
		const from = { x: node.x, y: node.y };
		const goHome = holdHome(graph, [node.id]);
		const span = length(link.id);
		const failures: string[] = [];
		let step = 0;
		const at = (d: number) => {
			if (d === 0) goHome();
			else {
				const f = d / span;
				moveNode(
					graph,
					node.id,
					from.x + (toward.x - from.x) * f,
					from.y + (toward.y - from.y) * f
				);
			}
			const { scene, found } = frame(name, graph, draw, skip);
			for (const p of found)
				failures.push(`${name} walk ${link.id} step ${step} (${d.toFixed(2)} m): ${p}`);
			step++;
			return scene;
		};
		const before = structuredClone(pieces(at(0)));
		const merged = (scene: Drawing) => !scene.place.roads.some((r) => r.id === link.id);
		const out: number[] = [];
		let past = -1;
		for (let d = 0; past < PAST_MERGE; ) {
			d += span - d > 15 ? 2 : 0.5;
			if (d >= span) break;
			const scene = at(d);
			if (past >= 0) past++;
			else if (merged(scene)) {
				const last = out.at(-1) ?? 0;
				for (let k = 1; last + k * FINE < d - FINE / 2; k++) {
					out.push(last + k * FINE);
					at(out.at(-1)!);
				}
				at(d);
				past = 0;
			}
			out.push(d);
		}
		let scene: Drawing | undefined;
		for (const d of [...out.slice(0, -1).reverse(), 0]) scene = at(d);
		expect(failures).toEqual([]);
		expect(past >= 0, `${link.id} never merged`).toBe(true);
		expect(merged(scene!), `${link.id} still merged at home`).toBe(false);
		expect(differ(pieces(scene!), before), 'drawn differently after the walk').toEqual([]);
	}, 120_000);
}

test('builds checked', () => {
	console.log(`${builds} builds, ${compared} drawings compared`);
});
