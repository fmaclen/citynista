import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'citynista-graph-v2';

const GRAPH_DATA = {
	nodes: [
		{ id: 'node-0', x: -200, y: 0 },
		{ id: 'node-1', x: 0, y: 0 },
		{ id: 'node-2', x: 200, y: 0 }
	],
	segments: [
		{ id: 'segment-0', startNodeId: 'node-0', endNodeId: 'node-1', laneTemplateId: 'street' },
		{ id: 'segment-1', startNodeId: 'node-1', endNodeId: 'node-2', laneTemplateId: 'avenue' }
	]
};

// world -> screen at the default camera: screen = center + world * (720 / 500)
const SCALE = 720 / 500;
const toScreen = (x: number, y: number) => ({ x: 640 + x * SCALE, y: 360 + y * SCALE });

test.describe('Marquee Selection', () => {
	test('dragging a rectangle selects the contained nodes and segments', async ({ page }) => {
		await page.goto('/?topdown');
		await expect(page.locator('canvas')).toBeVisible();
		await page.evaluate(
			({ key, data }) => {
				localStorage.setItem(key, JSON.stringify(data));
			},
			{ key: STORAGE_KEY, data: GRAPH_DATA }
		);
		await page.reload();
		await expect(page.locator('canvas')).toBeVisible();
		await expect(page.locator('nav')).toBeVisible();

		// Drag a rectangle around only the street and its endpoints.
		const start = toScreen(-250, -60);
		const end = toScreen(50, 60);
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(end.x, end.y);
		await page.mouse.up();

		// One segment selected: the panel shows the street's four lanes.
		const panel = page.locator('aside');
		await expect(panel).toBeVisible();
		await expect(panel.locator('input[type="number"]')).toHaveCount(4);

		// Marquee around everything selects both segments (mixed configs).
		await page.locator('body').press('Escape');
		await expect(panel).not.toBeVisible();

		const allStart = toScreen(-250, -60);
		const allEnd = toScreen(250, 60);
		await page.mouse.move(allStart.x, allStart.y);
		await page.mouse.down();
		await page.mouse.move(allEnd.x, allEnd.y);
		await page.mouse.up();

		await expect(panel.getByText('Editing 2 segments')).toBeVisible();
		await expect(panel.getByText('different lane configurations')).toBeVisible();

		// Delete removes the whole marquee selection.
		await page.locator('body').press('Delete');
		const saved = await page.evaluate((key) => {
			const data = localStorage.getItem(key);
			return data ? JSON.parse(data) : null;
		}, STORAGE_KEY);
		expect(saved.nodes).toHaveLength(0);
		expect(saved.segments).toHaveLength(0);
	});
});
