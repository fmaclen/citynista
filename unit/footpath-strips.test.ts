import { expect, test } from 'bun:test';
import type { Scene } from '../src/lib/core/networks';
import type { GraphData, Lane } from '../src/lib/core/types';
import { check } from '../src/lib/road-model/checks';
import {
	area,
	inside,
	piecesOf,
	subtract,
	toPath,
	union,
	type Paths
} from '../src/lib/road-model/clip';
import type { Surface } from '../src/lib/road-model/description';
import type { Pt } from '../src/lib/road-model/model';
import { hullOf, offsetPoint, TAPER } from '../src/lib/road-model/geometry';
import { bendAt, oneWay } from './bends';
import { buildModel } from './model';
import { copySegments, layPaste } from '../src/lib/clipboard';
import { resolveCrossings } from '../src/lib/core/crossings';
import { Graph } from '../src/lib/core/graph.svelte';
import { openEditor } from './editor.svelte';

// Footpaths meeting at one node `m` at the origin, each a strip
// (core/footpaths.ts): its lanes side by side along its line. Three or more
// are paved right up to `m`, the ground between them there filled; two are a
// bend, both strips stopping short of `m` and the bend paving the way round
// between them as a street's bend does.

const walk = (id: string, width: number): Lane => ({
	id,
	role: 'pedestrian',
	material: 'concrete',
	direction: 'bidirectional',
	width
});

// One path per arm, 20 m out from m at `deg` degrees, of walks `widths`
// wide; every other one drawn into m rather than out of it.
interface Arm {
	deg: number;
	widths: number[];
}
function star(arms: Arm[]): GraphData {
	const nodes = [{ id: 'm', x: 0, y: 0 }];
	const segments = arms.map((arm, i) => {
		const a = (arm.deg * Math.PI) / 180;
		nodes.push({ id: `n${i}`, x: 20 * Math.cos(a), y: 20 * Math.sin(a) });
		const [startNodeId, endNodeId] = i % 2 ? [`n${i}`, 'm'] : ['m', `n${i}`];
		const lanes = arm.widths.map((w, k) => walk(`w${k}`, w));
		return { id: `p${i}`, startNodeId, endNodeId, lanes };
	});
	return { nodes, segments };
}

const shapeOf = (s: Surface): Paths =>
	'left' in s.shape
		? [toPath([...s.shape.left, ...[...s.shape.right].reverse()])]
		: s.shape.map(toPath);
const sum = (paths: Paths) => paths.reduce((s, p) => s + Math.abs(area(p)), 0);
const ground = (scene: Scene) =>
	union(
		[
			...scene.place.roads.map((r) => scene.road(r.id)!),
			...scene.place.junctions.map((j) => scene.node(j.id)!)
		].flatMap((d) => d.surfaces.flatMap(shapeOf))
	);

// Each path's cross-section where it meets m, its two outer edges.
function edgesAtNode(data: GraphData) {
	return data.segments.map((s) => {
		const far = data.nodes.find(
			(n) => n.id === (s.startNodeId === 'm' ? s.endNodeId : s.startNodeId)
		)!;
		const l = Math.hypot(far.x, far.y);
		const out = { x: far.x / l, y: far.y / l };
		// The right normal of its drawing direction.
		const along = s.startNodeId === 'm' ? out : { x: -out.x, y: -out.y };
		const n = { x: -along.y, y: along.x };
		const half = s.lanes.reduce((w, lane) => w + lane.width, 0) / 2;
		return [offsetPoint({ x: 0, y: 0 }, n, -half), offsetPoint({ x: 0, y: 0 }, n, half)];
	});
}

// What a drawing of `data` must hold: each path drawn whole from m to its far
// node, the ground between their ends at m covered, and all of it one piece
// that keeps the drawing rules.
function expectMet(data: GraphData) {
	const { scene } = buildModel(data);
	expect(check(scene)).toEqual([]);
	for (const s of data.segments) {
		const road = scene.place.roads.find((r) => r.id === s.id)!;
		const at = road.points[s.startNodeId === 'm' ? 0 : road.points.length - 1];
		expect(Math.hypot(at.x, at.y)).toBeLessThan(1e-9);
		expect(scene.road(s.id)!.path.length).toBeCloseTo(20, 6);
	}
	expect(scene.place.junctions.map((j) => j.id)).toEqual(['walk:m']);
	const drawn = ground(scene);
	const between = [toPath(hullOf(edgesAtNode(data).flat()))];
	expect(sum(subtract(between, drawn))).toBeLessThan(0.01);
	expect(piecesOf(drawn)).toHaveLength(1);
	return scene;
}

