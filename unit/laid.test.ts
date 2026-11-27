import { expect, test } from 'bun:test';
import { resolveCrossings } from '../src/lib/core/crossings';
import { dragNodes } from '../src/lib/core/drag';
import { Graph } from '../src/lib/core/graph.svelte';
import { createLanesFrom } from '../src/lib/core/lane-template';
import type { Scene } from '../src/lib/core/networks';
import { WALK } from '../src/lib/core/footpaths';
import { roadAt as onRoad, sideOf } from '../src/lib/core/road-line';
import type { GraphData, Lane } from '../src/lib/core/types';
import { check } from '../src/lib/road-model/checks';
import {
	area,
	fromPath,
	intersect,
	offset,
	offsetLine,
	piecesOf,
	subtract,
	toPath,
	union,
	type Paths
} from '../src/lib/road-model/clip';
import type { Description, Surface } from '../src/lib/road-model/description';
import { frameAt, project } from '../src/lib/road-model/geometry';
import type { Pt } from '../src/lib/road-model/model';
import { buildModel, editorDrawing, footpathNode, groundOf, liveShape, readScene } from './model';

// Footpaths laid over the compact roundabout (e2e/scenes/roundabout.json),
// each drawn as the editor draws one: its points joined by straight paths,
// then cut, itself alone, where it crosses a road (core/crossings.ts). The
// east and west
// approaches have 2 m sidewalks either side of a 7 m roadway, running from
// x = ±110 to their splits at x = ±50; the north and south ones have none.
// The car roads are built as if the footpaths weren't there
// (core/networks.ts); the footpaths cross them as zebras, join their
// sidewalks, or stop at their curbs (road-model/overlay.ts).

// The roundabout (or `data`) with a footpath through `points`.
function withPath(points: Pt[], data?: GraphData) {
	const graph = new Graph();
	graph.fromJSON(data ?? readScene('roundabout'));
	const nodes = points.map((p) => graph.createNode(p.x, p.y));
	const ids = nodes
		.slice(1)
		.map((n, i) => graph.createSegment(nodes[i].id, n.id, createLanesFrom('path')).id);
	resolveCrossings(graph, ids);
	return graph.toJSON();
}

const walks = (graph: GraphData) =>
	graph.segments.filter((s) => s.lanes.every((l) => l.role === 'pedestrian'));
const cars = (graph: GraphData) => ({
	...graph,
	segments: graph.segments.filter((s) => s.lanes.some((l) => l.role === 'vehicle'))
});

const shapeOf = (s: Surface): Paths =>
	'left' in s.shape
		? [toPath([...s.shape.left, ...[...s.shape.right].reverse()])]
		: s.shape.map(toPath);
const sum = (paths: Paths) => paths.reduce((s, p) => s + area(p), 0);
const pieces = (scene: Scene): Description[] => [
	...scene.place.roads.map((r) => scene.road(r.id)!),
	...scene.place.junctions.map((j) => scene.node(j.id)!)
];
const crossingsOf = (scene: Scene) => pieces(scene).flatMap((d) => d.crossings);
const zebraOf = (scene: Scene) =>
	union(
		crossingsOf(scene).flatMap((c) =>
			c.runs.filter((r) => r.kind === 'zebra').flatMap((r) => r.rings.map(toPath))
		)
	);
const ground = (scene: Scene, keep: (s: Surface) => boolean, ids?: string[]) =>
	union(
		pieces(scene)
			.filter(
				(_, i) => !ids || ids.includes([...scene.place.roads, ...scene.place.junctions][i].id)
			)
			.flatMap((d) => d.surfaces.filter(keep).flatMap(shapeOf))
	);
const carLanes = (s: Surface) => s.role === 'lane' || s.role === 'paving';
// The car road drawn through a point.
const roadAt = (scene: Scene, p: Pt) =>
	scene.place.roads
		.filter((r) => r.lanes.some((l) => l.kind === 'drive'))
		.map((r) => scene.road(r.id)!)
		.find((d) => project(d.path, p).d < 0.5)!;

