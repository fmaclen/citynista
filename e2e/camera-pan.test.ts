import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'citynista-graph-v2';

const GRAPH_DATA = {
	nodes: [
		{ id: 'node-0', x: -100, y: 0 },
		{ id: 'node-1', x: 100, y: 0 }
	],
	segments: [
		{ id: 'segment-0', startNodeId: 'node-0', endNodeId: 'node-1', laneTemplateId: 'street' }
	]
};

test.describe('Camera Pan', () => {
	test('space+drag pans the camera without selecting', async ({ page }) => {
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

		// Hold space and drag 400px to the right; the world shifts with the drag.
		await page.keyboard.down('Space');
		await expect(page.locator('canvas')).toHaveCSS('cursor', 'grab');
		await page.mouse.move(400, 300);
		await page.mouse.down();
		await page.mouse.move(800, 300);
		await page.mouse.up();
		await page.keyboard.up('Space');
		await expect(page.locator('canvas')).toHaveCSS('cursor', 'default');

		// The segment used to be under the canvas center; it isn't anymore, and
		// the panning drag itself must not have selected anything.
		await page.locator('canvas').click({ position: { x: 640, y: 360 } });
		await expect(page.locator('aside')).not.toBeVisible();

		// It now sits 400px further right.
		await page.locator('canvas').click({ position: { x: 1040, y: 360 } });
		await expect(page.locator('aside')).toBeVisible();
	});
});
