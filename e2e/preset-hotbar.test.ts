import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'citynista-graph-v2';

test.describe('Preset Hotbar', () => {
	test('picking a preset enters draw mode, escape returns to select', async ({ page }) => {
		await page.goto('/?topdown');
		await expect(page.locator('canvas')).toBeVisible();
		await expect(page.locator('nav')).toBeVisible();

		const select = page.getByTitle('Select');
		const street = page.getByRole('button', { name: 'Street' });
		const avenue = page.getByRole('button', { name: 'Avenue' });
		const highway = page.getByRole('button', { name: 'Highway' });

		// Select is the default tool; no preset is active yet.
		await expect(select).toHaveAttribute('aria-pressed', 'true');
		await expect(street).toHaveAttribute('aria-pressed', 'false');

		// Clicking a preset activates it and switches to draw mode.
		await avenue.click();
		await expect(avenue).toHaveAttribute('aria-pressed', 'true');
		await expect(select).toHaveAttribute('aria-pressed', 'false');

		await page.locator('body').press('3');
		await expect(highway).toHaveAttribute('aria-pressed', 'true');
		await expect(avenue).toHaveAttribute('aria-pressed', 'false');

		// Draw a segment with the highway preset active.
		await page.locator('canvas').click({ position: { x: 450, y: 300 } });
		await page.locator('canvas').click({ position: { x: 800, y: 420 } });

		const segments = await page.evaluate((key) => {
			const data = localStorage.getItem(key);
			return data ? JSON.parse(data).segments : null;
		}, STORAGE_KEY);

		expect(segments).toHaveLength(1);
		// Highway: 3 road lanes, median, 3 road lanes.
		expect(segments[0].lanes).toHaveLength(7);
		expect(segments[0].lanes.map((lane: { type: string }) => lane.type)).toEqual([
			'road',
			'road',
			'road',
			'median',
			'road',
			'road',
			'road'
		]);

		// Escape once cancels the pending segment, twice leaves draw mode.
		await page.locator('body').press('Escape');
		await expect(highway).toHaveAttribute('aria-pressed', 'true');
		await page.locator('body').press('Escape');
		await expect(select).toHaveAttribute('aria-pressed', 'true');
		await expect(highway).toHaveAttribute('aria-pressed', 'false');
	});
});