// How far apart two drawings' car roads lie: each car road of `a` read
// against the road of `b` whose ends lie nearest its own, every metre of its
// line, and the car paths across each car node of `a` against `b`'s.
function carsMoved(a: Scene, b: Scene) {
	let worst = 0;
	const dist = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y);
	const carRoads = (s: Scene) =>
		s.place.roads.filter((r) => r.lanes.some((l) => l.kind === 'drive')).map((r) => s.road(r.id)!);
	const theirs = carRoads(b);
	const ours = carRoads(a);
	if (ours.length !== theirs.length) return Infinity;
	for (const { path: pa } of ours) {
		const ends = (p: typeof pa) => dist(p.pts[0], pa.pts[0]) + dist(p.pts.at(-1)!, pa.pts.at(-1)!);
		const pb = theirs.reduce((best, r) => (ends(r.path) < ends(best.path) ? r : best)).path;
		worst = Math.max(worst, Math.abs(pa.length - pb.length));
		for (let d = 0; d <= pa.length; d += 1)
			worst = Math.max(worst, dist(frameAt(pa, d).p, frameAt(pb, d).p));
	}
	for (const j of a.place.junctions) {
		if (j.id.startsWith('walk:')) continue;
		const na = a.node(j.id)!;
		const nb = b.node(j.id);
		if (!nb || na.paths.length !== nb.paths.length) return Infinity;
		na.paths.forEach((p, i) =>
			p.line.forEach((q, k) => (worst = Math.max(worst, dist(q, nb.paths[i].line[k]))))
		);
	}
	return worst;
}

test('a crosswalk across both ramps right where a road splits is a zebra over each, the cars unmoved', () => {
	// Across the north approach's two ramps 6 m past its split (at y = -50).
	const graph = withPath([
		{ x: -20, y: -44 },
		{ x: 20, y: -44 }
	]);
	// The footpath and the ramps uncut: its crossings are paint.
	expect(walks(graph)).toHaveLength(1);
	expect(cars(graph).segments).toEqual(readScene('roundabout').segments);
	const { scene } = buildModel(graph);
	expect(check(scene)).toEqual([]);
	// Its walk over each ramp's lane is all zebra: none of it is bare.
	const path = ground(
		scene,
		(s) => s.role === 'walk',
		walks(graph).map((s) => s.id)
	);
	const asphalt = ground(scene, carLanes);
	const bodies = union(crossingsOf(scene).flatMap((c) => c.body.map(toPath)));
	const over = intersect(offset([toPath(rectAround({ x: 0, y: -44 }, 20, 1))], 0), asphalt);
	expect(sum(over)).toBeGreaterThan(2 * 2 * 4 * 0.9);
	expect(sum(subtract(over, offset(bodies, 0.01)))).toBeLessThan(0.05);
	expect(sum(intersect(path, asphalt))).toBeLessThan(0.05);
	// Over each ramp's lane.
	for (const x of [-3, 3])
		expect(
			sum(intersect(zebraOf(scene), [toPath(rectAround({ x, y: -44 }, 1.5, 1))]))
		).toBeGreaterThan(0);
	// The car roads are where they were.
	expect(carsMoved(buildModel(readScene('roundabout')).scene, scene)).toBeLessThan(0.01);
});

// A rectangle `w` either side of a point across x and `h` either side in y.
const rectAround = (p: Pt, w: number, h: number) => [
	{ x: p.x - w, y: p.y - h },
	{ x: p.x + w, y: p.y - h },
	{ x: p.x + w, y: p.y + h },
	{ x: p.x - w, y: p.y + h }
];

test('a footpath saved carried on from the end of a street still joins its sidewalk with no gap', () => {
	// footpaths.json's `leave`: a path starting at a street's end node, saved
	// sharing it, carried on along its middle and joined to its north
	// sidewalk. Loaded, it has a node of its own there (core/separate.ts).
	const data = readScene('footpaths');
	const { derived, scene } = buildModel(data);
	expect(check(scene)).toEqual([]);
	const node = footpathNode(data, 'leave');
	expect(node).not.toBe('leave');
	// The sidewalk, the band joining it and the path are one piece of walk.
	const at = data.nodes.find((n) => n.id === 'leave')!;
	const isWalk = (s: Surface) => s.role === 'walk';
	const walk = ground(scene, isWalk, ['leave-street', `walk:${node}`, 'leave-path']);
	const near = piecesOf(offset(intersect(walk, [toPath(rectAround(at, 15, 8))]), 0.005));
	const path = near.find((p) => sum(intersect(p, ground(scene, isWalk, ['leave-path']))) > 1)!;
	expect(sum(intersect(path, ground(scene, isWalk, ['leave-street'])))).toBeGreaterThan(1);
	// The street stops short of its end as it does with no path there.
	expect(derived.spans.get('leave-street')).toEqual(
		buildModel(cars(data)).derived.spans.get('leave-street')
	);
});

