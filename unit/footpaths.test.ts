import { expect, test } from 'bun:test';
import { buildModel, footpathNode, readScene } from './model';
import { Graph } from '../src/lib/core/graph.svelte';
import { resolveCrossings } from '../src/lib/core/crossings';
import { area, fromPath, intersect, toPath, union, type Paths } from '../src/lib/road-model/clip';
import type { Crossing } from '../src/lib/road-model/description';
import { curveBetween } from '../src/lib/road-model/geometry';
import { createLanesFrom } from '../src/lib/core/lane-template';

// Footpaths meeting streets, each drawn the way the editor draws it, side by
// side in e2e/scenes/footpaths.json along y = 0 (all streets two lanes with
// a 2 m sidewalk each side, all paths one 2 m walk unless said). The
// footpaths are laid over the streets (core/networks.ts): the streets are
// drawn as if they weren't there, but for the crossings on them.
// - cross (x 0): a straight path crossing a street at a node;
// - arc (x 120): a path drawn on a curve through a node on a street;
// - leave (x 240): a path carrying on from a street's end along its middle,
//   joined to its north sidewalk;
// - eased (x 360): the same with a slight curve;
// - corner (x 480): a path turning north off a street's end, joined to both
//   its sidewalks;
// - bend (x 610): a 6 m path straight across a street on a curve, at a node
//   where the street heads south-east, (1, 2) across it.
// Each test checks its case's drawing off the road model.

const sum = (paths: Paths) => paths.reduce((s, p) => s + Math.abs(area(p)), 0);

const build = () => buildModel(readScene('footpaths'));
// The footpaths' node where they met a street at a node of the scene (they
// are a node of their own once loaded, core/separate.ts).
const walkNode = (id: string) => footpathNode(readScene('footpaths'), id);

// The scene with its footpaths taken away.
const streetsOnly = () => {
	const graph = readScene('footpaths');
	return buildModel({
		...graph,
		segments: graph.segments.filter((s) => s.lanes.some((l) => l.role === 'vehicle'))
	});
};

// Every crossing drawn within `r` of a point, on whatever piece.
function crossingsNear(p: { x: number; y: number }, r: number) {
	const { scene } = build();
	const pieces = [
		...scene.place.roads.map((road) => scene.road(road.id)!),
		...scene.place.junctions.map((j) => scene.node(j.id)!)
	];
	return pieces
		.flatMap((d) => d.crossings)
		.filter((c) => c.body.flat().some((q) => Math.hypot(q.x - p.x, q.y - p.y) < r));
}

// A crossing's runs of one kind (its paving: refuges and sidewalk paving).
const runs = (c: Crossing, kind: 'zebra' | 'paved') =>
	c.runs.filter((r) => r.kind === kind).flatMap((r) => r.rings.map(toPath));
// The sidewalk carried across a node: its rings, or its ribbons' outlines.
const walks = (id: string) =>
	build()
		.scene.node(walkNode(id))!
		.surfaces.filter((s) => s.role === 'walk')
		.flatMap((s) =>
			Array.isArray(s.shape)
				? s.shape.map(toPath)
				: [toPath([...s.shape.left, ...[...s.shape.right].reverse()])]
		);

test('a footpath crossing a street is its sidewalk where it lies over it, and a zebra over its lanes', () => {
	const { scene } = build();
	const crossings = crossingsNear({ x: 0, y: 0 }, 5);
	// A zebra over the roadway (x within ±3.5 m), no paving of its own.
	const zebra = crossings.flatMap((c) => runs(c, 'zebra'));
	expect(sum(zebra)).toBeGreaterThan(2 * 7 * 0.3);
	for (const p of zebra.flatMap(fromPath)) expect(Math.abs(p.x)).toBeLessThan(3.5 + 0.01);
	expect(crossings.flatMap((c) => runs(c, 'paved'))).toEqual([]);
	// The path's own paving stops on the sidewalks' outer edges (x ±5.5 m).
	for (const id of ['cross-path-w']) {
		const walk = scene
			.road(id)!
			.surfaces.flatMap((s) =>
				Array.isArray(s.shape)
					? s.shape.map(toPath)
					: [toPath([...s.shape.left, ...[...s.shape.right].reverse()])]
			);
		for (const p of walk.flatMap(fromPath)) expect(Math.abs(p.x)).toBeGreaterThan(5.5 - 0.01);
	}
});

