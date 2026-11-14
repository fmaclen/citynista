import { expect, test } from 'bun:test';
import { buildModel, readScene } from './model';
import { area, fromPath, intersect, toPath, union, type Paths } from '../src/lib/road-model/clip';
import type { Crossing } from '../src/lib/road-model/description';
import { curveBetween } from '../src/lib/road-model/geometry';

// Footpaths meeting streets, each drawn the way the editor draws it, side by
// side in e2e/scenes/footpaths.json along y = 0 (all streets two lanes with
// a 2 m sidewalk each side, all paths one 2 m walk unless said):
// - cross (x 0): a straight path crossing a street at a node;
// - arc (x 120): a path drawn on a curve through a node on a street;
// - leave (x 240): a path carrying on from a street's end along its middle,
//   joined to its north sidewalk;
// - eased (x 360): the same with a slight curve, its taper set long by hand;
// - corner (x 480): a path turning north off a street's end, joined to both
//   its sidewalks;
// - bend (x 610): a 6 m path straight across a street on a curve, at a node
//   where the street heads south-east, (1, 2) across it.
// Each test checks its case's drawing off the road model.

const sum = (paths: Paths) => paths.reduce((s, p) => s + Math.abs(area(p)), 0);

const build = () => buildModel(readScene('footpaths'));

// A crossing's runs of one kind (its paving: refuges and sidewalk paving).
const runs = (c: Crossing, kind: 'zebra' | 'paved') =>
	c.runs.filter((r) => r.kind === kind).flatMap((r) => r.rings.map(toPath));
// The sidewalk carried across a node: its rings, or its ribbons' outlines.
const walks = (id: string) =>
	build()
		.scene.node(id)!
		.surfaces.filter((s) => s.role === 'walk')
		.flatMap((s) =>
			Array.isArray(s.shape)
				? s.shape.map(toPath)
				: [toPath([...s.shape.left, ...[...s.shape.right].reverse()])]
		);

test('a footpath crossing a street runs on over its sidewalks as paving', () => {
	const crossing = build().scene.node('cross')!.crossings[0];
	// Up to the zebra it is the path's own paving.
	expect(sum(runs(crossing, 'paved'))).toBeGreaterThan(2 * 2 * 1.5);
	expect(sum(runs(crossing, 'zebra'))).toBeGreaterThan(0);
});

test('a footpath drawn on a curve through a node on a street crosses it there', () => {
	const node = build().scene.node('arc')!;
	expect(node.crossings).toHaveLength(1);
	const zebra = runs(node.crossings[0], 'zebra');
	expect(sum(zebra)).toBeGreaterThan(0);
	// Its stripes lie square to the line between the path ends, across the
	// street (which runs north-south): each one taller than it is wide.
	for (const stripe of zebra.map(fromPath)) {
		const xs = stripe.map((p) => p.x);
		const ys = stripe.map((p) => p.y);
		expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(Math.max(...xs) - Math.min(...xs));
	}
});

test('a footpath leaving a street off its sidewalk eases across over a taper', () => {
	const { derived } = build();
	// It steps 4.5 m across (the sidewalk's middle to the street's), so its
	// node is at least three times that long.
	const street = derived.spans.get('leave-street')!;
	const path = derived.spans.get('leave-path')!;
	const taper = street.total - street.d0 - street.length + path.d0;
	expect(taper).toBeGreaterThanOrEqual(3 * 4.5 - 0.01);
});

test('a footpath set on a long taper by hand follows an eased curve', () => {
	const band = union(walks('eased'));
	// A quarter of the way along, an even S has moved about a sixth of the
	// way across (smoothstep(¼) = 0.16); a straight run with rounded ends
	// has moved about a fifth.
	const xs = band.flatMap(fromPath).map((p) => p.x);
	const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
	// The band's middle where a thin north-south slice cuts it at x.
	const middle = (x: number) => {
		const slice = [
			{ x: x - 0.05, y: -50 },
			{ x: x + 0.05, y: -50 },
			{ x: x + 0.05, y: 50 },
			{ x: x - 0.05, y: 50 }
		];
		const ys = intersect(band, [toPath(slice)])
			.flatMap(fromPath)
			.map((p) => p.y);
		return (Math.min(...ys) + Math.max(...ys)) / 2;
	};
	const [y0, y1] = [middle(x0 + 0.3), middle(x1 - 0.3)];
	const quarter = (middle(x0 + (x1 - x0) / 4) - y0) / (y1 - y0);
	expect(quarter).toBeLessThan(0.17);
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
		.scene.node('corner')!
		.surfaces.filter((s) => s.role === 'paving')
		.flatMap((s) => (Array.isArray(s.shape) ? s.shape.map(toPath) : []));
	expect(sum(paving)).toBeLessThan(0.01);
	// Both walks still cross: about 2 m wide each, over the bend.
	expect(sum(walks('corner'))).toBeGreaterThan(2 * 2 * 5);
});

test('a wide footpath crossing a street on a curve reads as a straight crossing', () => {
	const node = build().scene.node('bend')!;
	// The street carries on through with its lines, either side of the
	// crossing (about y = 0, 6 m wide): both edge lines and the double yellow.
	for (const side of [-1, 1]) {
		const here = node.markings.filter((m) => m.line.every((p) => p.y * side > 3));
		expect(here.filter((m) => m.colour === 'white')).toHaveLength(2);
		expect(here.filter((m) => m.colour === 'yellow')).toHaveLength(2);
	}
	expect(node.markings).toHaveLength(8);
	const crossing = node.crossings.find((c) => sum(runs(c, 'zebra')) > 0)!;
	// The path's paving runs up to the curb.
	expect(sum(runs(crossing, 'paved'))).toBeGreaterThan(6 * 2 * 2);
	// The zebra is as wide as the path (6 m, about y = 0)...
	const stripes = runs(crossing, 'zebra').map(fromPath);
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