// Points `d` out from m at `deg` degrees.
const ray = (deg: number, d: number) => offsetPoint({ x: 0, y: 0 }, dir(deg), d);
const dir = (deg: number) => ({
	x: Math.cos((deg * Math.PI) / 180),
	y: Math.sin((deg * Math.PI) / 180)
});

// What a drawing of `data`, two footpaths meeting at m, must hold: both cut
// back the same from m and paved from there to their far nodes, the bend
// between them one piece whose walker's line turns on a circle that leaves
// each strip's middle line along it, its paving that line's half width
// either side, easing one way from one's to the other's, and all of it one
// piece that keeps the drawing rules.
function expectBend(data: GraphData) {
	const { scene } = buildModel(data);
	expect(check(scene)).toEqual([]);
	expect(scene.place.junctions.map((j) => j.id)).toEqual(['walk:m']);
	const bend = bendAt(scene, 'm', { x: 0, y: 0 });
	expect(bend.cuts[0]).toBeGreaterThan(0);
	expect(bend.cuts[1]).toBeCloseTo(bend.cuts[0], 6);
	for (const s of data.segments) {
		const road = scene.place.roads.find((r) => r.id === s.id)!;
		const at = road.points[s.startNodeId === 'm' ? 0 : road.points.length - 1];
		expect(Math.hypot(at.x, at.y)).toBeCloseTo(bend.cuts[0], 6);
		expect(scene.road(s.id)!.path.length).toBeCloseTo(20 - bend.cuts[0], 6);
	}
	expect(bend.pieces).toBe(1);
	expect(bend.offTangent).toBeLessThan(0.01);
	for (const off of bend.offEdge) expect(Math.abs(off)).toBeLessThan(0.02);
	expect(oneWay(bend.reach.left)).toBe(true);
	expect(oneWay(bend.reach.right)).toBe(true);
	expect(piecesOf(ground(scene))).toHaveLength(1);
	return { scene, bend };
}

// The radius a bend of two footpaths of half widths `halves` turns on where
// it has room: as a street's (TAPER.BEND_RADIUS half widths of the wider).
const ruled = (...halves: number[]) => TAPER.BEND_RADIUS * Math.max(...halves);

test('three and four footpaths of mixed widths meeting at a node are paved together right up to it', () => {
	expectMet(
		star([
			{ deg: 10, widths: [1.5] },
			{ deg: 100, widths: [2, 1] },
			{ deg: 220, widths: [4] }
		])
	);
	expectMet(
		star([
			{ deg: 0, widths: [2] },
			{ deg: 75, widths: [3.5] },
			{ deg: 160, widths: [1.5] },
			{ deg: 250, widths: [2, 2] }
		])
	);
});

test("a footpath's bend turns on a street's radius, tangent to both strips", () => {
	for (const [deg, widths] of [
		[115, [2, 3.5]],
		[80, [2, 2]],
		[150, [2, 2]],
		[50, [2.5, 2.5]]
	] as const) {
		const { bend } = expectBend(
			star([
				{ deg: 0, widths: [widths[0]] },
				{ deg, widths: [widths[1]] }
			])
		);
		// Both stop where a street's roads at that bend do: R tan(deflection
		// / 2), the deflection read no sharper than TAPER.SHARPEST, and never
		// less than TAPER.THROUGH_GAP.
		const tan = Math.tan(Math.min(bend.deflection, TAPER.SHARPEST) / 2);
		const cut = Math.max(TAPER.THROUGH_GAP, ruled(widths[0] / 2, widths[1] / 2) * tan);
		expect([deg, bend.cuts[0]]).toEqual([deg, expect.closeTo(cut, 6)]);
		// So the way round is an arc of the radius that cut gives: R where
		// the cut is R tan(deflection / 2).
		const r = cut / Math.tan(bend.deflection / 2);
		expect([deg, bend.radius]).toEqual([deg, expect.closeTo(r, 1)]);
		expect(bend.offCircle).toBeLessThan(0.01 * r);
	}
});

