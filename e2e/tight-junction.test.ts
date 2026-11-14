import { expect, test, type Page } from '@playwright/test';
import { expectSelectMode, liveGraph, openScene, screenAt, type Pt } from './app';

// Node rings are a fixed 20 px on screen and are the node's click area, so
// zooming in uncovers short roads between close nodes. The scene: a straight
// road a(-60,0) – b(0,0) – c(5,0) – d(65,0), a 5 m link b–c in the middle, and
// a one-lane road e(-60,60) – f(60,60) on its own.
const RING_PX = 20;
const MAX_ZOOM = 10;

const open = async (page: Page, zoom: number, cx: number) => {
	await openScene(page, 'tight-junction', `topdown&model&cam=${cx},0,${zoom}`);
	return screenAt(zoom, { x: cx, y: 0 });
};

const lanePanel = (page: Page) => page.locator('aside');

// Along the road east of `node`: inside the ring picks the node (no lane
// panel), just outside picks the road.
const ringEdge = async (page: Page, node: Pt) => {
	await page.mouse.click(node.x + RING_PX - 1, node.y);
	await expect(lanePanel(page)).not.toBeVisible();
	await page.mouse.click(node.x + RING_PX + 1, node.y);
	await expect(lanePanel(page)).toBeVisible();
};

test.describe('Tight junction', () => {
	test('at the default zoom a ring is 20 px, a split near a road end lands, and the wheel uncovers a short road', async ({
		page
	}) => {
		const toScreen = await open(page, 1, 0);
		await ringEdge(page, toScreen(-60, 0));

		// 12 m from the end of a one-lane road: closer than a node ring here,
		// but clear of the road's own width.
		await page.keyboard.press('Escape');
		await page.getByTitle('Split (click a road to cut it at that point)').click();
		const cut = toScreen(-48, 60);
		await page.mouse.move(cut.x, cut.y);
		await page.mouse.click(cut.x, cut.y);
		await expect.poll(async () => (await liveGraph(page)).segments.length).toBe(5);

		// 24 px right of b: inside c's ring here, so it picks a node. Wheeled in
		// to the furthest zoom (about b, the camera target) it lands on b–c
		// between the two rings and picks the road.
		await page.keyboard.press('Escape');
		await expectSelectMode(page);
		const gap = { x: 664, y: 360 };
		await page.mouse.click(gap.x, gap.y);
		await expect(lanePanel(page)).not.toBeVisible();
		await page.keyboard.press('Escape');
		await page.mouse.move(640, 360);
		for (let i = 0; i < 25; i++) await page.mouse.wheel(0, -100);
		await expect(async () => {
			await page.mouse.click(gap.x, gap.y);
			await expect(lanePanel(page)).toBeVisible({ timeout: 500 });
		}).toPass();
	});

	test('zoomed in, the ring stays 20 px and a 5 m road is hovered, clicked and dragged', async ({
		page
	}, testInfo) => {
		const toScreen = await open(page, MAX_ZOOM, 2.5);
		await ringEdge(page, toScreen(0, 0));

		// The middle of b–c sits between the two rings.
		await page.keyboard.press('Escape');
		await page.mouse.click(toScreen(-10, 10).x, toScreen(-10, 10).y);
		await expect(lanePanel(page)).not.toBeVisible();
		const mid = toScreen(2.5, 0);
		await page.mouse.move(mid.x, mid.y);
		await page.screenshot({ path: testInfo.outputPath('hover.png') });
		await page.mouse.click(mid.x, mid.y);
		await expect(lanePanel(page)).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath('selected.png') });

		// Dragging the road (off its handles, on the sidewalk) moves both of
		// its nodes and nothing else.
		const grab = toScreen(2.5, 4);
		await page.mouse.move(grab.x, grab.y);
		await page.mouse.down();
		await page.mouse.move(grab.x, grab.y + 15, { steps: 3 });
		await page.mouse.move(grab.x, grab.y + 30, { steps: 3 });
		await page.mouse.up();
		await expect
			.poll(async () => {
				const nodes = (await liveGraph(page)).nodes;
				const y = (id: string) => nodes.find((n) => n.id === id)?.y ?? NaN;
				return ['a', 'b', 'c', 'd'].map((id) => Math.round(y(id) * 10) / 10);
			})
			.toEqual([0, 2.1, 2.1, 0]);
	});
});
