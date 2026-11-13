import { expect, test, type Page } from '@playwright/test';
import { openGraph, readScene } from './scenes';
import { shownAt } from '../src/lib/core/road-line';
import { check } from '../src/lib/lab/checks';
import { APPROACH_PAINT } from '../src/lib/lab/junction';
import type { Place } from '../src/lib/lab/model';
import { Scene } from '../src/lib/lab/scene';
import type { GraphData, Lane, SegmentData } from '../src/lib/core/types';

// Handles are held where the drawing stays sound. A junction end's shift
// keeps the node within the road's roadway (between the outer edges of its
// car lanes), so the road still opens onto its junction; the drag stops
// there, and so does Shift-snapping. The scene: skewed-four, a four-way
// junction k of divided roads (16 m: two lanes, a 2 m median, two lanes)
// with no sidewalks, each road from a dead end to k. At 2× zoom, looking
// at (40, 0) so the lane panel stays clear of the junction.
const ZOOM = 2;
const PX = (720 / 500) * ZOOM;
const CAM = { x: 40, y: 0 };
const VIEW = `topdown&model&cam=${CAM.x},${CAM.y},${ZOOM}`;
type Pt = { x: number; y: number };
const toScreen = ({ x, y }: Pt) => ({ x: 640 + (x - CAM.x) * PX, y: 360 + (y - CAM.y) * PX });

const graphOf = (page: Page) =>
	page.evaluate(() => (window as Window & { __graph?: () => GraphData }).__graph!());
const placeOf = (page: Page) =>
	page.evaluate(() => (window as Window & { __roadModel?: () => Place }).__roadModel?.());
const segmentOf = (graph: GraphData, id: string) => graph.segments.find((s) => s.id === id)!;
const nodeOf = (graph: GraphData, id: string) => graph.nodes.find((n) => n.id === id)!;

// Selects a road by clicking it, then drags its offset handle `by` metres
// across it (to its right as drawn), holding Shift when `snap`.
async function dragOffset(page: Page, road: string, by: number, snap = false) {
	const before = await graphOf(page);
	const s = segmentOf(before, road);
	const shifted = { ...s, offsetStart: s.offsetStart ?? 0, offsetEnd: s.offsetEnd ?? 0 };
	const [a, b] = [nodeOf(before, s.startNodeId), nodeOf(before, s.endNodeId)];
	const middle = toScreen(shownAt(shifted, a, b, 0.6).point);
	await page.mouse.click(middle.x, middle.y);
	await expect(page.locator('aside')).toBeVisible();
	const handle = shownAt(shifted, a, b, 0.25);
	const from = toScreen(handle.point);
	const to = toScreen({
		x: handle.point.x + handle.normal.x * by,
		y: handle.point.y + handle.normal.y * by
	});
	if (snap) await page.keyboard.down('Shift');
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 8 });
	await page.mouse.up();
	if (snap) await page.keyboard.up('Shift');
	await page.keyboard.press('Escape');
}

