import { expect, test } from '@playwright/test';
import { expectSelectMode, openEditor, liveGraph } from './app';

test.describe('Undo/redo', () => {
	test.beforeEach(async ({ page }) => {
		await openEditor(page);
	});

	test('undo and redo step through drawn segments', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await canvas.click({ position: { x: 200, y: 300 }, force: true });
		await canvas.click({ position: { x: 400, y: 300 }, force: true });
		await canvas.click({ position: { x: 600, y: 300 }, force: true });
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');

		expect((await liveGraph(page)).segments.length).toBe(2);

		await page.keyboard.press('ControlOrMeta+z');
		expect((await liveGraph(page)).segments.length).toBe(1);

		await page.keyboard.press('ControlOrMeta+z');
		expect((await liveGraph(page)).segments.length).toBe(0);

		await page.keyboard.press('ControlOrMeta+Shift+z');
		await page.keyboard.press('ControlOrMeta+Shift+z');
		expect((await liveGraph(page)).segments.length).toBe(2);
	});

	test('a node drag is one undo step', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await canvas.click({ position: { x: 300, y: 300 }, force: true });
		await canvas.click({ position: { x: 500, y: 300 }, force: true });
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await expectSelectMode(page);

		const before = await liveGraph(page);

		// Select and drag the end node in several increments.
		await canvas.click({ position: { x: 500, y: 300 }, force: true });
		await page.mouse.move(500, 300);
		await page.mouse.down();
		await page.mouse.move(560, 340, { steps: 6 });
		await page.mouse.up();

		const moved = await liveGraph(page);
		expect(moved).not.toEqual(before);

		// One undo restores the original positions despite the many
		// intermediate mousemoves.
		await page.keyboard.press('ControlOrMeta+z');
		expect(await liveGraph(page)).toEqual(before);
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
		expect((await liveGraph(page)).segments.length).toBe(1);
	});
});

test.describe('Bulldoze', () => {
	test.beforeEach(async ({ page }) => {
		await openEditor(page);
	});

	test('click demolishes a segment, marquee demolishes an area, undo restores', async ({
		page
	}) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await canvas.click({ position: { x: 200, y: 300 }, force: true });
		await canvas.click({ position: { x: 400, y: 300 }, force: true });
		await canvas.click({ position: { x: 600, y: 300 }, force: true });
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');

		expect((await liveGraph(page)).segments.length).toBe(2);

		await page.getByTitle('Bulldoze (click or drag to demolish)').click();

		// Click the middle of the first segment: that segment dies, the rest
		// survives.
		await canvas.click({ position: { x: 300, y: 300 }, force: true });
		expect((await liveGraph(page)).segments.length).toBe(1);

		// Red marquee over everything left.
		await page.mouse.move(150, 200);
		await page.mouse.down();
		await page.mouse.move(700, 420, { steps: 4 });
		await page.mouse.up();
		expect((await liveGraph(page)).segments.length).toBe(0);
		expect((await liveGraph(page)).nodes.length).toBe(0);

		// Both demolitions are plain undo steps.
		await page.keyboard.press('ControlOrMeta+z');
		await page.keyboard.press('ControlOrMeta+z');
		expect((await liveGraph(page)).segments.length).toBe(2);

		// Escape leaves bulldoze mode even right after clicking the toolbar
		// button (which must not keep focus).
		await page.keyboard.press('Escape');
		await expectSelectMode(page);
	});
});