test('a footpath drawn on a curve through a node on a street crosses it there', () => {
	// One crossing on each piece of the street it lies over: the street's two
	// roads and its node.
	const { scene } = build();
	expect([
		scene.road('arc-street-a')!.crossings.length,
		scene.road('arc-street-b')!.crossings.length,
		scene.node('arc')!.crossings.length
	]).toEqual([1, 1, 1]);
	expect(crossingsNear({ x: 120, y: 0 }, 5)).toHaveLength(3);
	const zebra = crossingsNear({ x: 120, y: 0 }, 5).flatMap((c) => runs(c, 'zebra'));
	expect(sum(zebra)).toBeGreaterThan(0);
	// Its stripes lie along the street (which runs north-south), each taller
	// than it is wide where the pieces of it on the street and its node meet.
	for (const stripe of union(zebra).map(fromPath)) {
		const xs = stripe.map((p) => p.x);
		const ys = stripe.map((p) => p.y);
		expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(Math.max(...xs) - Math.min(...xs));
	}
});

test('a footpath leaving a street off its sidewalk is paved from its node, its sidewalks joined there', () => {
	const { scene, derived } = build();
	// The street ends as it would with no path there, and the path is drawn
	// whole from its node: no taper, no setback.
	expect(derived.spans.get('leave-street')).toEqual(
		streetsOnly().derived.spans.get('leave-street')
	);
	const path = scene.place.roads.find((r) => r.id === 'leave-path')!;
	expect(path.points[0]).toEqual({ x: 240, y: 0 });
	// The ground at its node reaches both of the street's sidewalks (y 3.5
	// to 5.5 either side) across their whole width.
	const fill = union(walks('leave'));
	for (const y of [-5.4, -3.6, 3.6, 5.4]) {
		const slice = [
			{ x: 240, y: y - 0.05 },
			{ x: 241, y: y - 0.05 },
			{ x: 241, y: y + 0.05 },
			{ x: 240, y: y + 0.05 }
		];
		expect(sum(intersect(fill, [toPath(slice)]))).toBeGreaterThan(0.09);
	}
});

test('ends nearly in line are joined by an even S, not a straight run', () => {
	// 14 m along, 4.5 m across, the far end turned 1° off the near one.
	const tilt = Math.PI / 180;
	const pts = curveBetween(
		{ x: 0, y: 0 },
		{ x: 1, y: 0 },
		{ x: 14, y: 4.5 },
		{ x: Math.cos(tilt), y: Math.sin(tilt) },
		40
	);
	// Its handles are a third of the chord, so it moves along evenly.
	expect(pts[10].x).toBeGreaterThan(14 / 4 - 0.5);
	expect(pts[10].x).toBeLessThan(14 / 4 + 0.5);
});

test('a footpath joined to both sidewalks of a street end leaves no paving between', () => {
	const paving = build()
		.scene.node(walkNode('corner'))!
		.surfaces.filter((s) => s.role === 'paving')
		.flatMap((s) => (Array.isArray(s.shape) ? s.shape.map(toPath) : []));
	expect(sum(paving)).toBeLessThan(0.01);
	// Both walks still cross: about 2 m wide each, over the bend.
	expect(sum(walks('corner'))).toBeGreaterThan(2 * 2 * 5);
});

test('a wide footpath crossing a street on a curve reads as a straight crossing', () => {
	const { scene } = build();
	// The street's lines run up to the crossing (about y = 0, 6 m wide) from
	// either side and stop there: both edge lines and the double yellow.
	const near = (p: { x: number; y: number }) => Math.hypot(p.x - 610, p.y) < 12;
	const lines = [
		...['bend-street-a', 'bend-street-b'].map((id) => scene.road(id)!),
		scene.node('bend')!
	]
		.flatMap((d) => d.markings)
		.filter((m) => m.line.some(near));
	for (const side of [-1, 1]) {
		const here = lines.filter((m) => m.line.every((p) => p.y * side > 2.9));
		expect(here.filter((m) => m.colour === 'white')).toHaveLength(2);
		expect(here.filter((m) => m.colour === 'yellow')).toHaveLength(2);
	}
	for (const m of lines) expect(m.line.every((p) => Math.abs(p.y) > 2.9)).toBe(true);
	// The zebra is as wide as the path (6 m, about y = 0)...
	const stripes = crossingsNear({ x: 610, y: 0 }, 8)
		.flatMap((c) => runs(c, 'zebra'))
		.map(fromPath);
	for (const p of stripes.flat()) expect(Math.abs(p.y)).toBeLessThan(3.05);
	// ...and its stripes run along the street: their edges, weighted by
	// length, lie along (1, 2) to within 10°.
	let c2 = 0;
	let s2 = 0;
	for (const stripe of stripes)
		stripe.forEach((p, i) => {
			const q = stripe[(i + 1) % stripe.length];
			const angle = Math.atan2(q.y - p.y, q.x - p.x);
			const l = Math.hypot(q.x - p.x, q.y - p.y);
			c2 += l * Math.cos(2 * angle);
			s2 += l * Math.sin(2 * angle);
		});
	const along = Math.atan2(s2, c2) / 2;
	const street = Math.atan2(2, 1);
	expect(Math.abs(Math.sin(along - street))).toBeLessThan(Math.sin((10 * Math.PI) / 180));
});