const sidewalked = (): Lane[] => [
	{ id: 'w0', role: 'pedestrian', material: 'concrete', width: 2, direction: 'bidirectional' },
	{ id: 'v0', role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'backward' },
	{ id: 'v1', role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' },
	{ id: 'w1', role: 'pedestrian', material: 'concrete', width: 2, direction: 'bidirectional' }
];

test.describe('a junction end shifted past its roadway', () => {
	for (const [road, by, limit] of [
		// Toward sw, at a right angle: past it the mouth slides off the node.
		['nw', -20, 8],
		// Toward se, 45° away: the crossing pass would also join the two
		// beside the junction.
		['e', 20, 8],
		['e', -20, 8]
	] as const) {
		test(`${road} dragged ${by} m stops at ${limit} m and stays one clean junction`, async ({
			page
		}, testInfo) => {
			await openGraph(page, readScene('skewed-four'), VIEW);
			await expect.poll(async () => (await placeOf(page))?.roads.length).toBe(4);
			await dragOffset(page, road, by);

			await expect
				.poll(async () => segmentOf(await graphOf(page), road).offsetEnd ?? 0)
				.not.toBe(0);
			const after = await graphOf(page);
			const shift = segmentOf(after, road).offsetEnd!;
			expect(Math.abs(shift)).toBeCloseTo(limit, 3);
			// Still the same four roads round one node.
			expect(after.segments.map((s) => s.id).sort()).toEqual(['e', 'nw', 'se', 'sw']);
			expect(after.nodes).toHaveLength(5);
			expect(check(new Scene((await placeOf(page))!))).toEqual([]);
			await page.screenshot({ path: testInfo.outputPath(`${road}${by}.png`) });
		});
	}

	test('Shift-snapping never lands past the limit', async ({ page }) => {
		// nw with sidewalks (11 m, car lanes ±3.5 m) carries on into se (16 m):
		// lining its kerb up with se's would shift it 4.5 m, past its roadway.
		const graph = readScene('skewed-four');
		graph.segments.find((s: SegmentData) => s.id === 'nw').lanes = sidewalked();
		await openGraph(page, graph, VIEW);
		await expect.poll(async () => (await placeOf(page))?.roads.length).toBe(4);
		for (const by of [4.5, -4.5]) {
			await dragOffset(page, 'nw', by, true);
			const shift = segmentOf(await graphOf(page), 'nw').offsetEnd ?? 0;
			expect(Math.abs(shift)).toBeLessThanOrEqual(3.5 + 1e-6);
		}
	});
});

// A footpath has no roadway to hold: its end at a junction slides until its
// whole width lies within the road it meets, sidewalks included. The scene,
// footpath-junction: a divided boulevard (27 m: 3 m sidewalks, 1 m verges,
// two lanes, a 5 m median, two lanes) runs north–south through junction k at
// the origin, and `path`, a 2 m footpath, runs east from a dead end w
// (-80, 0) to k. It may slide 13.5 - 1 = 12.5 m either way; it used to stop
// at its own edges, 1 m.
test.describe('a footpath end at a junction', () => {
	for (const by of [20, -20]) {
		test(`dragged ${by} m slides to the boulevard's edge and stays one clean junction`, async ({
			page
		}, testInfo) => {
			await openGraph(page, readScene('footpath-junction'), VIEW);
			await expect.poll(async () => (await placeOf(page))?.roads.length).toBe(3);
			await dragOffset(page, 'path', by);

			await expect
				.poll(async () => Math.abs(segmentOf(await graphOf(page), 'path').offsetEnd ?? 0))
				.toBeGreaterThan(1);
			const after = await graphOf(page);
			expect(segmentOf(after, 'path').offsetEnd).toBeCloseTo(Math.sign(by) * 12.5, 3);
			expect(after.segments.map((s) => s.id).sort()).toEqual(['north', 'path', 'south']);
			expect(after.nodes).toHaveLength(4);
			expect(check(new Scene((await placeOf(page))!))).toEqual([]);
			await page.screenshot({ path: testInfo.outputPath(`footpath${by}.png`) });
		});
	}
});

// Junction k of the setbacks scene: kw and ke run west and east, ks leaves
// south for 50 m to a dead end, drawn 14 m to its west. Its setback arrow
// grows the junction down ks, but always leaves the road room for the paint
// the junction lays on it: the crosswalk, its gap, and the stop line or
// give-way teeth behind it.
test('a setback arrow dragged off the end leaves the road room for its paint', async ({
	page
}, testInfo) => {
	const cam = { x: -10, y: 25 };
	const at = ({ x, y }: Pt) => ({ x: 640 + (x - cam.x) * PX, y: 360 + (y - cam.y) * PX });
	await openGraph(page, readScene('setbacks'), `topdown&model&cam=${cam.x},${cam.y},${ZOOM}`);
	await expect.poll(async () => (await placeOf(page))?.roads.length).toBe(3);
	const ring = at({ x: -14 / 3, y: 0 });
	await page.mouse.click(ring.x, ring.y);
	const from = at({ x: -14, y: 8.5 });
	const to = at({ x: -14, y: 70 });
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 8 });
	await page.mouse.up();

	await expect
		.poll(async () => nodeOf(await graphOf(page), 'k').junction?.setbacks?.ks ?? 0)
		.toBeGreaterThan(20);
	const setback = nodeOf(await graphOf(page), 'k').junction!.setbacks!.ks;
	expect(setback).toBeCloseTo(50 - APPROACH_PAINT, 3);
	expect(check(new Scene((await placeOf(page))!))).toEqual([]);
	await page.screenshot({ path: testInfo.outputPath('setback.png') });
});