test("a sharp bend's paving passes inside its node, as a street's does", () => {
	const { bend } = expectBend(
		star([
			{ deg: 0, widths: [2.5] },
			{ deg: 35, widths: [2.5] }
		])
	);
	expect(bend.coversNode).toBe(false);
	// Its middle line passes the node on the inside of the bend.
	const closest = Math.min(...bend.round.map((p) => Math.hypot(p.x, p.y)));
	expect(closest).toBeGreaterThan(1.25);
});

test('a narrower footpath eases to the wider along the bend, its edges each going one way', () => {
	const { bend } = expectBend(
		star([
			{ deg: 0, widths: [2] },
			{ deg: 100, widths: [4] }
		])
	);
	// From the narrow one's half width to the wide one's, both sides.
	const narrowFirst = bend.ends[0].half < bend.ends[1].half;
	for (const reach of [bend.reach.left, bend.reach.right]) {
		const [first, last] = narrowFirst ? [reach[0], reach.at(-1)!] : [reach.at(-1)!, reach[0]];
		expect(first).toBeCloseTo(1, 1);
		expect(last).toBeCloseTo(2, 1);
	}
	expect(bend.radius).toBeCloseTo(ruled(1, 2), 1);
	// Run nearly straight on, the ease takes the short length a narrowing
	// sidewalk takes (TAPER.WALK_ALONG_PER_SHIFT a metre narrower), half
	// each side of the node.
	const straight = expectBend(
		star([
			{ deg: 0, widths: [6, 4] },
			{ deg: 178, widths: [2] }
		])
	);
	expect(straight.bend.cuts[0]).toBeCloseTo((TAPER.WALK_ALONG_PER_SHIFT * 4) / 2, 6);
});

test('a hairpin of two footpaths draws as one unbroken piece', () => {
	for (const [deg, widths] of [
		[12, [2, 3]],
		[8, [2, 10]],
		[2, [2, 2]]
	] as const) {
		const { scene } = buildModel(
			star([
				{ deg: 0, widths: [widths[0]] },
				{ deg, widths: [widths[1]] }
			])
		);
		expect([deg, check(scene)]).toEqual([deg, []]);
		const bend = bendAt(scene, 'm', { x: 0, y: 0 });
		expect([deg, bend.pieces]).toEqual([deg, 1]);
		expect([deg, piecesOf(ground(scene)).length]).toEqual([deg, 1]);
	}
});

// Drawn with the Path brush, straight, as the owner draws a bend: a hairpin
// (legs 12° apart) and a sharp bend (35°) are laid as clicked, two footpaths
// through the middle click, and paved round as one bend.
test('a hairpin and a sharp bend drawn with the Path brush are laid and paved as one bend', () => {
	for (const deg of [12, 35]) {
		const ui = openEditor({ nodes: [], segments: [] });
		ui.editor.activateSlot(3);
		ui.editor.setDrawStyle('straight');
		const a = (deg * Math.PI) / 180;
		for (const q of [
			{ x: 20, y: 0 },
			{ x: 0, y: 0 },
			{ x: 20 * Math.cos(a), y: 20 * Math.sin(a) }
		])
			ui.click(q.x, q.y);
		ui.key('Escape');
		ui.key('Escape');
		expect([deg, ui.editor.graph.segments.size]).toEqual([deg, 2]);
		const m = [...ui.editor.graph.nodes.values()].find((n) => Math.hypot(n.x, n.y) < 0.01)!;
		expect([deg, m.connectedSegments.length]).toEqual([deg, 2]);
		const scene = ui.editor.roadRenderer.scene!;
		expect([deg, check(scene)]).toEqual([deg, []]);
		expect([deg, bendAt(scene, m.id, m).pieces]).toEqual([deg, 1]);
	}
});

