import { expect, test } from 'bun:test';
import type { GraphData, JunctionData, Lane } from '../src/lib/core/types';
import { fromPath, inside, toPath, union } from '../src/lib/road-model/clip';
import { check } from '../src/lib/road-model/checks';
import type { Description, Ring } from '../src/lib/road-model/description';
import type { Pt } from '../src/lib/road-model/model';
import type { Scene as Drawing } from '../src/lib/core/networks';
import { dist, project } from '../src/lib/road-model/geometry';
import { buildModel } from './model';

// A node where two roads meet one to one (a bend, a road carrying on): what
// its bands, lines, hatching and paving look like, read off the road model.

const lane = (role: Lane['role'], material: Lane['material'], width: number, dir = 'forward') =>
	({ role, material, width, direction: dir }) as Lane;
const drive = (dir: 'forward' | 'backward') => lane('vehicle', 'asphalt', 3.5, dir);
const walk = () => lane('pedestrian', 'concrete', 2, 'bidirectional');

const oneWay = () => [drive('forward'), drive('forward')];
const street = () => [walk(), drive('backward'), drive('forward'), walk()];
// An avenue whose two carriageways are kept apart by a hatched median.
const hatched = () => [
	walk(),
	lane('buffer', 'grass', 2, 'bidirectional'),
	drive('backward'),
	drive('backward'),
	lane('buffer', 'asphalt', 2, 'bidirectional'),
	drive('forward'),
	drive('forward'),
	lane('buffer', 'grass', 2, 'bidirectional'),
	walk()
];

// Road a from (-100, 0) to node m at the origin, and road z on from m 100 m
// away, turned `angle` degrees from straight on. Road z's lanes are named
// as road a's (`l0`, `l1`, ...) unless `apart`: carrying straight on, the
// two are then one road cut at m, drawn whole with no node there
// (core/place.ts), and named apart (two roads drawn on their own) m stays a
// node.
function bend(
	angle: number,
	lanes: () => Lane[],
	junction?: JunctionData,
	apart = false
): GraphData {
	const t = (angle * Math.PI) / 180;
	const ids = (l: Lane[], z = false) =>
		l.map((x, i) => ({ ...x, id: `${z && apart ? 'z' : 'l'}${i}` }));
	return {
		nodes: [
			{ id: 'a', x: -100, y: 0 },
			{ id: 'm', x: 0, y: 0, junction },
			{ id: 'z', x: 100 * Math.cos(t), y: 100 * Math.sin(t) }
		],
		segments: [
			{ id: 'a', startNodeId: 'a', endNodeId: 'm', lanes: ids(lanes()) },
			{ id: 'z', startNodeId: 'm', endNodeId: 'z', lanes: ids(lanes(), true) }
		]
	};
}

const centroid = (ring: Ring) => ({
	x: ring.reduce((s, p) => s + p.x, 0) / ring.length,
	y: ring.reduce((s, p) => s + p.y, 0) / ring.length
});
const barsOf = (d: Description) => d.surfaces.flatMap((s) => s.bars?.rings ?? []);
const shapesOf = (d: Description) =>
	d.surfaces.flatMap((s) =>
		'left' in s.shape
			? [toPath([...s.shape.left, ...[...s.shape.right].reverse()])]
			: s.shape.map(toPath)
	);
// Whether anything of the node, or of the roads either side, is drawn at p.
const drawnAt = (scene: Drawing, p: Pt) =>
	inside(
		union([
			...shapesOf(scene.node('m')!),
			...shapesOf(scene.road('a')!),
			...shapesOf(scene.road('z')!)
		]),
		p
	);

test('a bend of one-way or two-way roads passes every drawing rule from straight to 150°', () => {
	for (const lanes of [oneWay, street])
		for (let angle = 0; angle <= 150; angle += 10)
			expect(check(buildModel(bend(angle, lanes)).scene), `${lanes.name} at ${angle}°`).toEqual([]);
});

// Every hatch bar of the node and the roads either side, as one: a bar cut
// where a road meets the node is whole again.
const allBars = (scene: Drawing) =>
	union(
		[scene.road('a')!, scene.node('m')!, scene.road('z')!].flatMap((d) => barsOf(d).map(toPath))
	).map((path) => centroid(fromPath(path)));

// Each bar about 4 m on from the one before.
function evenly(bars: Pt[]) {
	expect(bars.length).toBeGreaterThan(10);
	for (let i = 1; i < bars.length; i++) {
		const gap = Math.hypot(bars[i].x - bars[i - 1].x, bars[i].y - bars[i - 1].y);
		expect(gap).toBeGreaterThan(3.7);
		expect(gap).toBeLessThan(4.3);
	}
}

test('a hatched median keeps its bars every 4 m straight through a node', () => {
	const { scene } = buildModel(bend(0, hatched, undefined, true));
	evenly(
		allBars(scene)
			.filter((p) => Math.abs(p.x) < 40)
			.sort((p, q) => p.x - q.x)
	);
});

