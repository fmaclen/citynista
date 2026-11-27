import { expect, test, type Page } from '@playwright/test';
import { check } from '../src/lib/road-model/checks';
import { area, toPath } from '../src/lib/road-model/clip';
import {
	drawingOf,
	expectFreshDrawing,
	liveGraph,
	openScene,
	type Pt,
	roadModel,
	screenAt
} from './app';

// Whatever a test here edits, the editor draws as a fresh build of its graph
// would.
test.afterEach(({ page }) => expectFreshDrawing(page));

// e2e/scenes/short-footpath.json: a side street (w–t, two lanes and a 2 m
// sidewalk each side) ends at t, where a 20 m footpath (t–j) carries both
// its sidewalks on east to j, a node on a north-south main street; a second
// footpath carries on east of it. Moving the side street or t toward the main
// street shortens the footpath: it stays a footpath, crossing the main street
// on a zebra, however short it gets (down to 8 m here).
const ZOOM = 3;
const CAM = { x: -10, y: 0 };
const toScreen = screenAt(ZOOM, CAM);

async function open(page: Page) {
	await openScene(page, 'short-footpath', `topdown&model&cam=${CAM.x},${CAM.y},${ZOOM}`);
	await expect.poll(async () => !!(await roadModel(page))).toBe(true);
}

async function drag(page: Page, from: Pt, to: Pt) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 10 });
	await page.mouse.up();
}

const tAt = async (page: Page) => (await liveGraph(page)).nodes.find((n) => n.id === 't')!.x;

// The drawing the editor runs on, as it stands after the drag.
async function drawn(page: Page) {
	const scene = await drawingOf(page);
	return { place: scene.place, scene };
}

async function expectFootpathKept(page: Page, t: number) {
	const { place, scene } = await drawn(page);
	// The footpath is drawn as its own strip, from its node at t on...
	const path = place.roads.find((r) => r.id === 'path')!;
	expect(path).toBeDefined();
	expect(path.points[0].x).toBeCloseTo(t, 6);
	// ...and the side street, built as if the footpath weren't there, runs
	// on to t, never past it.
	const side = place.roads.find((r) => r.id === 'side')!;
	expect(side.points.at(-1)!.x).toBeLessThanOrEqual(t + 1e-6);
	// The footpath crosses the main street on a zebra at j, drawn by the
	// main street's pieces there.
	const pieces = [
		...place.roads.map((r) => scene.road(r.id)!),
		...place.junctions.map((j) => scene.node(j.id)!)
	];
	const zebra = pieces
		.flatMap((d) => d.crossings)
		.filter((c) => c.body.flat().some((p) => Math.hypot(p.x, p.y) < 8))
		.flatMap((c) => c.runs.filter((r) => r.kind === 'zebra').flatMap((r) => r.rings))
		.reduce((s, ring) => s + Math.abs(area(toPath(ring))), 0);
	expect(zebra).toBeGreaterThan(2);
	expect(check(scene)).toEqual([]);
}

test('dragging the footpath end toward the main street keeps the footpath', async ({ page }) => {
	await open(page);
	await page.screenshot({ path: 'test-results/short-footpath-node-before.png' });
	await drag(page, toScreen(-20, 0), toScreen(-8, 0));
	await expect.poll(() => tAt(page)).toBeGreaterThan(-8.5);
	await page.mouse.move(640, 59);
	await page.screenshot({ path: 'test-results/short-footpath-node-after.png' });
	await expectFootpathKept(page, await tAt(page));
});

test('dragging the side street toward the main street keeps the footpath', async ({ page }) => {
	await open(page);
	await page.screenshot({ path: 'test-results/short-footpath-road-before.png' });
	// Grab the side street on its centre line, clear of t's ring.
	await drag(page, toScreen(-40, 0), toScreen(-28, 0));
	await expect.poll(() => tAt(page)).toBeGreaterThan(-8.5);
	await page.mouse.move(640, 59);
	await page.screenshot({ path: 'test-results/short-footpath-road-after.png' });
	await expectFootpathKept(page, await tAt(page));
});