// A zigzag: a footpath turning 100° one way at m, then 3 m on at k the
// other way. Each bend shrinks to fit the short footpath between them, both
// stopping short of its middle so neither meets nor overruns the other.
test('a very short footpath between two bends keeps both bends apart', () => {
	const lanes = [walk('w', 2)];
	const data: GraphData = {
		nodes: [
			{ id: 'a', ...ray(80, 20) },
			{ id: 'm', x: 0, y: 0 },
			{ id: 'k', x: 3, y: 0 },
			{ id: 'b', ...offsetPoint({ x: 3, y: 0 }, dir(260), 20) }
		],
		segments: [
			{ id: 'in', startNodeId: 'a', endNodeId: 'm', lanes },
			{ id: 'short', startNodeId: 'm', endNodeId: 'k', lanes },
			{ id: 'out', startNodeId: 'k', endNodeId: 'b', lanes }
		]
	};
	const { scene } = buildModel(data);
	expect(check(scene)).toEqual([]);
	expect(piecesOf(ground(scene))).toHaveLength(1);
	const at = [bendAt(scene, 'm', { x: 0, y: 0 }), bendAt(scene, 'k', { x: 3, y: 0 })];
	for (const bend of at) {
		expect(bend.pieces).toBe(1);
		expect(bend.offTangent).toBeLessThan(0.01);
		expect(bend.radius).toBeLessThan(ruled(1));
		for (const off of bend.offEdge) expect(Math.abs(off)).toBeLessThan(0.02);
	}
	// The short footpath is still drawn between them.
	expect(at[0].cuts[0] + at[1].cuts[0]).toBeLessThan(3);
	expect(scene.road('short')!.path.length).toBeCloseTo(3 - at[0].cuts[0] - at[1].cuts[0], 6);
});

// A street 11 m wide bending 95° at s and a footpath alongside it, inside
// the bend 10 m off the street's line, bending the same at m: each turns on TAPER.BEND_RADIUS of its own half widths, both pulled back
// from their node by that radius times tan(deflection / 2).
test('a footpath beside a street bends as the street does', () => {
	const street = (id: string): Lane[] =>
		[2, 3.5, 3.5, 2].map((width, k) => ({
			id: `${id}${k}`,
			role: k === 0 || k === 3 ? 'pedestrian' : 'vehicle',
			material: k === 0 || k === 3 ? 'concrete' : 'asphalt',
			direction: k === 1 ? 'backward' : k === 2 ? 'forward' : 'bidirectional',
			width
		}));
	const turn = (95 * Math.PI) / 180;
	const leg = (o: Pt, a: number, r: number) => ({
		x: o.x + Math.cos(a) * r,
		y: o.y + Math.sin(a) * r
	});
	const s = { x: 0, y: 0 };
	// On the bisector between the street's two legs.
	const m = leg(s, Math.PI - turn / 2, 14);
	const data: GraphData = {
		nodes: [
			{ id: 's0', ...leg(s, Math.PI, 40) },
			{ id: 's', ...s },
			{ id: 's1', ...leg(s, Math.PI - turn, 40) },
			{ id: 'm0', ...leg(m, Math.PI, 40) },
			{ id: 'm', ...m },
			{ id: 'm1', ...leg(m, Math.PI - turn, 40) }
		],
		segments: [
			{ id: 'sa', startNodeId: 's0', endNodeId: 's', lanes: street('a') },
			{ id: 'sb', startNodeId: 's', endNodeId: 's1', lanes: street('b') },
			{ id: 'ma', startNodeId: 'm0', endNodeId: 'm', lanes: [walk('w', 2)] },
			{ id: 'mb', startNodeId: 'm', endNodeId: 'm1', lanes: [walk('w', 2)] }
		]
	};
	const { scene } = buildModel(data);
	expect(check(scene)).toEqual([]);
	const bend = bendAt(scene, 'm', m);
	const pulled = (id: string, k: 0 | -1) => {
		const p = scene.place.roads.find((r) => r.id === id)!.points.at(k)!;
		return Math.hypot(p.x - s.x, p.y - s.y);
	};
	const tan = Math.tan((Math.PI - turn) / 2);
	expect(bend.radius).toBeCloseTo(ruled(1), 1);
	expect(bend.cuts[0] / ruled(1)).toBeCloseTo(tan, 6);
	expect(pulled('sa', -1) / ruled(5.5)).toBeCloseTo(tan, 6);
	expect(pulled('sb', 0) / ruled(5.5)).toBeCloseTo(tan, 6);
});

