import { expect, test, type Page } from '@playwright/test';
import type { GraphData } from '../src/lib/core/types';
import { attachedEnd } from './attached-end';
import { saveCity } from './save';
import { openScene } from './scenes';

// Scene two-way-end: a Street from a (0, 0) east to b (60, 0). At a, its
// north edge (z < 0) carries the lane running out of the road (backward,
// b to a), its south edge the lane running in (forward, a to b).
const ZOOM = 4;
const PX = (720 / 500) * ZOOM;
const at = (x: number, z: number) => ({ x: 640 + x * PX, y: 360 + z * PX });
const NORTH = at(-0.5, -3);
const SOUTH = at(-0.5, 3);

interface Look {
	arrow: { at: { x: number; y: number }; dir: { x: number; y: number } } | null;
	blocked: boolean;
}

const open = async (page: Page, preset = 'One-way lane') => {
	await openScene(page, 'two-way-end', `topdown&model&cam=0,0,${ZOOM}`);
	await expect(page.locator('canvas')).toBeVisible();
	await page.getByRole('button', { name: preset }).click();
};

const hover = (page: Page, p: { x: number; y: number }) =>
	page.locator('canvas').hover({ position: p, force: true });
const click = (page: Page, p: { x: number; y: number }) =>
	page.locator('canvas').click({ position: p, force: true });

const ghostGraph = (page: Page) =>
	page.evaluate(() => (window as unknown as { __ghostGraph: () => GraphData }).__ghostGraph());
const ghostLook = (page: Page) =>
	page.evaluate(() => (window as unknown as { __ghostLook: () => Look }).__ghostLook());
const saved = async (page: Page): Promise<GraphData> => {
	await saveCity(page);
	return page.evaluate(() => JSON.parse(localStorage.getItem('citynista-graph-v2') ?? 'null'));
};

const added = (data: GraphData) => data.segments.filter((s) => s.id !== 'street');
const directions = (data: GraphData) => added(data)[0].lanes.map((l) => l.direction);

