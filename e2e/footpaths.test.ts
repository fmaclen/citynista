import { expect, test, type Page } from '@playwright/test';
import { openScene, readScene } from './scenes';
import { PlaceBuilder } from '../src/lib/core/place';
import { serializeLanes } from '../src/lib/core/lane-template';
import type { GraphData } from '../src/lib/core/types';
import { area, fromPath, intersect, toPath, union, type Paths } from '../src/lib/lab/clip';
import { curveBetween } from '../src/lib/lab/geometry';
import { Scene } from '../src/lib/lab/scene';

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
// Each test screenshots its case through the editor and checks the drawing
// off the road model.

const sum = (paths: Paths) => paths.reduce((s, p) => s + Math.abs(area(p)), 0);

function build() {
	const data = readScene('footpaths') as GraphData;
	const nodes = new Map(data.nodes.map((n) => [n.id, { ...n, connectedSegments: [] as string[] }]));
	const segments = new Map(
		data.segments.map((s) => [
			s.id,
			{
				...s,
				hasControlPoint: s.controlX !== undefined,
				offsetStart: s.offsetStart ?? 0,
				offsetEnd: s.offsetEnd ?? 0,
				lanesKey: serializeLanes(s.lanes),
				totalWidth: s.lanes.reduce((a, l) => a + l.width, 0)
			}
		])
	);
	for (const s of segments.values()) {
		nodes.get(s.startNodeId)!.connectedSegments.push(s.id);
		nodes.get(s.endNodeId)!.connectedSegments.push(s.id);
	}
	const derived = new PlaceBuilder().build({ nodes, segments } as never);
	const scene = new Scene(derived.place);
	scene.build();
	return { derived, scene };
}

async function shoot(page: Page, name: string, cam: string) {
	await openScene(page, 'footpaths', `topdown&cam=${cam}`);
	await expect(page.locator('nav')).toBeVisible();
	await page.mouse.move(640, 59);
	await page.screenshot({ path: `test-results/footpaths-${name}.png` });
}

test('a footpath crossing a street runs on over its sidewalks as paving', async ({ page }) => {
	await shoot(page, 'cross', '0,0,8');
	const crossing = build().scene.junctionDraw('cross')!.crossings[0];
	// Up to the zebra it is the path's own paving, not the darker trail.
	expect(crossing.trail).toEqual([]);
	expect(sum(crossing.paving)).toBeGreaterThan(2 * 2 * 1.5);
	expect(sum(crossing.zebra)).toBeGreaterThan(0);
});

test('a footpath drawn on a curve through a node on a street crosses it there', async ({
	page
}) => {
	await shoot(page, 'arc', '120,2,12');
	const draw = build().scene.junctionDraw('arc')!;
	expect(draw.crossings).toHaveLength(1);
	const [crossing] = draw.crossings;
	expect(sum(crossing.zebra)).toBeGreaterThan(0);
	// Its stripes lie square to the line between the path ends, across the
	// street (which runs north-south): each one taller than it is wide.
	for (const stripe of crossing.zebra.map(fromPath)) {
		const xs = stripe.map((p) => p.x);
		const ys = stripe.map((p) => p.y);
		expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(Math.max(...xs) - Math.min(...xs));
	}
});

test('a footpath leaving a street off its sidewalk eases across over a taper', async ({ page }) => {
	await shoot(page, 'leave', '250,0,8');
	const { derived } = build();
	// It steps 4.5 m across (the sidewalk's middle to the street's), so its
	// node is at least three times that long.
	const street = derived.spans.get('leave-street')!;
	const path = derived.spans.get('leave-path')!;
	const taper = street.total - street.d0 - street.length + path.d0;
	expect(taper).toBeGreaterThanOrEqual(3 * 4.5 - 0.01);
});

test('a footpath set on a long taper by hand follows an eased curve', async ({ page }) => {
	await shoot(page, 'eased', '365,0,8');
	const band = union(
		build()
			.scene.junctionDraw('eased')!
			.islands.map((i) => i.path)
	);
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

test('a footpath joined to both sidewalks of a street end leaves no paving between', async ({
	page
}) => {
	await shoot(page, 'corner', '480,-5,10');
	const draw = build().scene.junctionDraw('corner')!;
	expect(sum(draw.asphalt)).toBeLessThan(0.01);
	// Both walks still cross: about 2 m wide each, over the bend.
	expect(sum(draw.islands.map((i) => i.path))).toBeGreaterThan(2 * 2 * 5);
});

test('a wide footpath crossing a street on a curve reads as a straight crossing', async ({
	page
}) => {
	await shoot(page, 'bend', '612,0,12');
	const draw = build().scene.junctionDraw('bend')!;
	// The street carries on through with its lines: both edge lines and the
	// double yellow.
	expect(draw.marks.filter((m) => m.colour === 'white')).toHaveLength(2);
	expect(draw.marks.filter((m) => m.colour === 'yellow')).toHaveLength(2);
	const crossing = draw.crossings.find((c) => sum(c.zebra) > 0)!;
	// The path's paving runs up to the curb.
	expect(crossing.trail).toEqual([]);
	expect(sum(crossing.paving)).toBeGreaterThan(6 * 2 * 2);
	// The zebra is as wide as the path (6 m, about y = 0)...
	const zebra = crossing.zebra.flatMap(fromPath);
	for (const p of zebra) expect(Math.abs(p.y)).toBeLessThan(3.05);
	// ...and its stripes run along the street: their edges, weighted by
	// length, lie along (1, 2) to within 10°.
	let c2 = 0;
	let s2 = 0;
	for (const stripe of crossing.zebra.map(fromPath))
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
