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
	await page.goto('/?topdown');
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

// Select mode is the default; clicking a segment selects it directly.
async function selectSegment(page: import('@playwright/test').Page) {
	const point = toScreen(-50, 0);
	await page.locator('canvas').click({ position: { x: point.x, y: point.y } });
	await expect(page.locator('aside')).toBeVisible();
}

test.describe('Lane Editor', () => {
	test('panel opens on selection, edits widths, migrates legacy saves', async ({ page }) => {
		await seedGraph(page);
		await selectSegment(page);

		const panel = page.locator('aside');

		// A street is sidewalk / road / road / sidewalk.
		const widthInputs = panel.locator('input[type="number"]');
		await expect(widthInputs).toHaveCount(4);

		// Typing keys in panel inputs must not trigger canvas shortcuts.
		await widthInputs.first().press('Backspace');
		await widthInputs.first().press('Escape');
		await expect(panel).toBeVisible();

		await widthInputs.first().fill('5');
		await widthInputs.first().press('Tab');
		await expect(panel.getByText('13m total')).toBeVisible();

		const segments = await readSavedSegments(page);
		expect(segments).toHaveLength(2);
		const edited = segments.find((s: { id: string }) => s.id === 'segment-0');
		expect(edited.lanes).toHaveLength(4);
		expect(edited.lanes[0]).toEqual({
			role: 'pedestrian',
			surface: 'concrete',
			width: 5,
			direction: 'bidirectional'
		});
		expect(edited.laneTemplateId).toBeUndefined();
	});

	test('panel hides when the selection is cleared', async ({ page }) => {
		await seedGraph(page);
		await selectSegment(page);

		await page.locator('aside').getByTitle('Close').click();
		await expect(page.locator('aside')).not.toBeVisible();

		// Reselect (still in select mode), then click empty ground to deselect.
		const point = toScreen(-50, 0);
		await page.locator('canvas').click({ position: { x: point.x, y: point.y } });
		await expect(page.locator('aside')).toBeVisible();

		await page.locator('canvas').click({ position: { x: 200, y: 600 } });
		await expect(page.locator('aside')).not.toBeVisible();
	});

	test('reorders lanes by dragging rows', async ({ page }) => {
		await seedGraph(page);
		await selectSegment(page);

		const panel = page.locator('aside');
		const handles = panel.getByTitle('Drag to reorder');
		const rows = panel.getByRole('listitem');
		await expect(handles).toHaveCount(4);

		// Street is sidewalk / road / road / sidewalk; drag the first sidewalk
		// one row down.
		await handles.first().dragTo(rows.nth(1));

		const segments = await readSavedSegments(page);
		const edited = segments.find((s: { id: string }) => s.id === 'segment-0');
		expect(edited.lanes.map((lane: { surface: string }) => lane.surface)).toEqual([
			'asphalt',
			'concrete',
			'asphalt',
			'concrete'
		]);
	});

	test('shift+click multi-selects segments and edits them together', async ({ page }) => {
		await seedGraph(page);

		const canvas = page.locator('canvas');
		const panel = page.locator('aside');

		// Select the street, then shift+click the avenue.
		await canvas.click({ position: toScreen(-100, 0) });
		await expect(panel).toBeVisible();
		await canvas.click({ position: toScreen(100, 0), modifiers: ['Shift'] });

		// Different configurations: no lane rows, just the preset escape hatch.
		await expect(panel.getByText('Editing 2 segments')).toBeVisible();
		await expect(panel.getByText('different lane configurations')).toBeVisible();
		await expect(panel.locator('input[type="number"]')).toHaveCount(0);

		// Overwrite both with a preset; the selection becomes uniform.
		await panel.getByText('Apply preset…').click();
		await page.getByRole('option', { name: 'Street' }).click();
		const widthInputs = panel.locator('input[type="number"]');
		await expect(widthInputs).toHaveCount(4);

		// Width edits now apply to every selected segment.
		await widthInputs.first().fill('6');
		await widthInputs.first().press('Tab');

		const segments = await readSavedSegments(page);
		expect(segments).toHaveLength(2);
		for (const segment of segments) {
			expect(segment.lanes).toHaveLength(4);
			expect(segment.lanes[0]).toEqual({
				role: 'pedestrian',
				surface: 'concrete',
				width: 6,
				direction: 'bidirectional'
			});
		}

		// Shift+click on a selected segment removes it from the selection —
		// away from the midpoint (the control-point handle) and clear of the
		// lane panel, which overlays the right edge of the canvas.
		await canvas.click({ position: toScreen(50, 0), modifiers: ['Shift'] });
		await expect(panel.getByText('Left to right along the drawing direction')).toBeVisible();
	});

	test('adds lanes and applies presets per segment', async ({ page }) => {
		await seedGraph(page);
		await selectSegment(page);

		const panel = page.locator('aside');

		await panel.getByRole('button', { name: 'Add lane' }).click();
		await expect(panel.locator('input[type="number"]')).toHaveCount(5);

		await panel.getByText('Apply preset…').click();
		await page.getByRole('option', { name: 'Avenue' }).click();
		const widthInputs = panel.locator('input[type="number"]');
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