test('a hatched median keeps its bars every 4 m round a right-angle bend', () => {
	const { scene } = buildModel(bend(90, hatched));
	expect(barsOf(scene.node('m')!).length).toBeGreaterThan(5);
	// Road a runs east into the bend, which turns south round a point
	// about 20 m south-west of m: the bars in order round it.
	const round = (p: Pt) => Math.atan2(p.y - 20, p.x + 20);
	evenly(
		allBars(scene)
			.filter((p) => Math.hypot(p.x, p.y) < 40)
			.sort((p, q) => round(p) - round(q))
	);
	expect(check(scene)).toEqual([]);
});

// How far an interval between neighbouring bars may stray from 4 m. Across
// a node the bars fit a whole number of intervals into the distance between
// the two roads' bars, which strays furthest at 16/3 m: one interval of
// 5.33 m or two of 2.67 m, 4/3 m off either way. A little more covers
// reading each bar at the middle of its shape, slanted across a curve.
const TOLERANCE = 1.4;

test('a hatched median keeps an even rhythm from one road through a bend into the other', () => {
	// Two opposing lanes either side of a 3 m hatched median, no verges: the
	// node's bars meet each road's own bars at both seams. 0° is a road
	// carrying straight on.
	const median = () => [drive('backward'), lane('buffer', 'asphalt', 3), drive('forward')];
	for (let angle = 0; angle <= 120; angle += 5) {
		const { scene } = buildModel(bend(angle, median, undefined, true));
		const node = scene.node('m')!;
		// The median's line from road a's start, across the node, to road z's end.
		const pts = [
			...scene.road('a')!.path.pts,
			...node.paths.find((p) => p.kind === 'buffer')!.line,
			...scene.road('z')!.path.pts
		];
		const s = [0];
		for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + dist(pts[i], pts[i - 1]));
		const line = { pts, s, length: s.at(-1)! };
		const along = allBars(scene)
			.map((p) => project(line, p).s)
			.sort((p, q) => p - q);
		const gaps = along.slice(1).map((d, i) => d - along[i]);
		expect(gaps.length, `${angle}°`).toBeGreaterThan(40);
		for (const gap of gaps) {
			// Never closer than half the 4 m spacing.
			expect(gap, `${angle}°`).toBeGreaterThan(2);
			expect(Math.abs(gap - 4), `${angle}°`).toBeLessThan(TOLERANCE);
		}
	}
});

test('hatching between two lanes stays off the car paths crossing it, one-way or two-way', () => {
	// Two lanes and a 3 m hatched buffer between them, the lanes swapping
	// sides over 20 m.
	for (const dir of ['forward', 'bidirectional']) {
		const car = () => lane('vehicle', 'asphalt', 3.5, dir);
		const buffer = () => [car(), lane('buffer', 'asphalt', 3), car()];
		const to = (from: string, at: string) => ({
			from: { road: 'a', end: 'end' as const, lane: from },
			to: { road: 'z', end: 'start' as const, lane: at }
		});
		const graph = bend(0, buffer, {
			added: [to('l0', 'l2'), to('l2', 'l0')],
			setbacks: { a: 20, z: 20 }
		});
		const { scene } = buildModel(graph);
		expect(barsOf(scene.node('m')!).length, dir).toBeGreaterThan(0);
		expect(check(scene), dir).toEqual([]);
	}
});

test('a node with every connection removed leaves ground between the two road ends', () => {
	const ref = (road: string, end: 'start' | 'end', lane: string) => ({ road, end, lane });
	const removed = ['l0', 'l1', 'l2', 'l3'].map((l) => ({
		from: ref('a', 'end', l),
		to: ref('z', 'start', l)
	}));
	removed[1] = { from: ref('z', 'start', 'l1'), to: ref('a', 'end', 'l1') };
	const { scene } = buildModel(bend(0, street, { removed, added: [] }));
	const [a, z] = [scene.road('a')!, scene.road('z')!];
	const gap = a.path.pts.at(-1)!.x;
	const far = z.path.pts[0].x;
	expect(far - gap).toBeGreaterThan(1);
	// Across both lanes, halfway between the two ends: nothing drawn.
	for (const y of [-3, -1, 1, 3]) expect(drawnAt(scene, { x: (gap + far) / 2, y })).toBe(false);
	expect(scene.node('m')!.surfaces).toEqual([]);
	expect(check(scene)).toEqual([]);
});

test('a lane connected to nothing ends at its node: only the lanes carrying on are paved across', () => {
	// The street's eastbound lane (l2) connects to nothing; westbound still does.
	const ref = (road: string, end: 'start' | 'end', lane: string) => ({ road, end, lane });
	const { scene } = buildModel(
		bend(0, street, { removed: [{ from: ref('a', 'end', 'l2'), to: ref('z', 'start', 'l2') }] })
	);
	const [gap, far] = [scene.road('a')!.path.pts.at(-1)!.x, scene.road('z')!.path.pts[0].x];
	const mid = (gap + far) / 2;
	// l1 lies at y -3.5..0 and l2 at 0..3.5 (y grows to the road's right).
	expect(drawnAt(scene, { x: mid, y: -1.75 })).toBe(true);
	expect(drawnAt(scene, { x: mid, y: 1.75 })).toBe(false);
	expect(check(scene)).toEqual([]);
});