test.describe('Drawing at a road edge', () => {
	test('the edge clicked to start is the edge the road gets, however it curves', async ({
		page
	}, testInfo) => {
		await open(page);
		await click(page, NORTH);
		// The north edge: the road's end sits north of a's line, whichever way
		// the far end goes, flipped (F) or not.
		const north = async () => {
			const graph = await ghostGraph(page);
			expect(attachedEnd(graph, added(graph)[0].id, 'a').y).toBeLessThan(-1);
		};
		await hover(page, at(-30, 5));
		await north();
		await hover(page, at(-5, 25));
		await north();
		// Flipped, this curve leaves a heading east while its far end lies
		// west: the side used to be read off the line to the far end.
		await page.keyboard.press('f');
		await north();
		await page.screenshot({ path: testInfo.outputPath('edge-kept-flipped.png') });
		await click(page, at(-5, 25));

		const data = await saved(page);
		expect(attachedEnd(data, added(data)[0].id, 'a').y).toBeLessThan(-1);
	});

	test('a one-way road started at an edge runs with the lane it starts on', async ({
		page
	}, testInfo) => {
		// North: the lane runs out of the street, so the new road runs away.
		await open(page);
		await click(page, NORTH);
		await click(page, at(-30, -10));
		let data = await saved(page);
		expect(added(data)[0].startNodeId).toBe('a');
		expect(directions(data)).toEqual(['forward']);

		// South: the lane runs into the street, so the new road runs toward it.
		await open(page);
		await click(page, SOUTH);
		await click(page, at(-30, 10));
		await page.keyboard.press('Escape');
		await page.screenshot({ path: testInfo.outputPath('runs-with-lane.png') });
		data = await saved(page);
		expect(added(data)[0].startNodeId).toBe('a');
		expect(directions(data)).toEqual(['backward']);

		// The slot is untouched: on open ground the road runs as drawn.
		await click(page, at(-30, 40));
		await click(page, at(-60, 40));
		data = await saved(page);
		const free = added(data).find((s) => !['a', 'b'].includes(s.startNodeId))!;
		expect(free.lanes.map((l) => l.direction)).toEqual(['forward']);
	});

	test("a one-way road started at a one-way road's end carries its traffic on", async ({
		page
	}, testInfo) => {
		await open(page);
		// A one-way road on open ground, running west from p to q.
		await click(page, at(-40, 20));
		await click(page, at(-60, 20));
		await page.keyboard.press('Escape');
		const first = added(await saved(page))[0];

		// From p, where its traffic leaves, a new road feeds it: its traffic
		// runs toward p, though drawn away from it.
		await click(page, at(-40, 20));
		await click(page, at(-40, 40));
		await page.keyboard.press('Escape');
		// From q, where its traffic arrives, a new road carries it away.
		await click(page, at(-60, 20));
		await click(page, at(-60, 40));
		await page.keyboard.press('Escape');
		await page.screenshot({ path: testInfo.outputPath('carries-on.png') });

		const data = await saved(page);
		const from = (nodeId: string) =>
			added(data).find((s) => s.id !== first.id && s.startNodeId === nodeId)!;
		expect(from(first.startNodeId).lanes.map((l) => l.direction)).toEqual(['backward']);
		expect(from(first.endNodeId).lanes.map((l) => l.direction)).toEqual(['forward']);
	});

	test('the preview shows which way a one-way road runs', async ({ page }, testInfo) => {
		await open(page);
		await click(page, SOUTH);
		await hover(page, at(-30, 10));
		// Started on the lane running in: traffic heads east, toward a.
		const look = await ghostLook(page);
		expect(look.arrow).not.toBeNull();
		expect(look.arrow!.dir.x).toBeGreaterThan(0.5);
		await page.screenshot({ path: testInfo.outputPath('direction-arrow.png') });
		await page.keyboard.press('Escape');

		await click(page, NORTH);
		await hover(page, at(-30, -10));
		expect((await ghostLook(page)).arrow!.dir.x).toBeLessThan(-0.5);

		// A two-way road shows none.
		await page.keyboard.press('Escape');
		await page.getByRole('button', { name: 'Street' }).click();
		await click(page, at(-30, 30));
		await hover(page, at(-60, 30));
		await expect.poll(async () => (await ghostGraph(page))?.segments.length).toBe(1);
		expect((await ghostLook(page)).arrow).toBeNull();
	});

	test('a road that would meet a lane head-on turns red and is not laid', async ({
		page
	}, testInfo) => {
		await open(page);
		await click(page, at(-40, -2));
		// Ending at the north edge it would run into traffic leaving the street.
		await hover(page, NORTH);
		expect((await ghostLook(page)).blocked).toBe(true);
		await page.screenshot({ path: testInfo.outputPath('head-on-edge.png') });
		await click(page, NORTH);
		expect(added(await saved(page))).toHaveLength(0);

		// The south edge takes it.
		await hover(page, SOUTH);
		expect((await ghostLook(page)).blocked).toBe(false);
		await click(page, SOUTH);
		await page.keyboard.press('Escape');
		expect(added(await saved(page))).toHaveLength(1);

		// A node every lane only runs into: a one-way road's far end.
		await click(page, at(-40, 20));
		await click(page, at(-60, 20));
		await page.keyboard.press('Escape');
		await click(page, at(-60, 40));
		await hover(page, at(-60, 20));
		expect((await ghostLook(page)).blocked).toBe(true);
		await page.screenshot({ path: testInfo.outputPath('head-on-node.png') });
		await click(page, at(-60, 20));
		expect(added(await saved(page))).toHaveLength(2);
		// Its start, where traffic leaves, takes it.
		await hover(page, at(-40, 20));
		expect((await ghostLook(page)).blocked).toBe(false);
	});
});
