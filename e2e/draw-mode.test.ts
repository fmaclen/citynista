import { expect, test } from '@playwright/test';

test.describe('Draw Mode', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await page.evaluate(() => localStorage.clear());
	});

	test('can enter and exit draw mode', async ({ page }) => {
		await page.goto('/');

		const drawButton = page.locator('button').first();
		await drawButton.click();

		await expect(drawButton).toHaveClass(/bg-primary/);

		await page.keyboard.press('Escape');

		await expect(drawButton).not.toHaveClass(/bg-primary/);
	});

	test('can draw a segment', async ({ page }) => {
		await page.goto('/');

		const canvas = page.locator('canvas#canvas');

		await page.locator('button').first().click();

		await canvas.click({
			position: { x: 100, y: 100 },
			force: true
		});

		await canvas.click({
			position: { x: 200, y: 200 },
			force: true
		});

		await page.waitForTimeout(100);

		const savedData = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		expect(savedData).not.toBeNull();
		expect(savedData.nodes).toHaveLength(2);
		expect(savedData.segments).toHaveLength(1);
	});
});
