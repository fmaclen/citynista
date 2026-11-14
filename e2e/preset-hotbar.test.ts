import { expect, test } from '@playwright/test';
import { expectSelectMode, openEditor, saveCity, liveGraph } from './app';

test.describe('Preset Hotbar', () => {
	test('picking a preset enters draw mode, escape returns to select', async ({ page }) => {
		await openEditor(page);

		const street = page.getByRole('button', { name: 'Street' });
		const avenue = page.getByRole('button', { name: 'Avenue' });
		const highway = page.getByRole('button', { name: 'Highway' });

		// Select is the default tool; no preset is active yet.
		await expectSelectMode(page);
		await expect(street).toHaveAttribute('aria-pressed', 'false');

		// Clicking a preset activates it and switches to draw mode.
		await avenue.click();
		await expect(avenue).toHaveAttribute('aria-pressed', 'true');

		await page.locator('body').press('3');
		await expect(highway).toHaveAttribute('aria-pressed', 'true');
		await expect(avenue).toHaveAttribute('aria-pressed', 'false');

		// Draw a segment with the highway preset active.
		await page.locator('canvas').click({ position: { x: 450, y: 300 } });
		await page.locator('canvas').click({ position: { x: 760, y: 420 } });

		const { segments } = await liveGraph(page);

		expect(segments).toHaveLength(1);
		// Highway: 3 asphalt lanes, raised concrete median, 3 asphalt lanes.
		expect(segments[0].lanes).toHaveLength(7);
		expect(segments[0].lanes.map((lane) => lane.material)).toEqual([
			'asphalt',
			'asphalt',
			'asphalt',
			'concrete',
			'asphalt',
			'asphalt',
			'asphalt'
		]);
		// A concrete buffer lane is what renders as a raised median.
		expect(segments[0].lanes[3].role).toBe('buffer');

		// Escape once cancels the pending segment, twice leaves draw mode.
		await page.locator('body').press('Escape');
		await expect(highway).toHaveAttribute('aria-pressed', 'true');
		await page.locator('body').press('Escape');
		await expectSelectMode(page);
		await expect(highway).toHaveAttribute('aria-pressed', 'false');
	});

	test('Delete empties the armed slot; slot changes survive a reload', async ({ page }) => {
		await openEditor(page);
		const nav = page.locator('nav');

		await nav.getByRole('button', { name: 'Path' }).click();
		await page.locator('body').press('Delete');
		await expect(nav.getByRole('button', { name: 'Empty slot 4' })).toBeVisible();
		await expectSelectMode(page);

		// Draw a street, select it, and drop its lanes into an empty slot.
		await nav.getByRole('button', { name: 'Street' }).click();
		await page.locator('canvas').click({ position: { x: 450, y: 360 } });
		await page.locator('canvas').click({ position: { x: 760, y: 360 } });
		await page.locator('body').press('Escape');
		await page.locator('body').press('Escape');
		await page.locator('canvas').click({ position: { x: 600, y: 360 } });
		await expect(page.locator('aside')).toBeVisible();
		await nav.getByRole('button', { name: 'Empty slot 6' }).click();
		await expect(nav.getByRole('button', { name: 'Custom road' })).toBeVisible();

		await saveCity(page);
		await page.reload();
		await expect(nav.getByRole('button', { name: 'Empty slot 4' })).toBeVisible();
		await expect(nav.getByRole('button', { name: 'Custom road' })).toBeVisible();
	});

	test('an empty slot opens the lane panel; it draws only once it has lanes', async ({ page }) => {
		await openEditor(page);
		const nav = page.locator('nav');
		const panel = page.locator('aside');
		const canvas = page.locator('canvas');
		const slot = nav.getByRole('button', { name: 'Empty slot 6' });

		await slot.click();
		await expect(slot).toHaveAttribute('aria-pressed', 'true');
		// The same panel as any other, with no rows above its Add lane button.
		await expect(panel.getByText('Lane editor', { exact: true })).toBeVisible();
		const addLane = panel.getByRole('button', { name: 'Add lane' });
		await expect(addLane).toBeVisible();
		await expect(panel.getByText('No lanes yet')).toHaveCount(0);
		await expect(panel.locator('input[type="number"]')).toHaveCount(0);
		await page.screenshot({ path: 'test-results/preset-panel-empty.png' });

		// Armed but empty: clicks on the map draw nothing.
		await canvas.click({ position: { x: 450, y: 360 } });
		await canvas.click({ position: { x: 760, y: 360 } });
		expect((await liveGraph(page)).segments).toEqual([]);

		// Add lane stays under the rows and appends each time.
		await addLane.click();
		await addLane.click();
		const widths = panel.locator('input[type="number"]');
		await widths.first().fill('5');
		await widths.first().press('Tab');
		await expect(panel.getByText('8.5m total')).toBeVisible();
		await page.screenshot({ path: 'test-results/preset-panel.png' });

		await canvas.click({ position: { x: 450, y: 360 } });
		await canvas.click({ position: { x: 760, y: 360 } });
		const { segments } = await liveGraph(page);
		expect(segments).toHaveLength(1);
		expect(segments[0].lanes.map((l) => l.width)).toEqual([5, 3.5]);

		// The preset itself survives a reload, the unsaved road discarded.
		page.once('dialog', (dialog) => dialog.accept());
		await page.reload();
		await nav.getByRole('button', { name: 'Custom road' }).click();
		await expect(panel.locator('input[type="number"]').first()).toHaveValue('5');
	});

	test('I copies the road under the cursor into the first empty slot and draws with it', async ({
		page
	}) => {
		await openEditor(page);
		const nav = page.locator('nav');
		const canvas = page.locator('canvas');

		await nav.getByRole('button', { name: 'Highway' }).click();
		await canvas.click({ position: { x: 450, y: 360 } });
		await canvas.click({ position: { x: 760, y: 360 } });
		await page.locator('body').press('Escape');
		await page.locator('body').press('Escape');
		await expectSelectMode(page);

		// Nothing under the cursor: I does nothing.
		await page.mouse.move(200, 600);
		await page.locator('body').press('i');
		await expectSelectMode(page);

		await page.mouse.move(620, 360);
		await page.locator('body').press('i');
		const copied = nav.getByRole('button', { name: 'Custom road' });
		await expect(copied).toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('aside').locator('input[type="number"]')).toHaveCount(7);
		await page.screenshot({ path: 'test-results/eyedropper.png' });

		// Drawing straight away uses the copied lanes.
		await canvas.click({ position: { x: 450, y: 520 } });
		await canvas.click({ position: { x: 760, y: 520 } });
		const { segments } = await liveGraph(page);
		expect(segments).toHaveLength(2);
		expect(segments[1].lanes).toHaveLength(7);
	});
});
