import { expect, test, type Page } from '@playwright/test';
import { openScene } from './scenes';
import { check } from '../src/lib/lab/checks';
import { area } from '../src/lib/lab/clip';
import type { GraphData } from '../src/lib/core/types';
import type { Place } from '../src/lib/lab/model';
import { Scene } from '../src/lib/lab/scene';

// e2e/scenes/short-footpath.json: a side street (w–t, two lanes and a 2 m
// sidewalk each side) ends at t, where a 20 m footpath (t–j) carries both
// its sidewalks on east to j, a node on a north-south main street; a second
// footpath carries on east of it. Moving the side street or t toward the main
// street shortens the footpath: it stays a footpath, crossing the main street
// on a zebra, however short it gets (down to 8 m here).
const ZOOM = 3;
const CAM = { x: -10, y: 0 };
const PX = (720 / 500) * ZOOM;
const toScreen = (x: number, y: number) => ({
	x: 640 + (x - CAM.x) * PX,
	y: 360 + (y - CAM.y) * PX
});

async function open(page: Page) {
	await openScene(page, 'short-footpath', `topdown&model&cam=${CAM.x},${CAM.y},${ZOOM}`);
	await expect(page.locator('nav')).toBeVisible();
	await expect.poll(async () => !!(await model(page))).toBe(true);
}

const graph = (page: Page) =>
	page.evaluate(() => (window as Window & { __graph?: () => GraphData }).__graph!());
const model = (page: Page) =>
	page.evaluate(() => (window as Window & { __roadModel?: () => Place }).__roadModel?.());

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 10 });
	await page.mouse.up();
}

const tAt = async (page: Page) => (await graph(page)).nodes.find((n) => n.id === 't')!.x;

// The drawing the editor runs on, as it stands after the drag.
async function drawn(page: Page) {
	const place = (await model(page))!;
	const scene = new Scene(place);
	scene.build();
	return { place, scene };
}

async function expectFootpathKept(page: Page, t: number) {
	const { place, scene } = await drawn(page);
	// The footpath is drawn as its own road, not merged away into one
	// junction with the main street...
	const path = place.roads.find((r) => r.id === 'path')!;
	expect(path).toBeDefined();
	expect(scene.hidden.has('path')).toBe(false);
	expect(path.points[0].x).toBeGreaterThan(t);
	// ...and the side street stops short of t, never running on past it.
	const side = place.roads.find((r) => r.id === 'side')!;
	expect(side.points.at(-1)!.x).toBeLessThan(t);
	// The footpath crosses the main street on a zebra at j.
	const j = scene.junctionDraw('j')!;
	expect(j).toBeDefined();
	const zebra = j.crossings.flatMap((c) => c.zebra).reduce((s, p) => s + Math.abs(area(p)), 0);
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