test('a footpath round the roundabout crosses each approach, the cars unmoved', () => {
	// A ring of radius 35 round the roundabout, in 16 straight pieces.
	const ring = Array.from({ length: 17 }, (_, i) => {
		const a = ((i % 16) / 16) * 2 * Math.PI + Math.PI / 16;
		return { x: 35 * Math.cos(a), y: 35 * Math.sin(a) };
	});
	const graph = withPath(ring.slice(0, 16));
	// Closed: the last piece back to the first point.
	const data = (() => {
		const g = new Graph();
		g.fromJSON(graph);
		const first = g.nodes.get(walks(graph)[0].startNodeId)!;
		const last = [...g.nodes.values()].find(
			(n) => Math.hypot(n.x - ring[15].x, n.y - ring[15].y) < 1e-6
		)!;
		const s = g.createSegment(last.id, first.id, createLanesFrom('path'));
		resolveCrossings(g, [s.id]);
		return g.toJSON();
	})();
	const { scene } = buildModel(data);
	expect(check(scene)).toEqual([]);
	// A zebra over each of the eight ramps where the ring crosses it.
	const zebra = zebraOf(scene);
	for (const road of scene.place.roads.filter((r) => /ramp/.test(r.id))) {
		const d = scene.road(road.id)!;
		const crossed = d.crossings.some((c) => c.runs.some((r) => r.kind === 'zebra'));
		const near = sum(intersect(zebra, offset(shapeOf(d.surfaces[0]), 0.05))) > 0;
		expect([road.id, crossed || near]).toEqual([road.id, true]);
	}
	expect(carsMoved(buildModel(readScene('roundabout')).scene, scene)).toBeLessThan(0.01);
});

test('a footpath crossing a street at a shallow angle is a zebra over every car lane it lies on', () => {
	// Across the east approach at about 28°.
	const graph = withPath([
		{ x: 60, y: -12 },
		{ x: 105, y: 12 }
	]);
	const { scene } = buildModel(graph);
	expect(check(scene)).toEqual([]);
	const street = roadAt(scene, { x: 80, y: 0 });
	const roadway = union(street.surfaces.filter(carLanes).flatMap(shapeOf));
	// What the path covers, read off its line: every point of it over the
	// roadway lies in a crossing's zebra body.
	const bodies = union(crossingsOf(scene).flatMap((c) => c.body.map(toPath)));
	const band = offset(
		[
			toPath([
				{ x: 60, y: -12 },
				{ x: 105, y: 12 },
				{ x: 105, y: 12.001 }
			])
		],
		1
	);
	const over = intersect(band, roadway);
	expect(sum(over)).toBeGreaterThan(7 * 2 * 1.5);
	expect(sum(subtract(over, offset(bodies, 0.02)))).toBeLessThan(0.1);
	// Each of its two lanes has stripes on it.
	for (const lane of street.surfaces.filter((s) => s.role === 'lane'))
		expect(sum(intersect(zebraOf(scene), shapeOf(lane)))).toBeGreaterThan(1);
	// No walk is drawn over asphalt (check()), and the sidewalks either side
	// are the path's walk there: no crossing over them.
	const sidewalks = union(street.surfaces.filter((s) => s.role === 'walk').flatMap(shapeOf));
	expect(sum(intersect(bodies, offset(sidewalks, -0.05)))).toBeLessThan(0.01);
});