// Two footpaths sharing both their nodes, a 10 m curve leaving a 2 m path
// at a shallow angle at each end: the open ground between them closes to a
// sharp tip where their edges cross, which is no spike of the paving.
test('a wide footpath sharing both nodes with a narrow one at a shallow angle keeps the drawing rules', () => {
	const data: GraphData = {
		nodes: [
			{ id: 'a', x: -37, y: 0 },
			{ id: 'b', x: 37, y: 0 }
		],
		segments: [
			{ id: 'straight', startNodeId: 'a', endNodeId: 'b', lanes: [walk('w', 2)] },
			{
				id: 'curve',
				startNodeId: 'a',
				endNodeId: 'b',
				lanes: [walk('w', 10)],
				controlX: 0,
				controlY: 26
			}
		]
	};
	const { scene } = buildModel(data);
	expect(check(scene)).toEqual([]);
	expect(piecesOf(ground(scene))).toHaveLength(1);
});

// The same curve run on past each node, so three footpaths meet at each:
// its inside corners there are read along the line each footpath leaves
// the node on, which the curve leaves within metres, so each is rounded
// only as far as both run straight on.
test('a corner beside a curving footpath is rounded only where both run straight', () => {
	const data: GraphData = {
		nodes: [
			{ id: 'a', x: -37, y: 0 },
			{ id: 'b', x: 37, y: 0 },
			{ id: 'w', x: -45, y: 0 },
			{ id: 'e', x: 45, y: 0 }
		],
		segments: [
			{ id: 'straight', startNodeId: 'a', endNodeId: 'b', lanes: [walk('w', 2)] },
			{
				id: 'curve',
				startNodeId: 'a',
				endNodeId: 'b',
				lanes: [walk('w', 10)],
				controlX: 0,
				controlY: 26
			},
			{
				id: 'west',
				startNodeId: 'w',
				endNodeId: 'a',
				lanes: [walk('w', 10)],
				controlX: -42,
				controlY: 2
			},
			{
				id: 'east',
				startNodeId: 'b',
				endNodeId: 'e',
				lanes: [walk('w', 10)],
				controlX: 42,
				controlY: 2
			}
		]
	};
	const { scene } = buildModel(data);
	expect(check(scene)).toEqual([]);
});

test("a joint's inside corners are rounded to a circle as wide as the paths, its outside round the node", () => {
	const scene = expectMet(
		star([
			{ deg: 0, widths: [2] },
			{ deg: 80, widths: [2] },
			{ deg: 120, widths: [2] }
		])
	);
	const drawn = ground(scene);
	// Between 0° and 80° the inner edges cross 1 / sin 40° out along the
	// bisector; a circle of radius 1 touching both reaches 1 / sin 40° - 1
	// past that.
	const s = Math.sin((40 * Math.PI) / 180);
	expect(inside(drawn, ray(40, 1 / s + (1 / s - 1) - 0.02))).toBe(true);
	expect(inside(drawn, ray(40, 1 / s + (1 / s - 1) + 0.02))).toBe(false);
	// Between 120° and 360°, wider than straight on: round the node, 1 m out.
	for (const deg of [220, 240, 260]) {
		expect([deg, inside(drawn, ray(deg, 0.98))]).toEqual([deg, true]);
		expect([deg, inside(drawn, ray(deg, 1.03))]).toEqual([deg, false]);
	}
});

test("a joint holds a walker's line between each two footpaths, on the paving and along each one's middle", () => {
	for (const arms of [
		[
			{ deg: 10, widths: [1.5] },
			{ deg: 100, widths: [2, 1] },
			{ deg: 220, widths: [4] }
		],
		[
			{ deg: 0, widths: [2] },
			{ deg: 75, widths: [3.5] },
			{ deg: 160, widths: [1.5] },
			{ deg: 250, widths: [2, 2] }
		]
	]) {
		const data = star(arms);
		const scene = expectMet(data);
		const drawn = ground(scene);
		const lines = scene.node('walk:m')!.paths;
		const n = arms.length;
		expect(lines).toHaveLength((n * (n - 1)) / 2);
		for (const { from, to, line } of lines) {
			for (const p of line)
				expect([from.road, to.road, p, inside(drawn, p)]).toEqual([from.road, to.road, p, true]);
			// Starting and ending on each one's middle line, out along it.
			for (const [ref, p] of [
				[from, line[0]],
				[to, line.at(-1)!]
			] as const) {
				const arm = arms[Number(ref.road.slice(1))];
				const d = dir(arm.deg);
				expect(Math.abs(d.x * p.y - d.y * p.x)).toBeLessThan(1e-6);
				expect(d.x * p.x + d.y * p.y).toBeGreaterThan(0.5);
			}
		}
	}
});

