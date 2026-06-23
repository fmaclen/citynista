import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'citynista-graph-v2';

test.describe('Fixtures', () => {
	test('booting with ?fixture= loads the shared graph', async ({ page }) => {
		await page.goto('/?fixture=_median-corner&topdown');
		await expect(page.locator('canvas')).toBeVisible();

		await page.waitForFunction(
			(key) => {
				const raw = localStorage.getItem(key);
				if (!raw) return false;
				const data = JSON.parse(raw);
				return data.nodes?.length === 3 && data.segments?.length === 2;
			},
			STORAGE_KEY,
			{ timeout: 5000 }
		);

		const graph = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), STORAGE_KEY);
		const corner = graph.nodes.find((node: { id: string }) => node.id === 'node-1');
		expect(corner).toEqual({ id: 'node-1', x: 0, y: 0 });
		expect(graph.segments[0].lanes.length).toBeGreaterThan(0);
	});
});
