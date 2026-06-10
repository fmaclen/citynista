import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'citynista-graph-v2';
const baseNetwork = JSON.parse(
	readFileSync(new URL('./fixtures/base-network.json', import.meta.url), 'utf-8')
);

test.describe('Visual Regression', () => {
	test('base network renders like the baseline', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('canvas')).toBeVisible();

		await page.evaluate(
			({ key, data }) => {
				localStorage.setItem(key, JSON.stringify(data));
			},
			{ key: STORAGE_KEY, data: baseNetwork }
		);

		await page.reload();
		await expect(page.locator('canvas')).toBeVisible();
		await expect(page.locator('nav')).toBeVisible();

		// Hide the toolbar and FPS counter: they paint over the canvas, and the
		// FPS text resizes its box between runs, so masking it isn't stable.
		await page.locator('nav').evaluate((el) => (el.style.display = 'none'));
		await page.getByText('FPS').evaluate((el) => (el.style.display = 'none'));

		await expect(page.locator('canvas')).toHaveScreenshot('base-network.png');
	});
});