test("a bend's walker's line is its middle line, run on along each strip's middle", () => {
	const { scene, bend } = expectBend(
		star([
			{ deg: 0, widths: [2] },
			{ deg: 80, widths: [2] }
		])
	);
	const drawn = ground(scene);
	expect(scene.node('walk:m')!.paths).toHaveLength(1);
	for (const p of bend.line) expect([p, inside(drawn, p)]).toEqual([p, true]);
	// From JOINT.LINK (3 m) out along each strip's middle.
	for (const [p, deg] of [
		[bend.line[0], 0],
		[bend.line.at(-1)!, 80]
	] as const) {
		const d = dir(deg);
		expect(Math.abs(d.x * p.y - d.y * p.x)).toBeLessThan(1e-6);
		expect(d.x * p.x + d.y * p.y).toBeCloseTo(Math.max(3, bend.cuts[0]), 6);
	}
});

test('a second lane given to one footpath widens it alone', () => {
	const arms: Arm[] = [
		{ deg: 0, widths: [2] },
		{ deg: 100, widths: [2] },
		{ deg: 210, widths: [3] }
	];
	const before = buildModel(star(arms)).scene;
	const widened = star(arms.map((a, i) => (i === 1 ? { ...a, widths: [2, 1.5] } : a)));
	const after = expectMet(widened);
	for (const id of ['p0', 'p2']) expect(after.road(id)).toEqual(before.road(id)!);
	const width = (scene: Scene) => sum(union(scene.road('p1')!.surfaces.flatMap(shapeOf)));
	expect(width(after)).toBeCloseTo((width(before) * 3.5) / 2, 1);
});

// A bend of two: a second lane given to one widens it and the bend, and
// changes the other only where the bend takes it over (it is cut back to
// the wider bend's start), its lanes and far end as they were.
test('a second lane given to one footpath of a bend changes the other only where the bend takes it over', () => {
	const arms: Arm[] = [
		{ deg: 0, widths: [2] },
		{ deg: 100, widths: [2] }
	];
	const before = expectBend(star(arms));
	const after = expectBend(star(arms.map((a, i) => (i === 1 ? { ...a, widths: [2, 1.5] } : a))));
	expect(after.bend.cuts[0]).toBeGreaterThan(before.bend.cuts[0]);
	const [was, now] = [before.scene.road('p0')!, after.scene.road('p0')!];
	expect(now.lanes).toEqual(was.lanes);
	expect(now.edges.map((e) => e.at(-1))).toEqual(was.edges.map((e) => e.at(-1)));
	expect(now.path.length).toBeCloseTo(20 - after.bend.cuts[0], 6);
});

// The same pair as the editor lays it by a paste: the 10 m curve copied
// from (-45, 10)–(45, 10), bowed to (0, 40), and pasted centred on the
// path, its ends on the path's line beyond its nodes. Building cuts it at
// both of the path's nodes, which it passes over, so the two share a and b.
test('a wide footpath pasted with its ends beyond a narrow one’s nodes is cut at both and keeps the drawing rules', () => {
	const graph = new Graph();
	graph.fromJSON({
		nodes: [
			{ id: 'a', x: -37, y: 0 },
			{ id: 'b', x: 37, y: 0 },
			{ id: 's', x: -45, y: 10 },
			{ id: 't', x: 45, y: 10 }
		],
		segments: [
			{ id: 'straight', startNodeId: 'a', endNodeId: 'b', lanes: [walk('w', 2)] },
			{
				id: 'curve',
				startNodeId: 's',
				endNodeId: 't',
				lanes: [walk('w', 10)],
				controlX: 0,
				controlY: 40
			}
		]
	});
	const clipboard = copySegments({ graph, selectedSegments: ['curve'] })!;
	graph.deleteSegment('curve');
	graph.deleteNode('s');
	graph.deleteNode('t');
	// Place mode centres the copy's nodes' middle, (0, 10), on the pointer.
	const { segmentIds } = layPaste(graph, clipboard, {
		translation: { dx: 0, dy: -10 },
		snap: null
	});
	resolveCrossings(graph, segmentIds.values());
	const between = [...graph.segments.values()].filter(
		(s) => [s.startNodeId, s.endNodeId].sort().join() === 'a,b'
	);
	expect(between).toHaveLength(2);
	expect(check(buildModel(graph.toJSON()).scene)).toEqual([]);
});
