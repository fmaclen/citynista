import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'citynista-graph-v2';

test.describe('Persistence', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);
		await page.reload();
		await expect(page.locator('canvas')).toBeVisible();
	});

	test('data persists and renders after page reload', async ({ page }) => {
		const canvas = page.locator('canvas');

		// Picking a preset enters draw mode
		await page.getByRole('button', { name: 'Street' }).click();

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

		expect(savedData).not.toBeNull();
		expect(savedData.nodes.length).toBe(3);
		expect(savedData.segments.length).toBe(2);

		// Reload the page
		await page.reload();

		// Wait for canvas to appear after reload
		await expect(page.locator('canvas')).toBeVisible();

		// Verify data is still in localStorage
		const loadedData = await page.evaluate((key) => {
			const data = localStorage.getItem(key);
			return data ? JSON.parse(data) : null;
		}, STORAGE_KEY);

		expect(loadedData).toEqual(savedData);
	});

	test('bezier control point curves segment without breaking it', async ({ page }) => {
		const canvas = page.locator('canvas');

		// Picking a preset enters draw mode
		await page.getByRole('button', { name: 'Street' }).click();

		// Draw a horizontal segment in the middle of the canvas
		await canvas.click({ position: { x: 200, y: 300 }, force: true });
		await canvas.click({ position: { x: 500, y: 300 }, force: true });

		// First escape cancels the pending segment, second returns to select mode
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await expect(page.getByTitle('Select')).toHaveAttribute('aria-pressed', 'true');

		// Click on the segment to select it (middle point)
		await canvas.click({ position: { x: 350, y: 300 }, force: true });

		// Verify segment is selected - check localStorage
		const beforeCurve = await page.evaluate((key) => {
			const data = localStorage.getItem(key);
			return data ? JSON.parse(data) : null;
		}, STORAGE_KEY);

		expect(beforeCurve.segments.length).toBe(1);

		// The control point (red circle) should now be visible at the center of the segment
		// Drag it upward to curve the segment
		await page.mouse.move(350, 300);
		await page.mouse.down();
		await page.mouse.move(350, 150);
		await page.mouse.up();

		// Verify the segment still exists and has control point
		const afterCurve = await page.evaluate((key) => {
			const data = localStorage.getItem(key);
			return data ? JSON.parse(data) : null;
		}, STORAGE_KEY);

		expect(afterCurve.segments.length).toBe(1);

		// Control point should now be set (segment was curved)
		expect(afterCurve.segments[0].controlX).toBeDefined();
		expect(afterCurve.segments[0].controlY).toBeDefined();

		// Reload the page to verify the curved segment persists and renders
		await page.reload();
		await expect(page.locator('canvas')).toBeVisible();

		// Verify data still exists
		const afterReload = await page.evaluate((key) => {
			const data = localStorage.getItem(key);
			return data ? JSON.parse(data) : null;
		}, STORAGE_KEY);

		expect(afterReload.segments[0].controlX).toBe(afterCurve.segments[0].controlX);
		expect(afterReload.segments[0].controlY).toBe(afterCurve.segments[0].controlY);
	});
});
