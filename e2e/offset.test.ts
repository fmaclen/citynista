import { expect, test, type Page } from '@playwright/test';
import { openScene } from './scenes';
import { shownAt } from '../src/lib/core/road-line';
import { crossSection, frameAt, offsetPoint, samplePath } from '../src/lib/lab/geometry';
import type { Road } from '../src/lib/lab/model';
import type { GraphData, SegmentData } from '../src/lib/core/types';

// The offset handle slides a road sideways, parallel to where it was. An end
// at a node of one or two roads takes its node along; an end at a junction
// of three or more keeps a shift there, its node staying put. The scene, at
// 2× zoom: T junctions j1 (0,-40) and j2 (0,20), joined by `mid`; `tail`
// runs south from j2 to a dead end t (0,80); `free` is a curve on its own
// from f1 (-160,-60) to f2 (-160,40).
const ZOOM = 2;
const PX = (720 / 500) * ZOOM;
type Pt = { x: number; y: number };
const toScreen = ({ x, y }: Pt) => ({ x: 640 + x * PX, y: 360 + y * PX });

const graphOf = (page: Page) =>
	page.evaluate(() => (window as Window & { __graph?: () => GraphData }).__graph!());
const roadsOf = (page: Page) =>
	page.evaluate(
		() => (window as Window & { __roadModel?: () => { roads: Road[] } }).__roadModel!().roads
	);

const nodeOf = (graph: GraphData, id: string) => graph.nodes.find((n) => n.id === id)!;
const segmentOf = (graph: GraphData, id: string) => graph.segments.find((s) => s.id === id)!;
const shifted = (s: SegmentData) => ({
	...s,
	offsetStart: s.offsetStart ?? 0,
	offsetEnd: s.offsetEnd ?? 0
});

// The middle of a road's cross-section as drawn, at a fraction of its length.
function drawnCentre(road: Road, f: number) {
	const path = samplePath(road);
	const d = path.length * f;
	const frame = frameAt(path, d);
	const spans = crossSection(road, d);
	return offsetPoint(frame.p, frame.n, (spans[0].left + spans.at(-1)!.right) / 2);
}

// Selects a road by clicking it, then drags its offset handle `by` metres
// across it (to its right). Returns the handle's normal.
async function dragOffset(page: Page, road: string, click: Pt, by: number) {
	await page.mouse.click(toScreen(click).x, toScreen(click).y);
	await expect(page.locator('aside')).toBeVisible();
	const graph = await graphOf(page);
	const s = shifted(segmentOf(graph, road));
	const handle = shownAt(s, nodeOf(graph, s.startNodeId), nodeOf(graph, s.endNodeId), 0.25);
	const from = toScreen(handle.point);
	const to = toScreen({
		x: handle.point.x + handle.normal.x * by,
		y: handle.point.y + handle.normal.y * by
	});
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 8 });
	await page.mouse.up();
	return handle.normal;
}

test.beforeEach(async ({ page }) => {
	await openScene(page, 'offset', `topdown&model&cam=0,0,${ZOOM}`);
	await expect(page.locator('nav')).toBeVisible();
	await expect.poll(async () => (await roadsOf(page)).length).toBe(7);
});

