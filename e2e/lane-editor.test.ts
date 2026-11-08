import { expect, test } from '@playwright/test';
import { saveCity } from './save';

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
	await saveCity(page);
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
		// 5 + 3.5 + 3.5 + 2: the Street preset's lanes are 3.5 m.
		await expect(panel.getByText('14m total')).toBeVisible();

		const segments = await readSavedSegments(page);
		expect(segments).toHaveLength(2);
		const edited = segments.find((s: { id: string }) => s.id === 'segment-0');
		expect(edited.lanes).toHaveLength(4);
		expect(edited.lanes[0]).toEqual({
			id: 'l0',
			role: 'pedestrian',
			material: 'pavement',
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
		expect(edited.lanes.map((lane: { material: string }) => lane.material)).toEqual([
			'asphalt',
			'pavement',
			'asphalt',
			'pavement'
		]);
	});

	test('shift+click multi-selects segments and edits them together', async ({ page }) => {
		await seedGraph(page);

		const canvas = page.locator('canvas');
		const panel = page.locator('aside');

		// Select the street (copying its lanes), then shift+click the avenue.
		await canvas.click({ position: toScreen(-100, 0) });
		await expect(panel).toBeVisible();
		await page.keyboard.press('ControlOrMeta+c');
		await canvas.click({ position: toScreen(100, 0), modifiers: ['Shift'] });

		// Different configurations: no lane rows to edit.
		await expect(panel.getByText('Editing 2 segments')).toBeVisible();
		await expect(panel.getByText('different lane configurations')).toBeVisible();
		await expect(panel.locator('input[type="number"]')).toHaveCount(0);

		// Paste the street's lanes over both; the selection becomes uniform.
		await page.keyboard.press('ControlOrMeta+v');
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
				id: 'l0',
				role: 'pedestrian',
				material: 'pavement',
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

	test('adds lanes; pasted lanes are owned copies', async ({ page }) => {
		await seedGraph(page);
		await selectSegment(page);

		const panel = page.locator('aside');
		const widthInputs = panel.locator('input[type="number"]');

		await panel.getByRole('button', { name: 'Add lane' }).click();
		await expect(widthInputs).toHaveCount(5);

		// Copy the street's five lanes onto the avenue. Clicking the street
		// again takes focus off the Add lane button, so the shortcut reaches
		// the editor.
		await selectSegment(page);
		await page.keyboard.press('ControlOrMeta+c');
		await page.locator('canvas').click({ position: toScreen(100, 0) });
		await expect(widthInputs).toHaveCount(9);
		await page.keyboard.press('ControlOrMeta+v');
		await expect(widthInputs).toHaveCount(5);

		// Both segments now share a cross-section; editing one must not touch
		// the other — lanes are owned copies, never shared.
		await selectSegment(page);
		await widthInputs.first().fill('7');
		await widthInputs.first().press('Tab');

		const segments = await readSavedSegments(page);
		const edited = segments.find((s: { id: string }) => s.id === 'segment-0');
		expect(edited.lanes).toHaveLength(5);
		expect(edited.lanes[0].width).toBe(7);

		const other = segments.find((s: { id: string }) => s.id === 'segment-1');
		expect(other.lanes).toHaveLength(5);
		expect(other.lanes[0].width).toBe(2);
	});

	test('an added lane goes on the roadway, inside the right-hand sidewalk', async ({ page }) => {
		await seedGraph(page);
		await selectSegment(page);

		await page.locator('aside').getByRole('button', { name: 'Add lane' }).click();
		await expect(page.locator('aside input[type="number"]')).toHaveCount(5);

		const segments = await readSavedSegments(page);
		const edited = segments.find((s: { id: string }) => s.id === 'segment-0');
		// Street: sidewalk / backward / forward / sidewalk. The new lane follows
		// the forward lane it sits beside.
		expect(edited.lanes.map((l: { id: string }) => l.id)).toEqual(['l0', 'l1', 'l2', 'l4', 'l3']);
		expect(edited.lanes[3]).toEqual({
			id: 'l4',
			role: 'vehicle',
			material: 'asphalt',
			width: 3.5,
			direction: 'forward'
		});
	});

	test('panel buttons hand keyboard focus back to the map', async ({ page }) => {
		await seedGraph(page);
		await selectSegment(page);

		const panel = page.locator('aside');
		const widthInputs = panel.locator('input[type="number"]');

		// Escape straight after a click in the panel reaches the editor and
		// clears the selection.
		await panel.getByRole('button', { name: 'Add lane' }).click();
		await expect(widthInputs).toHaveCount(5);
		await page.keyboard.press('Escape');
		await expect(panel).not.toBeVisible();

		await selectSegment(page);
		await panel.getByTitle('Remove lane').first().click();
		await expect(widthInputs).toHaveCount(4);
		await page.keyboard.press('Escape');
		await expect(panel).not.toBeVisible();

		await selectSegment(page);
		await panel.getByTitle('Direction of travel', { exact: false }).first().click();
		await expect(page.locator('body')).toBeFocused();

		await panel.getByText('Pavement').first().click();
		await page.getByRole('option', { name: 'Grass' }).click();
		await expect(panel.getByText('Grass')).toBeVisible();
		await expect(page.locator('body')).toBeFocused();

		// A width field keeps focus while it is being typed into.
		await widthInputs.first().fill('5');
		await widthInputs.first().press('Enter');
		await expect(widthInputs.first()).toBeFocused();
	});
});
