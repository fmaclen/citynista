import { expect, test } from '@playwright/test';
import { check } from '../src/lib/road-model/checks';
import { APPROACH_PAINT } from '../src/lib/road-model/approach';
import type { Lane } from '../src/lib/core/types';
import { dragOffset, drawingOf, liveGraph, openGraph, roadModel, screenAt } from './app';
import { nodeOf, readScene, segmentOf } from '../unit/model';

// Handles are held where the drawing stays sound. A junction end's shift
// keeps the node within the road's roadway (between the outer edges of its
// car lanes), so the road still opens onto its junction; the drag stops
// there, and so does Shift-snapping. The scene: skewed-four, a four-way
// junction k of divided roads (16 m: two lanes, a 2 m median, two lanes)
// with no sidewalks, each road from a dead end to k. At 2× zoom, looking
// at (40, 0) so the lane panel stays clear of the junction.
const ZOOM = 2;
const CAM = { x: 40, y: 0 };
const VIEW = `topdown&model&cam=${CAM.x},${CAM.y},${ZOOM}`;
const toScreen = screenAt(ZOOM, CAM);

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
			await expect.poll(async () => (await roadModel(page))?.roads.length).toBe(4);
			await dragOffset(page, toScreen, road, by);

			await expect
				.poll(async () => segmentOf(await liveGraph(page), road).offsetEnd ?? 0)
				.not.toBe(0);
			const after = await liveGraph(page);
			const shift = segmentOf(after, road).offsetEnd!;
			expect(Math.abs(shift)).toBeCloseTo(limit, 3);
			// Still the same four roads round one node.
			expect(after.segments.map((s) => s.id).sort()).toEqual(['e', 'nw', 'se', 'sw']);
			expect(after.nodes).toHaveLength(5);
			expect(check(await drawingOf(page))).toEqual([]);
			await page.screenshot({ path: testInfo.outputPath(`${road}${by}.png`) });
		});
	}

	test('Shift-snapping never lands past the limit', async ({ page }) => {
		// nw with sidewalks (11 m, car lanes ±3.5 m) carries on into se (16 m):
		// lining its kerb up with se's would shift it 4.5 m, past its roadway.
		const graph = readScene('skewed-four');
		segmentOf(graph, 'nw').lanes = sidewalked();
		await openGraph(page, graph, VIEW);
		await expect.poll(async () => (await roadModel(page))?.roads.length).toBe(4);
		for (const by of [4.5, -4.5]) {
			await dragOffset(page, toScreen, 'nw', by, true);
			const shift = segmentOf(await liveGraph(page), 'nw').offsetEnd ?? 0;
			expect(Math.abs(shift)).toBeLessThanOrEqual(3.5 + 1e-6);
		}
	});
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
	const at = screenAt(ZOOM, cam);
	await openGraph(page, readScene('setbacks'), `topdown&model&cam=${cam.x},${cam.y},${ZOOM}`);
	await expect.poll(async () => (await roadModel(page))?.roads.length).toBe(3);
	const ring = at(-14 / 3, 0);
	await page.mouse.click(ring.x, ring.y);
	const from = at(-14, 8.5);
	const to = at(-14, 70);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 8 });
	await page.mouse.up();

	await expect
		.poll(async () => nodeOf(await liveGraph(page), 'k').junction?.setbacks?.ks ?? 0)
		.toBeGreaterThan(20);
	const setback = nodeOf(await liveGraph(page), 'k').junction!.setbacks!.ks;
	expect(setback).toBeCloseTo(50 - APPROACH_PAINT, 3);
	expect(check(await drawingOf(page))).toEqual([]);
	await page.screenshot({ path: testInfo.outputPath('setback.png') });
});
