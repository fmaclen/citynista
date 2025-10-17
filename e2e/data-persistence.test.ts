import { expect, test } from '@playwright/test';

test.describe('Data Persistence', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await page.evaluate(() => localStorage.clear());
	});

	test('can clear all', async ({ page }) => {
		await page.goto('/');

		const canvas = page.locator('canvas#canvas');

		await page.locator('button').first().click();
		await canvas.click({ position: { x: 100, y: 100 }, force: true });
		await canvas.click({ position: { x: 200, y: 200 }, force: true });
		await canvas.click({ position: { x: 300, y: 100 }, force: true });
		await page.keyboard.press('Escape');

		let savedData = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		expect(savedData.nodes.length).toBeGreaterThan(0);
		expect(savedData.segments.length).toBeGreaterThan(0);

		await page.locator('button').nth(2).click();

		await page.waitForTimeout(100);

		savedData = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		expect(savedData.nodes).toHaveLength(0);
		expect(savedData.segments).toHaveLength(0);
	});

	test('data persists across page reloads', async ({ page }) => {
		await page.goto('/');

		const canvas = page.locator('canvas#canvas');

		await page.locator('button').first().click();
		await canvas.click({ position: { x: 100, y: 100 }, force: true });
		await canvas.click({ position: { x: 200, y: 200 }, force: true });

		await page.waitForTimeout(100);

		const savedData = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		await page.reload();

		const loadedData = await page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph');
			return data ? JSON.parse(data) : null;
		});

		expect(loadedData).toEqual(savedData);
		expect(loadedData.nodes).toHaveLength(2);
		expect(loadedData.segments).toHaveLength(1);
	});
});
