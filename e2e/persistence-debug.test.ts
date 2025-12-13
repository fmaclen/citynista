import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'citynista-graph-v2';

test.describe('Persistence Debug', () => {
	test('data persists and renders after page reload', async ({ page }) => {
		// Collect console logs
		const consoleLogs: string[] = [];
		page.on('console', (msg) => {
			consoleLogs.push(`${msg.type()}: ${msg.text()}`);
		});

		// Clear storage and go to page
		await page.goto('/');
		await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);
		await page.reload();

		// Wait for the canvas to be ready
		const canvas = page.locator('canvas');
		await expect(canvas).toBeVisible();

		// Enter draw mode - first button
		await page.locator('button').first().click();

		// Draw some segments
		await canvas.click({ position: { x: 200, y: 200 }, force: true });
		await canvas.click({ position: { x: 300, y: 300 }, force: true });
		await canvas.click({ position: { x: 400, y: 250 }, force: true });
		await page.keyboard.press('Escape');

		// Verify data was saved
		const savedData = await page.evaluate((key) => {
			const data = localStorage.getItem(key);
			return data ? JSON.parse(data) : null;
		}, STORAGE_KEY);

		console.log('Saved data:', JSON.stringify(savedData, null, 2));
		expect(savedData).not.toBeNull();
		expect(savedData.nodes.length).toBe(3);
		expect(savedData.segments.length).toBe(2);

		// Take screenshot before reload
		await page.screenshot({ path: 'e2e/screenshots/before-reload.png' });

		// Clear logs before reload
		consoleLogs.length = 0;

		// Reload the page
		await page.reload();

		// Wait a tick for logs to come through
		await expect(page.locator('body')).toBeVisible();

		// Log console output for debugging (before assertion so we see it on failure)
		console.log('Console logs after reload:', consoleLogs);

		// Wait for canvas to appear after reload
		const canvasAfterReload = page.locator('canvas');
		await expect(canvasAfterReload).toBeVisible();

		// Take screenshot after reload
		await page.screenshot({ path: 'e2e/screenshots/after-reload.png' });

		// Verify data is still in localStorage
		const loadedData = await page.evaluate((key) => {
			const data = localStorage.getItem(key);
			return data ? JSON.parse(data) : null;
		}, STORAGE_KEY);

		expect(loadedData).toEqual(savedData);
	});
});
