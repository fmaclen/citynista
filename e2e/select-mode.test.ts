import { expect, test } from '@playwright/test';

test.describe('Select Mode', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await page.evaluate(() => localStorage.clear());
	});

	test('can select and move a segment', async ({ page }) => {
		await page.goto('/');

		const canvas = page.locator('canvas#canvas');

		await page.locator('button').first().click();
		await canvas.click({ position: { x: 100, y: 100 }, force: true });
		await canvas.click({ position: { x: 200, y: 200 }, force: true });
		await page.keyboard.press('Escape');

		await page.locator('button').nth(1).click();

		await canvas.click({ position: { x: 150, y: 150 }, force: true });

		const canvasBox = await canvas.boundingBox();
		if (!canvasBox) throw new Error('Canvas not found');

		await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
		await page.mouse.down();
		await page.mouse.move(canvasBox.x + 150, canvasBox.y + 150);
		await page.mouse.up();

		await page.waitForTimeout(200);

		const finalData = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		const finalNode1 = finalData.nodes[0];

		expect(finalNode1.x).toBeCloseTo(150, 0);
		expect(finalNode1.y).toBeCloseTo(150, 0);
	});

	test('can delete a segment', async ({ page }) => {
		await page.goto('/');

		const canvas = page.locator('canvas#canvas');

		await page.locator('button').first().click();
		await canvas.click({ position: { x: 100, y: 100 }, force: true });
		await canvas.click({ position: { x: 200, y: 200 }, force: true });
		await page.keyboard.press('Escape');

		await page.locator('button').nth(1).click();

		await canvas.click({ position: { x: 150, y: 150 }, force: true });

		await page.keyboard.press('Delete');

		await page.waitForTimeout(100);

		const savedData = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		expect(savedData.nodes).toHaveLength(0);
		expect(savedData.segments).toHaveLength(0);
	});

	test('escape key clears selection', async ({ page }) => {
		await page.goto('/');

		const canvas = page.locator('canvas#canvas');
		const selectButton = page.locator('button').nth(1);

		await page.locator('button').first().click();
		await canvas.click({ position: { x: 100, y: 100 }, force: true });
		await canvas.click({ position: { x: 200, y: 200 }, force: true });
		await page.keyboard.press('Escape');

		const canvasBox = await canvas.boundingBox();
		if (!canvasBox) throw new Error('Canvas not found');

		await selectButton.click();
		await canvas.click({ position: { x: 150, y: 150 }, force: true });

		await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
		await page.mouse.down();
		await page.mouse.move(canvasBox.x + 120, canvasBox.y + 120);
		await page.mouse.up();

		let data = await page.evaluate(() => {
			const d = localStorage.getItem('citynista-graph');
			return d ? JSON.parse(d) : null;
		});
		expect(data.nodes[0].x).toBeCloseTo(120, 0);

		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');

		await expect(selectButton).not.toHaveClass(/bg-primary/);

		await page.mouse.move(canvasBox.x + 120, canvasBox.y + 120);
		await page.mouse.down();
		await page.mouse.move(canvasBox.x + 140, canvasBox.y + 140);
		await page.mouse.up();

		data = await page.evaluate(() => {
			const d = localStorage.getItem('citynista-graph');
			return d ? JSON.parse(d) : null;
		});
		expect(data.nodes[0].x).toBeCloseTo(120, 0);
		expect(data.nodes[0].y).toBeCloseTo(120, 0);

		await selectButton.click();
		await expect(selectButton).toHaveClass(/bg-primary/);

		await page.mouse.move(canvasBox.x + 120, canvasBox.y + 120);
		await page.mouse.down();
		await page.mouse.move(canvasBox.x + 160, canvasBox.y + 160);
		await page.mouse.up();

		data = await page.evaluate(() => {
			const d = localStorage.getItem('citynista-graph');
			return d ? JSON.parse(d) : null;
		});
		expect(data.nodes[0].x).toBeCloseTo(160, 0);
		expect(data.nodes[0].y).toBeCloseTo(160, 0);
	});
});
