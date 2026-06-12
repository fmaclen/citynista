import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'citynista-graph-v2';

test.describe('Undo/redo', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);
		await page.reload();
		await expect(page.locator('canvas')).toBeVisible();
	});

	const savedGraph = (page: import('@playwright/test').Page) =>
		page.evaluate((key) => {
			const data = localStorage.getItem(key);
			return data ? JSON.parse(data) : null;
		}, STORAGE_KEY);

	test('undo and redo step through drawn segments', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await canvas.click({ position: { x: 200, y: 300 }, force: true });
		await canvas.click({ position: { x: 400, y: 300 }, force: true });
		await canvas.click({ position: { x: 600, y: 300 }, force: true });
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');

		expect((await savedGraph(page)).segments.length).toBe(2);

		await page.keyboard.press('ControlOrMeta+z');
		expect((await savedGraph(page)).segments.length).toBe(1);

		await page.keyboard.press('ControlOrMeta+z');
		expect((await savedGraph(page)).segments.length).toBe(0);

		await page.keyboard.press('ControlOrMeta+Shift+z');
		await page.keyboard.press('ControlOrMeta+Shift+z');
		expect((await savedGraph(page)).segments.length).toBe(2);
	});

	test('a node drag is one undo step', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await canvas.click({ position: { x: 300, y: 300 }, force: true });
		await canvas.click({ position: { x: 500, y: 300 }, force: true });
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await expect(page.getByTitle('Select')).toHaveAttribute('aria-pressed', 'true');

		const before = await savedGraph(page);

		// Select and drag the end node in several increments.
		await canvas.click({ position: { x: 500, y: 300 }, force: true });
		await page.mouse.move(500, 300);
		await page.mouse.down();
		await page.mouse.move(560, 340, { steps: 6 });
		await page.mouse.up();

		const moved = await savedGraph(page);
		expect(moved).not.toEqual(before);

		// One undo restores the original positions despite the many
		// intermediate mousemoves.
		await page.keyboard.press('ControlOrMeta+z');
		expect(await savedGraph(page)).toEqual(before);
	});

	test('undo buttons reflect history state', async ({ page }) => {
		const undoButton = page.getByTitle('Undo (⌘Z)');
		const redoButton = page.getByTitle('Redo (⇧⌘Z)');
		await expect(undoButton).toBeDisabled();
		await expect(redoButton).toBeDisabled();

		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await canvas.click({ position: { x: 200, y: 300 }, force: true });
		await canvas.click({ position: { x: 400, y: 300 }, force: true });
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');

		await expect(undoButton).toBeEnabled();
		await undoButton.click();
		await expect(redoButton).toBeEnabled();

		await redoButton.click();
		expect((await savedGraph(page)).segments.length).toBe(1);
	});
});
