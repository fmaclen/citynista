import { expect, test } from '@playwright/test';

// A loaded fixture lands in the current city of the localStorage city library.
const CURRENT_KEY = 'citynista:current-city';

test.describe('Fixtures', () => {
	test('booting with ?fixture= loads the shared graph', async ({ page }) => {
		await page.goto('/?fixture=_median-corner&topdown');
		await expect(page.locator('canvas')).toBeVisible();

		await page.waitForFunction(
			(key) => {
				const id = localStorage.getItem(key);
				if (!id) return false;
				const raw = localStorage.getItem('citynista:city:' + id);
				if (!raw) return false;
				const graph = JSON.parse(raw).graph;
				return graph?.nodes?.length === 3 && graph?.segments?.length === 2;
			},
			CURRENT_KEY,
			{ timeout: 5000 }
		);

		const graph = await page.evaluate((key) => {
			const id = localStorage.getItem(key)!;
			return JSON.parse(localStorage.getItem('citynista:city:' + id)!).graph;
		}, CURRENT_KEY);
		const corner = graph.nodes.find((node: { id: string }) => node.id === 'node-1');
		expect(corner).toEqual({ id: 'node-1', x: 0, y: 0 });
		expect(graph.segments[0].lanes.length).toBeGreaterThan(0);
	});
});