test('a footpath ending on the side of a street stops on its sidewalk, or at its curb', () => {
	// Onto the east approach's middle from the north, and onto the north
	// approach's (no sidewalks) from the west.
	const first = withPath([
		{ x: 80, y: -30 },
		{ x: 80, y: 0 }
	]);
	const graph = withPath(
		[
			{ x: -30, y: -80 },
			{ x: 0, y: -80 }
		],
		first
	);
	const { scene } = buildModel(graph);
	expect(check(scene)).toEqual([]);
	// No crossing: nothing laid over either street.
	expect(crossingsOf(scene)).toEqual([]);
	const walk = (id: string) =>
		scene
			.road(id)!
			.surfaces.filter((s) => s.role === 'walk')
			.flatMap(shapeOf)
			.flatMap(fromPath);
	const [east, north] = ['east', 'north'].map(
		(side) =>
			walks(graph).find((s) => {
				const node = graph.nodes.find((n) => n.id === s.startNodeId)!;
				return side === 'east' ? node.x === 80 : node.y === -80;
			})!
	);
	// The one onto the east approach reaches its sidewalk's outer edge (y =
	// -5.5) and goes no further.
	const ye = walk(east.id).map((p) => p.y);
	expect(Math.max(...ye)).toBeCloseTo(-5.5, 1);
	// The one onto the north approach stops at its curb (x = -3.5).
	const xn = walk(north.id).map((p) => p.x);
	expect(Math.max(...xn)).toBeCloseTo(-3.5, 1);
});

// A street from (-60, 0) to (60, 0), straight or bowed toward +y (its middle
// at y = 20), with `lanes`, and a footpath drawn onto it as draw mode lays
// one ended on a street (modes/draw.ts): its end on the street's side, on
// its sidewalk or at its curb (sideOf), at the street's middle on the side
// `from` (+1: +y), drawn from 30 m off at `lean` degrees off square, then
// joined to what it passes over (resolveCrossings).
function endedOn(lanes: Lane[], from: 1 | -1, lean = 0, curved = false) {
	const graph = new Graph();
	const w = graph.createNode(-60, 0);
	const e = graph.createNode(60, 0);
	const street = graph.createSegment(w.id, e.id, lanes);
	if (curved) street.setControlPoint(0, 40);
	const at = onRoad(graph, street, 0.5)!;
	const out = { x: at.normal.x * from, y: at.normal.y * from };
	const p = sideOf(graph, street, at.point.x + out.x * 3, at.point.y + out.y * 3)!;
	const node = graph.createNode(p.x, p.y);
	const a = (lean * Math.PI) / 180;
	const way = {
		x: out.x * Math.cos(a) - out.y * Math.sin(a),
		y: out.x * Math.sin(a) + out.y * Math.cos(a)
	};
	const far = graph.createNode(p.x + way.x * 30, p.y + way.y * 30);
	const path = graph.createSegment(far.id, node.id, preset('path'));
	resolveCrossings(graph, [path.id]);
	return { graph, node: node.id, far: far.id, path: path.id, out };
}
const preset = (id: string): Lane[] => createLanesFrom(id).map((l, i) => ({ ...l, id: `l${i}` }));
const lanesOf = {
	'street with a sidewalk each side': preset('street'),
	'street with a sidewalk on one side': preset('street').slice(0, 3),
	'street with no sidewalks': preset('street').slice(1, 3),
	'avenue, its sidewalks beyond verges': preset('avenue')
};

// What a footpath ended on a street from one side is drawn as: it reaches
// the street's ground (its sidewalk, or its curb where it has none on that
// side) with no ground between, all 3 m of its body next to the street
// drawn; nothing of it lies on the street or past its line on the far side;
// nothing is laid over its car lanes or median, so no crossing is drawn
// there (an avenue's verge it crosses to the curb is paved).
function endsOnNearSide({ graph, path, node, far, out }: ReturnType<typeof endedOn>) {
	const data = graph.toJSON();
	const { scene } = buildModel(data);
	expect(check(scene)).toEqual([]);
	const carIds = scene.place.roads.filter((r) => r.lanes.some((l) => l.kind === 'drive'));
	const street = union(carIds.flatMap((r) => scene.road(r.id)!.surfaces.flatMap(shapeOf)));
	const walk = ground(scene, (s) => s.role === 'walk', [path]);
	const pt = (id: string) => data.nodes.find((n) => n.id === id)!;
	const body = offsetLine([pt(node), pt(far)], 0.95);
	const beside = intersect(body, subtract(offset(street, 3), street));
	expect(sum(beside)).toBeGreaterThan(2);
	expect(sum(subtract(beside, walk))).toBeLessThan(0.01);
	expect(sum(intersect(walk, street))).toBeLessThan(0.01);
	const line = scene.road(carIds[0].id)!.path;
	for (const p of walk.flatMap(fromPath)) {
		const f = frameAt(line, project(line, p).s);
		expect(dot({ x: p.x - f.p.x, y: p.y - f.p.y }, out)).toBeGreaterThan(0);
	}
	const over = crossingsOf(scene).filter(
		(c) => c.body.length || c.runs.some((r) => r.kind !== 'paved')
	);
	expect(over).toEqual([]);
	return { scene };
}
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;

