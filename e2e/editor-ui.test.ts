import { expect, test } from '@playwright/test';

test.describe('Editor UI', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await page.evaluate(() => localStorage.clear());
	});

	test('page loads with canvas', async ({ page }) => {
		await page.goto('/');
		const canvas = page.locator('canvas#canvas');
		await expect(canvas).toBeVisible();
	});

	test('toolbar buttons are visible', async ({ page }) => {
		await page.goto('/');

		const toolbar = page.locator('nav');
		await expect(toolbar).toBeVisible();

		const buttons = toolbar.locator('button');
		await expect(buttons).toHaveCount(3);
	});
});