test('every car lane a footpath crosses carries stripe, however narrow, beside a median of any width', () => {
	// A 0.5 m lane, a median, a 3.5 m lane, a 2 m footpath across them all.
	const lane = (id: string, width: number, direction: 'forward' | 'backward') =>
		({ id, role: 'vehicle', material: 'asphalt', direction, width }) as const;
	const walk = {
		id: 'walk',
		role: 'pedestrian',
		material: 'concrete',
		direction: 'bidirectional',
		width: 2
	} as const;
	const bare: string[] = [];
	for (let median = 1; median <= 6; median += 0.05) {
		const lanes = [
			lane('narrow', 0.5, 'backward'),
			{
				id: 'median',
				role: 'buffer',
				material: 'grass',
				direction: 'bidirectional',
				width: median
			},
			lane('drive', 3.5, 'forward')
		] as const;
		// Drawn across as draw mode lays it: cut in the middle of the crossing.
		const graph = new Graph();
		graph.fromJSON({
			nodes: [
				{ id: 'w', x: -30, y: 0 },
				{ id: 'e', x: 30, y: 0 },
				{ id: 'a', x: 0, y: -15 },
				{ id: 'b', x: 0, y: 15 }
			],
			segments: [
				{ id: 'car', startNodeId: 'w', endNodeId: 'e', lanes: [...lanes] },
				{ id: 'path', startNodeId: 'a', endNodeId: 'b', lanes: [walk] }
			]
		});
		resolveCrossings(graph, ['path']);
		const { scene } = buildModel(graph.toJSON());
		const road = scene.road('car')!;
		const bars = union(road.crossings.flatMap((c) => runs(c, 'zebra')));
		for (const s of road.surfaces.filter((s) => s.role === 'lane')) {
			const shape =
				'left' in s.shape ? [[...s.shape.left, ...[...s.shape.right].reverse()]] : s.shape;
			// At least half a bar's width (0.2 m) of stripe across the 2 m path.
			if (sum(intersect(bars, union(shape.map(toPath)))) < 0.39)
				bare.push(`${s.lane?.lane} beside a ${median.toFixed(2)} m median`);
		}
	}
	expect(bare).toEqual([]);
});

test("two footpaths ending at one node on a street's sidewalk are no fill, and both are recorded on that lane", () => {
	// A street along y = 0 (sidewalk middles at y ±4.5), and two footpaths
	// from one node on its sidewalk at (-40, 4.5), drawn away from it. The
	// node is no bend or joint (onWalk): each footpath ends there whole and
	// joins the sidewalk, both on the same lane.
	const lanes = (preset: string) => createLanesFrom(preset).map((l, i) => ({ ...l, id: `l${i}` }));
	const road = (id: string, a: string, b: string, preset: string) => ({
		id,
		startNodeId: a,
		endNodeId: b,
		lanes: lanes(preset)
	});
	const pair = (y: number) =>
		buildModel({
			nodes: [
				{ id: 'w', x: -80, y: 0 },
				{ id: 'e', x: 80, y: 0 },
				{ id: 'end', x: -40, y },
				{ id: 'p', x: -46, y: y + 17.5 },
				{ id: 'q', x: -28, y: y + 15.5 }
			],
			segments: [
				road('street', 'w', 'e', 'street'),
				road('one', 'end', 'p', 'path'),
				road('two', 'end', 'q', 'path')
			]
		}).derived;
	const on = pair(4.5);
	expect(on.place.junctions.map((j) => j.id)).not.toContain('walk:end');
	expect(on.sidewalks.get('end')?.map((r) => [r.path, r.road, r.lane])).toEqual([
		['one', 'street', 'l3'],
		['two', 'street', 'l3']
	]);
	// Off the street the same pair is a bend.
	const off = pair(12);
	expect(off.place.junctions.map((j) => j.id)).toContain('walk:end');
	expect(off.sidewalks.get('end')).toBeUndefined();
});