for (const [name, lanes] of Object.entries(lanesOf))
	for (const from of [1, -1] as const)
		for (const curved of [false, true])
			test(`a footpath ended on ${curved ? 'a curved' : 'a straight'} ${name} from its ${from > 0 ? 'left' : 'right'} reaches it with no gap, square on or leaning, and crosses nothing`, () => {
				// Square on, 30° off either way and, on the straight street, 60°.
				// (Inside the curve at 60° a footpath stopping at the curb meets
				// it at under 30°, a corner check() calls a spike.)
				for (const lean of curved ? [0, 30, -30] : [0, 30, -30, 60, -60])
					endsOnNearSide(endedOn(lanes, from, lean, curved));
			});

test('a footpath ended on a street, its free end dragged through every angle, reaches it with no gap and crosses nothing', () => {
	const laid = endedOn(lanesOf['street with a sidewalk each side'], 1);
	const { graph, node, far } = laid;
	const centre = graph.nodes.get(node)!;
	for (const deg of [10, 25, 45, 60, -10, -25, -45, -60, 0]) {
		const a = (deg * Math.PI) / 180;
		const to = { x: centre.x + 30 * Math.sin(a), y: centre.y + 30 * Math.cos(a) };
		const at = graph.nodes.get(far)!;
		const d = dragNodes(graph, [far], groundOf(graph));
		d.move((to.x - at.x) / 2, (to.y - at.y) / 2);
		d.move((to.x - at.x) / 2, (to.y - at.y) / 2);
		resolveCrossings(graph, d.changed());
		endsOnNearSide(laid);
	}
});

test('a footpath drawn across the whole street is a zebra over it, joins both sidewalks and is given way to', () => {
	const graph = new Graph();
	const w = graph.createNode(-60, 0);
	const e = graph.createNode(60, 0);
	const street = graph.createSegment(w.id, e.id, preset('street')).toJSON();
	const [n, s] = [graph.createNode(0, -20), graph.createNode(0, 20)];
	resolveCrossings(graph, [graph.createSegment(n.id, s.id, preset('path')).id]);
	// The street is as it was, and so is the footpath: its crossing is paint.
	expect(
		[...graph.segments.values()].filter((x) => x.lanes.length > 1).map((x) => x.toJSON())
	).toEqual([street]);
	expect(graph.nodes.size).toBe(4);
	const { scene } = buildModel(graph.toJSON());
	expect(check(scene)).toEqual([]);
	expect(
		sum(intersect(zebraOf(scene), [toPath(rectAround({ x: 0, y: 0 }, 1, 3))]))
	).toBeGreaterThan(1);
	expect(pieces(scene).flatMap((d) => d.signs.filter((x) => x.kind === 'yield'))).toHaveLength(2);
	// The footpath, its crossing and the sidewalks either side are one walk.
	const walk = union([
		...pieces(scene).flatMap((d) => d.surfaces.filter((x) => x.role === 'walk').flatMap(shapeOf)),
		...crossingsOf(scene).flatMap((c) => c.body.map(toPath))
	]);
	const near = intersect(walk, [toPath(rectAround({ x: 0, y: 0 }, 1, 15))]);
	expect(piecesOf(offset(near, 0.005))).toHaveLength(1);
});

