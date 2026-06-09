import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'citynista-graph-v2';

// Legacy save format: segments reference a template id instead of owning lanes.
const LEGACY_GRAPH_DATA = {
	nodes: [
		{ id: 'node-0', x: -200, y: 0 },
		{ id: 'node-1', x: 0, y: 0 },
		{ id: 'node-2', x: 200, y: 0 }
	],
	segments: [
		{ id: 'segment-0', startNodeId: 'node-0', endNodeId: 'node-1', laneTemplateId: 'street' },
		{ id: 'segment-1', startNodeId: 'node-1', endNodeId: 'node-2', laneTemplateId: 'avenue' }
	]
};

// world -> screen at the default camera: screen = center + world * (720 / 500)
const SCALE = 720 / 500;
const toScreen = (x: number, y: number) => ({ x: 640 + x * SCALE, y: 360 + y * SCALE });

async function seedGraph(page: import('@playwright/test').Page) {
	await page.goto('/');
	await expect(page.locator('canvas')).toBeVisible();
	await page.evaluate(
		({ key, data }) => {
			localStorage.setItem(key, JSON.stringify(data));
		},
		{ key: STORAGE_KEY, data: LEGACY_GRAPH_DATA }
	);
	await page.reload();
	await expect(page.locator('canvas')).toBeVisible();
	await expect(page.locator('nav')).toBeVisible();
}

async function readSavedSegments(page: import('@playwright/test').Page) {
	return page.evaluate((key) => {
		const data = localStorage.getItem(key);
		return data ? JSON.parse(data).segments : null;
	}, STORAGE_KEY);
}

test.describe('Lane Editor', () => {
	test('opens on double-click, edits widths, migrates legacy saves', async ({ page }) => {
		await seedGraph(page);

		await page.getByTitle('Select Mode').click();
		// Off the midpoint: once selected, the chord midpoint is the curvature
		// handle, and double-clicking the handle must not open the editor.
		const point = toScreen(-50, 0);
		await page.locator('canvas').dblclick({ position: { x: point.x, y: point.y } });

		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();

		// A street is sidewalk / road / road / sidewalk.
		const widthInputs = dialog.locator('input[type="number"]');
		await expect(widthInputs).toHaveCount(4);

		await widthInputs.first().fill('5');
		await widthInputs.first().press('Tab');
		await expect(dialog.getByText('13m total')).toBeVisible();

		const segments = await readSavedSegments(page);
		const edited = segments.find((s: { id: string }) => s.id === 'segment-0');
		expect(edited.lanes).toHaveLength(4);
		expect(edited.lanes[0]).toEqual({ type: 'sidewalk', width: 5, direction: 'bidirectional' });
		expect(edited.laneTemplateId).toBeUndefined();
	});

	test('opens from the toolbar button for the selected segment', async ({ page }) => {
		await seedGraph(page);

		await page.getByTitle('Select Mode').click();
		const editLanes = page.getByTitle('Edit Lanes');
		await expect(editLanes).toBeDisabled();

		const mid = toScreen(-100, 0);
		await page.locator('canvas').click({ position: { x: mid.x, y: mid.y } });
		await expect(editLanes).toBeEnabled();

		await editLanes.click();
		await expect(page.getByRole('dialog')).toBeVisible();
	});

	test('adds lanes and applies presets per segment', async ({ page }) => {
		await seedGraph(page);

		await page.getByTitle('Select Mode').click();
		const point = toScreen(-50, 0);
		await page.locator('canvas').dblclick({ position: { x: point.x, y: point.y } });

		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();

		await dialog.getByRole('button', { name: 'Add lane' }).click();
		await expect(dialog.locator('input[type="number"]')).toHaveCount(5);

		await dialog.getByText('Apply preset…').click();
		await page.getByRole('option', { name: 'Avenue' }).click();
		const widthInputs = dialog.locator('input[type="number"]');
		await expect(widthInputs).toHaveCount(9);

		// Both segments are now avenue-shaped; editing one must not touch the
		// other — lanes are owned copies, never shared.
		await widthInputs.first().fill('7');
		await widthInputs.first().press('Tab');

		const segments = await readSavedSegments(page);
		const edited = segments.find((s: { id: string }) => s.id === 'segment-0');
		expect(edited.lanes).toHaveLength(9);
		expect(edited.lanes[0].width).toBe(7);

		const other = segments.find((s: { id: string }) => s.id === 'segment-1');
		expect(other.lanes).toHaveLength(9);
		expect(other.lanes[0].width).toBe(3);
	});
});
