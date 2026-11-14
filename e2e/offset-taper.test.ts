import { expect, test } from '@playwright/test';
import { check } from '../src/lib/road-model/checks';
import { Drawing } from '../src/lib/road-model/drawing';
import type { Lane } from '../src/lib/core/types';
import { dragOffset, liveGraph, openGraph, roadModel, screenAt, PX_PER_M } from './app';
import { drawnCentre, nodeOf, segmentOf } from '../unit/model';

// A two-way road (lane, buffer, lane) from w (-60,0) east to n (0,0),
// extended east by a road of the same lanes to a dead end e (60,0). Where
// two roads with the same lanes meet the offset handle takes their node
// along; once the extension is cut down to one lane they meet in a taper,
// and its end there keeps a shift instead, so the two-way road stays put.
// At 4× zoom, looking at (10, 0).
const ZOOM = 4;
const PX = PX_PER_M * ZOOM;
const CAM = { x: 10, y: 0 };
const toScreen = screenAt(ZOOM, CAM);

const twoWay = (p: string): Lane[] => [
	{ id: `${p}0`, role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'backward' },
	{ id: `${p}1`, role: 'buffer', material: 'concrete', width: 1, direction: 'bidirectional' },
	{ id: `${p}2`, role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' }
];

const GRAPH = {
	nodes: [
		{ id: 'w', x: -60, y: 0 },
		{ id: 'n', x: 0, y: 0 },
		{ id: 'e', x: 60, y: 0 }
	],
	segments: [
		{ id: 'road', startNodeId: 'w', endNodeId: 'n', lanes: twoWay('r') },
		{ id: 'ext', startNodeId: 'n', endNodeId: 'e', lanes: twoWay('x') }
	]
};

test.beforeEach(async ({ page }) => {
	await openGraph(page, GRAPH, `topdown&model&cam=${CAM.x},${CAM.y},${ZOOM}`);
	await expect.poll(async () => (await roadModel(page))?.roads.length).toBe(2);
});

test('an extension with the same lanes takes the node along', async ({ page }) => {
	await dragOffset(page, toScreen, 'ext', 2);

	await expect.poll(async () => nodeOf(await liveGraph(page), 'n').y).toBeGreaterThan(1);
	const ext = segmentOf(await liveGraph(page), 'ext');
	expect(ext.offsetStart ?? 0).toBe(0);
	expect(ext.offsetEnd ?? 0).toBe(0);
});

test('an extension cut to one lane slides onto a lane of the two-way road', async ({
	page
}, testInfo) => {
	const shot = async (name: string) => {
		await page.keyboard.press('Escape');
		await page.mouse.move(toScreen(10, 40).x, toScreen(10, 40).y);
		await page.screenshot({
			path: testInfo.outputPath(name),
			clip: { x: toScreen(-30, 0).x, y: 360 - 15 * PX, width: 70 * PX, height: 30 * PX }
		});
	};
	// Cut the extension down to its eastbound lane in the lane panel.
	const ext = toScreen(40, 0);
	await page.mouse.click(ext.x, ext.y);
	const remove = page.locator('aside').getByTitle('Remove lane');
	for (const left of [2, 1]) {
		await remove.first().click();
		await expect(remove).toHaveCount(left);
	}
	const before = await liveGraph(page);
	expect(segmentOf(before, 'ext').lanes.map((l) => l.id)).toEqual(['x2']);
	await shot('taper-before.png');

	// About 2 m south with Shift snaps to 2.25 m, on the eastbound lane.
	await dragOffset(page, toScreen, 'ext', 2, true);

	await expect
		.poll(async () => segmentOf(await liveGraph(page), 'ext').offsetStart ?? 0)
		.toBeCloseTo(2.25, 3);
	const after = await liveGraph(page);
	expect(nodeOf(after, 'n')).toMatchObject({ x: 0, y: 0 });
	expect(nodeOf(after, 'w')).toMatchObject({ x: -60, y: 0 });
	expect(segmentOf(after, 'road')).toEqual(segmentOf(before, 'road'));
	// The dead end goes along with the road and keeps no shift.
	expect(nodeOf(after, 'e').y).toBeCloseTo(2.25, 3);
	expect(segmentOf(after, 'ext').offsetEnd ?? 0).toBe(0);
	// As drawn: the lane runs on along the eastbound lane's centre, y = 2.25.
	const place = (await roadModel(page))!;
	const road = place.roads.find((r) => r.id === 'ext')!;
	for (const f of [0, 0.5, 1]) expect(drawnCentre(road, f).y).toBeCloseTo(2.25, 1);
	expect(check(new Drawing(place))).toEqual([]);
	await shot('taper-after.png');
});
