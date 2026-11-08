import { expect, test, type Page } from '@playwright/test';
import { saveCity } from './save';

const STORAGE_KEY = 'citynista-graph-v2';
const SCALE = 720 / 500;
const toScreen = (x: number, y: number) => ({ x: 640 + x * SCALE, y: 360 + y * SCALE });

async function seed(page: Page, data: unknown) {
	await page.goto('/?topdown');
	await expect(page.locator('canvas')).toBeVisible();
	await page.evaluate(({ key, data }) => localStorage.setItem(key, JSON.stringify(data)), {
		key: STORAGE_KEY,
		data
	});
	await page.reload();
	await expect(page.locator('nav')).toBeVisible();
}

const savedGraph = async (page: Page) => {
	await saveCity(page);
	return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), STORAGE_KEY);
};

test.describe('Drags that end off the canvas', () => {
	test('a curvature drag released over the toolbar ends there', async ({ page }) => {
		await seed(page, {
			nodes: [
				{ id: 'a', x: -200, y: 0 },
				{ id: 'b', x: 200, y: 0 }
			],
			segments: [{ id: 's', startNodeId: 'a', endNodeId: 'b', laneTemplateId: 'street' }]
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
		const released = (await savedGraph(page)).segments[0];

		// Moving over the canvas afterwards must not keep bending the road.
		await page.mouse.move(mid.x + 200, mid.y - 200, { steps: 5 });
		const after = (await savedGraph(page)).segments[0];
		expect(after.controlX).toBe(released.controlX);
		expect(after.controlY).toBe(released.controlY);
	});

	test('a click where the lane panel then opens leaves nothing stuck to the cursor', async ({
		page
	}) => {
		// A road under the top-right corner, where the lane panel docks.
		await seed(page, {
			nodes: [
				{ id: 'a', x: 150, y: -150 },
				{ id: 'b', x: 250, y: -150 }
			],
			segments: [{ id: 's', startNodeId: 'a', endNodeId: 'b', laneTemplateId: 'street' }]
		});
		const on = toScreen(200, -150);
		await page.mouse.click(on.x, on.y);
		const panel = await page.locator('aside').boundingBox();
		expect(on.x).toBeGreaterThan(panel!.x);
		expect(on.y).toBeLessThan(panel!.y + panel!.height);

		await page.mouse.move(400, 500, { steps: 5 });
		const nodes = (await savedGraph(page)).nodes;
		expect(nodes.find((n: { id: string }) => n.id === 'a')).toMatchObject({ x: 150, y: -150 });
		expect(nodes.find((n: { id: string }) => n.id === 'b')).toMatchObject({ x: 250, y: -150 });
	});
});
