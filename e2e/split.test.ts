import { expect, test, type Page } from '@playwright/test';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { openGraph, liveGraph, toScreen } from './app';

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
			lanes: createLanesFrom('street')
		}
	]
};

const enterSplitMode = (page: Page) =>
	page.getByTitle('Split (click a road to cut it at that point)').click();

test.describe('Split tool', () => {
	test.beforeEach(async ({ page }) => {
		await openGraph(page, GRAPH_DATA);
	});

	test('clicking a road cuts it into two segments at that point', async ({ page }) => {
		await enterSplitMode(page);
		await page.locator('canvas').click({ position: toScreen(20, 0) });

		await expect.poll(async () => (await liveGraph(page)).nodes.length).toBe(3);

		const graph = await liveGraph(page);
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
		expect((await liveGraph(page)).segments.length).toBe(1);
	});
});