test('under a zebra the lines stop, and each way gives way short of it', () => {
	// Straight across the east approach at x = 80.
	const graph = withPath([
		{ x: 80, y: -20 },
		{ x: 80, y: 20 }
	]);
	const { scene } = buildModel(graph);
	expect(check(scene)).toEqual([]);
	const street = roadAt(scene, { x: 80, y: 0 });
	const bodies = street.crossings.flatMap((c) => c.body);
	expect(bodies.length).toBeGreaterThan(0);
	// No line of the street passes under the crossing.
	const zebra = zebraOf(scene);
	for (const m of street.markings)
		for (const p of m.line)
			expect(sum(intersect(zebra, [toPath(rectAround(p, 0.05, 0.05))]))).toBe(0);
	// A give-way line each side, its teeth pointing away from the crossing,
	// each across its own lanes, just short of it.
	const along = (p: Pt) => project(street.path, p).s;
	const at = along({ x: 80, y: 0 });
	const lines = street.signs.filter((s) => s.kind === 'yield');
	expect(lines).toHaveLength(2);
	const [before, after] = [...lines].sort((p, q) => along(p.a) - along(q.a));
	// Drawn west: the east side comes first along the street.
	expect(along(before.a)).toBeLessThan(at - 1.5);
	expect(along(before.a)).toBeGreaterThan(at - 6);
	expect(along(after.a)).toBeGreaterThan(at + 1.5);
	expect(along(after.a)).toBeLessThan(at + 6);
	if (before.kind === 'yield') expect(before.toward.x).toBeGreaterThan(0.9);
	if (after.kind === 'yield') expect(after.toward.x).toBeLessThan(-0.9);
	// The street's lane lines stop behind each line, as at a junction.
	for (const m of street.markings)
		for (const p of m.line) {
			const s = along(p);
			expect(s < along(before.a) + 0.5 || s > along(after.a) - 0.5).toBe(true);
		}
});

// A footpath end showing where a street's dead end shows carries on from
// it, the street shifted at its end or not: swept over the street's heading,
// straight and curved, stored either way, its shift at the dead end, and
// the drawing kept from a build of the street unshifted (as the editor keeps
// it) as well as built fresh. One ending where the street's node lies, the
// street shown off it, or 2 cm from where its end shows, carries on from
// nothing.
test('a footpath end where a shifted dead end shows carries on from it', () => {
	const wrong: string[] = [];
	const streetTo = (
		heading: number,
		bow: number,
		back: boolean,
		shift: number,
		end: Pt
	): GraphData => {
		const w = { x: -50 * Math.cos(heading), y: -50 * Math.sin(heading) };
		const c = { x: w.x / 2 - (w.y / 50) * bow, y: w.y / 2 + (w.x / 50) * bow };
		return {
			nodes: [
				{ id: 'w', ...w },
				{ id: 'o', x: 0, y: 0 },
				{ id: 'p', ...end },
				{ id: 'q', x: end.x + 15, y: end.y + 25 }
			],
			segments: [
				{
					id: 'street',
					startNodeId: back ? 'o' : 'w',
					endNodeId: back ? 'w' : 'o',
					lanes: createLanesFrom('street'),
					...(back ? { offsetStart: -shift } : { offsetEnd: shift }),
					...(bow && { controlX: c.x, controlY: c.y })
				},
				{ id: 'path', startNodeId: 'p', endNodeId: 'q', lanes: createLanesFrom('path') }
			]
		};
	};
	const carriesOn = (scene: Scene) => scene.place.junctions.some((j) => j.id === `${WALK}p`);
	for (const heading of [0, 0.7, -2.1])
		for (const bow of [0, 12])
			for (const back of [false, true])
				for (const shift of [0, 3, -8]) {
					const shown = onRoad(
						liveShape(streetTo(heading, bow, back, shift, { x: 0, y: 0 })) as never,
						liveShape(streetTo(heading, bow, back, shift, { x: 0, y: 0 })).segments.get(
							'street'
						)! as never,
						back ? 0 : 1
					)!.point;
					const label = `heading ${heading} bow ${bow}${back ? ' back' : ''} shift ${shift}`;
					const ends: [string, Pt, boolean][] = [
						['shown', shown, true],
						['2 cm off', { x: shown.x + 0.02, y: shown.y }, false],
						...(shift ? [['at the node', { x: 0, y: 0 }, false] as [string, Pt, boolean]] : [])
					];
					for (const [name, end, want] of ends) {
						const fresh = carriesOn(buildModel(streetTo(heading, bow, back, shift, end)).scene);
						const kept = editorDrawing();
						kept(liveShape(streetTo(heading, bow, back, 0, end)));
						const live = carriesOn(kept(liveShape(streetTo(heading, bow, back, shift, end))));
						if (fresh !== want || live !== want)
							wrong.push(`${label}, ${name}: ${fresh}, live ${live}`);
					}
				}
	expect(wrong).toEqual([]);
});
