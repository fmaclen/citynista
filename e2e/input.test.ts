import { expect, test } from '@playwright/test';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { openGraph, liveGraph, toScreen } from './app';
import { nodeOf } from '../unit/model';

test.describe('Drags that end off the canvas', () => {
	test('a curvature drag released over the toolbar ends there', async ({ page }) => {
		await openGraph(page, {
			nodes: [
				{ id: 'a', x: -200, y: 0 },
				{ id: 'b', x: 200, y: 0 }
			],
			segments: [{ id: 's', startNodeId: 'a', endNodeId: 'b', lanes: createLanesFrom('street') }]
		});
		const mid = toScreen(0, 0);
		await page.mouse.click(mid.x, mid.y);
		await expect(page.locator('aside')).toBeVisible();

		// Drag the handle down and let go over the toolbar.
		const toolbar = await page.locator('nav').boundingBox();
		await page.mouse.move(mid.x, mid.y);
		await page.mouse.down();
		await page.mouse.move(mid.x, mid.y + 100, { steps: 5 });
		await page.mouse.move(mid.x, toolbar!.y + toolbar!.height / 2, { steps: 5 });
		await page.mouse.up();
		const released = (await liveGraph(page)).segments[0];
		expect(released.controlY).toBeDefined();

		// Moving over the canvas afterwards must not keep bending the road.
		await page.mouse.move(mid.x + 200, mid.y - 200, { steps: 5 });
		const after = (await liveGraph(page)).segments[0];
		expect(after.controlX).toBe(released.controlX);
		expect(after.controlY).toBe(released.controlY);
	});

	test('a click where the lane panel then opens leaves nothing stuck to the cursor', async ({
		page
	}) => {
		// A road under the top-right corner, where the lane panel docks.
		await openGraph(page, {
			nodes: [
				{ id: 'a', x: 150, y: -150 },
				{ id: 'b', x: 250, y: -150 }
			],
			segments: [{ id: 's', startNodeId: 'a', endNodeId: 'b', lanes: createLanesFrom('street') }]
		});
		const on = toScreen(200, -150);
		await page.mouse.click(on.x, on.y);
		const panel = await page.locator('aside').boundingBox();
		expect(on.x).toBeGreaterThan(panel!.x);
		expect(on.y).toBeLessThan(panel!.y + panel!.height);

		await page.mouse.move(400, 500, { steps: 5 });
		const graph = await liveGraph(page);
		expect(nodeOf(graph, 'a')).toMatchObject({ x: 150, y: -150 });
		expect(nodeOf(graph, 'b')).toMatchObject({ x: 250, y: -150 });
	});
});