test('a road with dead ends takes its nodes along, rings on the road', async ({ page }) => {
	const before = await graphOf(page);
	const s = shifted(segmentOf(before, 'free'));
	const [a, b] = [nodeOf(before, 'f1'), nodeOf(before, 'f2')];
	// The road's normal at each end before the drag.
	const normals = [0, 1].map((t) => shownAt(s, a, b, t).normal);
	await dragOffset(page, 'free', { x: -147.5, y: -10 }, 4);

	await expect.poll(async () => nodeOf(await graphOf(page), 'f1').x).not.toBe(a.x);
	const after = await graphOf(page);
	const free = segmentOf(after, 'free');
	expect(free.offsetStart ?? 0).toBe(0);
	expect(free.offsetEnd ?? 0).toBe(0);
	// Each node moved straight across its end of the road, by the drag.
	for (const [i, id] of ['f1', 'f2'].entries()) {
		const node = nodeOf(after, id);
		const was = i ? b : a;
		const moved = { x: node.x - was.x, y: node.y - was.y };
		expect(moved.x * normals[i].x + moved.y * normals[i].y).toBeCloseTo(4, 0);
		expect(Math.abs(moved.x * normals[i].y - moved.y * normals[i].x)).toBeLessThan(0.01);
	}
	// The road is drawn out to its nodes: its rings sit on it.
	const road = (await roadsOf(page)).find((r) => r.id === 'free')!;
	for (const [f, id] of [
		[0, 'f1'],
		[1, 'f2']
	] as const) {
		const centre = drawnCentre(road, f);
		const node = nodeOf(after, id);
		expect(Math.hypot(centre.x - node.x, centre.y - node.y)).toBeLessThan(0.05);
	}
});

test('a road from a junction to a dead end shows parallel, the junction staying', async ({
	page
}, testInfo) => {
	const shot = (name: string) =>
		page.screenshot({
			path: testInfo.outputPath(name),
			clip: { x: 640 - 60 * PX, y: 360 - 5 * PX, width: 120 * PX, height: 95 * PX }
		});
	await page.mouse.click(toScreen({ x: 0, y: 60 }).x, toScreen({ x: 0, y: 60 }).y);
	await expect(page.locator('aside')).toBeVisible();
	await shot('tail-before.png');
	// Drawn southward, so its right is west: 3 m east is -3.
	await dragOffset(page, 'tail', { x: 0, y: 60 }, -3);

	await expect.poll(async () => nodeOf(await graphOf(page), 't').x).toBeCloseTo(3, 0);
	const after = await graphOf(page);
	expect(nodeOf(after, 'j2')).toMatchObject({ x: 0, y: 20 });
	expect(nodeOf(after, 't').y).toBe(80);
	const tail = segmentOf(after, 'tail');
	// The junction end keeps the shift, the dead end has none.
	expect(tail.offsetStart).toBeLessThan(-2.5);
	expect(tail.offsetEnd ?? 0).toBe(0);
	// As drawn: straight down x = 4 from the junction to the dead end.
	const road = (await roadsOf(page)).find((r) => r.id === 'tail')!;
	const t = nodeOf(after, 't');
	for (const f of [0, 0.25, 0.5, 0.75, 1]) expect(drawnCentre(road, f).x).toBeCloseTo(t.x, 1);
	await page.mouse.move(toScreen({ x: 40, y: 80 }).x, toScreen({ x: 40, y: 80 }).y);
	await shot('tail-after.png');
});

test('a road between two junctions keeps its nodes and shifts both ends', async ({ page }) => {
	await dragOffset(page, 'mid', { x: 0, y: -10 }, -3);

	await expect.poll(async () => segmentOf(await graphOf(page), 'mid').offsetStart).toBeDefined();
	const after = await graphOf(page);
	expect(nodeOf(after, 'j1')).toMatchObject({ x: 0, y: -40 });
	expect(nodeOf(after, 'j2')).toMatchObject({ x: 0, y: 20 });
	const mid = segmentOf(after, 'mid');
	expect(mid.offsetStart).toBeCloseTo(-3, 0);
	expect(mid.offsetEnd).toBe(mid.offsetStart);
	const road = (await roadsOf(page)).find((r) => r.id === 'mid')!;
	for (const f of [0, 0.5, 1]) expect(drawnCentre(road, f).x).toBeCloseTo(-mid.offsetStart!, 1);
});

test('one undo puts the road, its nodes and its shifts back', async ({ page }) => {
	const before = await graphOf(page);
	await dragOffset(page, 'tail', { x: 0, y: 60 }, -4);
	await expect.poll(async () => nodeOf(await graphOf(page), 't').x).not.toBe(0);

	await page.keyboard.press('Escape');
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => graphOf(page)).toEqual(before);
});
