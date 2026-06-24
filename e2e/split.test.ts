import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'citynista-graph-v2';
const SCALE = 720 / 500;
const toScreen = (x: number, y: number) => ({ x: 640 + x * SCALE, y: 360 + y * SCALE });

const GRAPH_DATA = {
	nodes: [
		{ id: 'node-0', x: -100, y: 0 },
		{ id: 'node-1', x: 100, y: 0 }
	],
	segments: [
		{
			id: 'segment-0',
			startNodeId: 'node-0',
			endNodeId: 'node-1',
			lanes: [
				{ type: 'sidewalk', width: 2, direction: 'bidirectional' },
				{ type: 'road', width: 3, direction: 'backward' },
				{ type: 'road', width: 3, direction: 'forward' },
				{ type: 'sidewalk', width: 2, direction: 'bidirectional' }
			]
		}
	]
};

interface SavedGraph {
	nodes: { id: string; x: number; y: number }[];
	segments: { id: string; startNodeId: string; endNodeId: string; lanes: unknown[] }[];
}

const savedGraph = (page: import('@playwright/test').Page) =>
	page.evaluate((key) => {
		const data = localStorage.getItem(key);
		return data ? (JSON.parse(data) as SavedGraph) : null;
	}, STORAGE_KEY);

const enterSplitMode = (page: import('@playwright/test').Page) =>
	page.getByTitle('Split (click a road to cut it at that point)').click();

test.describe('Split tool', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/?topdown');
		await expect(page.locator('canvas')).toBeVisible();
		await page.evaluate(({ key, data }) => localStorage.setItem(key, JSON.stringify(data)), {
			key: STORAGE_KEY,
			data: GRAPH_DATA
		});
		await page.reload();
		await expect(page.locator('nav')).toBeVisible();
	});

	test('clicking a road cuts it into two segments at that point', async ({ page }) => {
		await enterSplitMode(page);
		await page.locator('canvas').click({ position: toScreen(20, 0) });

		await expect.poll(async () => (await savedGraph(page))?.nodes.length).toBe(3);

		const graph = (await savedGraph(page))!;
		expect(graph.segments.length).toBe(2);

		const newNode = graph.nodes.find((node) => node.id !== 'node-0' && node.id !== 'node-1')!;
		expect(Math.abs(newNode.x - 20)).toBeLessThan(8);
		expect(Math.abs(newNode.y)).toBeLessThan(8);

		// Both halves keep the original four-lane cross-section.
		for (const segment of graph.segments) {
			expect(segment.lanes.length).toBe(4);
		}
	});

	test('Escape exits split mode back to select', async ({ page }) => {
		await enterSplitMode(page);
		await page.keyboard.press('Escape');

		// Back in select mode a click selects the road (opening the lane panel)
		// instead of cutting it.
		await page.locator('canvas').click({ position: toScreen(20, 0) });
		await expect(page.locator('aside')).toBeVisible();
		expect((await savedGraph(page))?.segments.length).toBe(1);
	});
});
