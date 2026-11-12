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

// Mean red, green and blue (0-255) of the 3x3 screen pixels around a point.
async function colourAt(page: import('@playwright/test').Page, x: number, y: number) {
	const png = await page.screenshot({ clip: { x: x - 1.5, y: y - 1.5, width: 3, height: 3 } });
	return page.evaluate(async (data) => {
		const img = new Image();
		img.src = `data:image/png;base64,${data}`;
		await img.decode();
		const canvas = document.createElement('canvas');
		canvas.width = img.width;
		canvas.height = img.height;
		const ctx = canvas.getContext('2d');
		if (!ctx) return [-1, -1, -1];
		ctx.drawImage(img, 0, 0);
		const px = ctx.getImageData(0, 0, img.width, img.height).data;
		const sum = [0, 0, 0];
		for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += px[i + c];
		return sum.map((v) => v / (px.length / 4));
	}, png.toString('base64'));
}

// Mean brightness (0-255) of the 3x3 screen pixels around a point.
async function brightnessAt(page: import('@playwright/test').Page, x: number, y: number) {
	const [r, g, b] = await colourAt(page, x, y);
	return (r + g + b) / 3;
}

// How far a point leans blue over red: the lane highlight is cyan.
async function blueAt(page: import('@playwright/test').Page, at: { x: number; y: number }) {
	const [r, , b] = await colourAt(page, at.x, at.y);
	return b - r;
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
			material: 'concrete',
			width: 5,
			direction: 'bidirectional'
		});
		expect(edited.laneTemplateId).toBeUndefined();
	});

	test('the panel never scrolls sideways and the longest labels fit', async ({ page }) => {
		await seedGraph(page);
		await selectSegment(page);
		const panel = page.locator('aside');
		await expect(panel.getByText('Pedestrian').first()).toBeVisible();
		await expect(panel.getByText('Concrete').first()).toBeVisible();

		const overflow = () =>
			panel.evaluate((el) => ({
				panel: el.scrollWidth - el.clientWidth,
				labels: [...el.querySelectorAll('button span.truncate')].map(
					(span) => span.scrollWidth - span.clientWidth
				)
			}));
		const roomy = await overflow();
		expect(roomy.panel).toBe(0);
		expect(Math.max(...roomy.labels)).toBe(0);

		// A short window gives the panel a vertical scrollbar, which takes
		// width from the rows; still no sideways scroll.
		await page.setViewportSize({ width: 1280, height: 300 });
		await expect.poll(() => panel.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
		expect((await overflow()).panel).toBe(0);
		await panel.screenshot({ path: 'test-results/lane-panel-short.png' });
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

	test('dragging a row opens a slot where it will land; the drop commits', async ({ page }) => {
		await seedGraph(page);
		await selectSegment(page);

		const panel = page.locator('aside');
		const rows = panel.getByRole('listitem');
		const slot = panel.locator('[data-drop-slot]');
		await expect(rows).toHaveCount(4);
		await page.mouse.move(200, 600);
		await panel.screenshot({ path: 'test-results/lane-panel-rest.png' });

		// Street is sidewalk / road / road / sidewalk; take the first sidewalk
		// down to the third row.
		const grip = await panel.getByTitle('Drag to reorder').first().boundingBox();
		const target = await rows.nth(2).boundingBox();
		if (!grip || !target) throw new Error('no rows');
		await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
		await page.mouse.down();
		await page.mouse.move(grip.x + grip.width / 2, target.y + target.height / 2, { steps: 6 });

		// The slot is the third row, where row 2 was; the rows above made room.
		await expect(slot).toHaveCount(1);
		await expect(rows.nth(2)).toHaveAttribute('data-drop-slot', '');
		await expect.poll(async () => (await slot.boundingBox())?.y).toBeCloseTo(target.y, 0);
		// Held near the top of that place, the lifted row shows the slot below it.
		await page.mouse.move(grip.x + grip.width / 2, target.y - 6);
		await expect(rows.nth(2)).toHaveAttribute('data-drop-slot', '');
		await page.screenshot({
			path: 'test-results/lane-panel-drag.png',
			clip: { x: 760, y: 0, width: 520, height: 320 }
		});

		await page.mouse.up();
		await expect(slot).toHaveCount(0);
		const segments = await readSavedSegments(page);
		const edited = segments.find((s: { id: string }) => s.id === 'segment-0');
		expect(edited.lanes.map((l: { id: string }) => l.id)).toEqual(['l1', 'l2', 'l0', 'l3']);
	});

	test('Escape or a drop off the list puts a dragged lane back', async ({ page }) => {
		await seedGraph(page);
		await selectSegment(page);

		const panel = page.locator('aside');
		const rows = panel.getByRole('listitem');
		const slot = panel.locator('[data-drop-slot]');
		const handle = panel.getByTitle('Drag to reorder').first();
		const grip = await handle.boundingBox();
		const target = await rows.nth(3).boundingBox();
		if (!grip || !target) throw new Error('no rows');
		const pickUp = async () => {
			// Once the row has slid back from any earlier drag.
			await expect.poll(async () => (await handle.boundingBox())?.y).toBe(grip.y);
			await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
			await page.mouse.down();
			await page.mouse.move(grip.x + grip.width / 2, target.y + target.height / 2, { steps: 6 });
			await expect(rows.nth(3)).toHaveAttribute('data-drop-slot', '');
		};

		// Escape ends the drag and leaves the panel open.
		await pickUp();
		await page.keyboard.press('Escape');
		await expect(slot).toHaveCount(0);
		await expect(panel).toBeVisible();
		await page.mouse.up();

		// Off the list, the slot goes back to the lane's own row, and stays.
		await pickUp();
		await page.mouse.move(400, 600, { steps: 4 });
		await expect(rows.nth(0)).toHaveAttribute('data-drop-slot', '');
		await page.mouse.up();
		await expect(slot).toHaveCount(0);
		await expect(panel).toBeVisible();

		// The order never changed.
		const segments = await readSavedSegments(page);
		const edited = segments.find((s: { id: string }) => s.id === 'segment-0');
		expect(edited.lanes.map((l: { id: string }) => l.id)).toEqual(['l0', 'l1', 'l2', 'l3']);
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
		await expect(panel.getByText('different lanes')).toBeVisible();
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
				material: 'concrete',
				width: 6,
				direction: 'bidirectional'
			});
		}

		// Shift+click on a selected segment removes it from the selection —
		// away from the midpoint (the control-point handle) and clear of the
		// lane panel, which overlays the right edge of the canvas.
		// The next width edit reaches only the road still selected.
		await canvas.click({ position: toScreen(50, 0), modifiers: ['Shift'] });
		await widthInputs.first().fill('8');
		await widthInputs.first().press('Tab');
		const widths = (await readSavedSegments(page)).map(
			(s: { lanes: { width: number }[] }) => s.lanes[0].width
		);
		expect(widths.sort()).toEqual([6, 8]);
	});

	test('adds lanes; pasted lanes are owned copies', async ({ page }) => {
		await seedGraph(page);
		await selectSegment(page);

		const panel = page.locator('aside');
		const widthInputs = panel.locator('input[type="number"]');

		await panel.getByRole('button', { name: 'Add lane' }).click();
		await expect(widthInputs).toHaveCount(5);

		// Copy the street's five lanes onto the avenue.
		await selectSegment(page);
		await page.keyboard.press('ControlOrMeta+c');
		await page.locator('canvas').click({ position: toScreen(80, 0) });
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

	test('a + between rows inserts a car lane there', async ({ page }) => {
		await seedGraph(page);
		await selectSegment(page);
		const panel = page.locator('aside');

		// A gap sits above each of the street's four rows.
		const gaps = panel.getByTitle('Insert a lane here');
		await expect(gaps).toHaveCount(4);
		await gaps.nth(2).hover();
		await gaps.nth(2).click();
		await expect(panel.locator('input[type="number"]')).toHaveCount(5);
		await expect(gaps).toHaveCount(5);
		await gaps.nth(3).hover();
		await page.screenshot({ path: 'test-results/lane-panel-five-lanes.png' });

		const segments = await readSavedSegments(page);
		const edited = segments.find((s: { id: string }) => s.id === 'segment-0');
		expect(edited.lanes.map((l: { id: string }) => l.id)).toEqual(['l0', 'l1', 'l4', 'l2', 'l3']);
		expect(edited.lanes[2]).toEqual({
			id: 'l4',
			role: 'vehicle',
			material: 'asphalt',
			width: 3.5,
			direction: 'forward'
		});
	});

	test('copying a row puts an identical lane just below it', async ({ page }) => {
		await seedGraph(page);
		await selectSegment(page);
		const panel = page.locator('aside');

		// Row 1 is the street's backward car lane.
		await panel.getByTitle('Copy lane').nth(1).click();
		await expect(panel.locator('input[type="number"]')).toHaveCount(5);
		await expect(page.locator('body')).toBeFocused();

		const segments = await readSavedSegments(page);
		const edited = segments.find((s: { id: string }) => s.id === 'segment-0');
		expect(edited.lanes.map((l: { id: string }) => l.id)).toEqual(['l0', 'l1', 'l4', 'l2', 'l3']);
		const { id: originalId, ...original } = edited.lanes[1];
		const { id: copyId, ...copy } = edited.lanes[2];
		expect(copy).toEqual(original);
		expect(original.direction).toBe('backward');
		expect(copyId).not.toBe(originalId);
	});

	test('an edit across selected roads keeps every lane id; new lanes get their own', async ({
		page
	}) => {
		await seedGraph(page);
		const canvas = page.locator('canvas');
		const panel = page.locator('aside');

		// Give both roads the street's lanes, then add a lane to both at once.
		await canvas.click({ position: toScreen(-100, 0) });
		await page.keyboard.press('ControlOrMeta+c');
		await canvas.click({ position: toScreen(100, 0), modifiers: ['Shift'] });
		await page.keyboard.press('ControlOrMeta+v');
		await expect(panel.locator('input[type="number"]')).toHaveCount(4);
		const before = await readSavedSegments(page);
		await panel.getByTitle('Insert a lane here').nth(3).click();
		await expect(panel.locator('input[type="number"]')).toHaveCount(5);

		const after = await readSavedSegments(page);
		for (const segment of after) {
			const old = before.find((s: { id: string }) => s.id === segment.id);
			const ids = segment.lanes.map((l: { id: string }) => l.id);
			const kept = ids.filter((id: string) => id !== ids[3]);
			expect(kept).toEqual(old.lanes.map((l: { id: string }) => l.id));
			expect(new Set(ids).size).toBe(5);
		}
	});

	test('hovering a row lights that lane on the selected road', async ({ page }) => {
		await seedGraph(page);
		await selectSegment(page);
		const rows = page.locator('aside').getByRole('listitem');
		// The street's car lanes: row 1 left of the line as drawn (west to
		// east, so north, up the screen), row 2 right of it.
		const left = toScreen(-120, -1.75);
		const right = toScreen(-120, 1.75);
		const plain = { left: await blueAt(page, left), right: await blueAt(page, right) };

		await rows.nth(1).hover();
		await expect.poll(() => blueAt(page, left)).toBeGreaterThan(plain.left + 30);
		expect(await blueAt(page, right)).toBeLessThan(plain.right + 10);
		await page.screenshot({ path: 'test-results/lane-hover-left.png' });

		await rows.nth(2).hover();
		await expect.poll(() => blueAt(page, right)).toBeGreaterThan(plain.right + 30);
		expect(await blueAt(page, left)).toBeLessThan(plain.left + 10);
		// The hovered row is lit in the panel too, in the map's hover cyan.
		await expect(rows.nth(2)).toHaveCSS('background-color', 'rgba(103, 232, 249, 0.25)');
		await expect(rows.nth(1)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await page.screenshot({ path: 'test-results/lane-hover-right.png' });
		await page.locator('aside').screenshot({ path: 'test-results/lane-panel-hover.png' });

		await page.mouse.move(200, 600);
		await expect.poll(() => blueAt(page, right)).toBeLessThan(plain.right + 10);
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

		await panel.getByText('Concrete').first().click();
		await page.getByRole('option', { name: 'Grass' }).click();
		await expect(panel.getByText('Grass')).toBeVisible();
		await expect(page.locator('body')).toBeFocused();

		// A width field keeps focus while it is being typed into.
		await widthInputs.first().fill('5');
		await widthInputs.first().press('Enter');
		await expect(widthInputs.first()).toBeFocused();
	});

	test('a vehicle lane set to concrete draws light grey', async ({ page }) => {
		await seedGraph(page);
		const panel = page.locator('aside');
		// The street's two car lanes sit either side of its centre line.
		const lanes = [toScreen(-100, -1.75), toScreen(-100, 1.75)];
		for (const p of lanes) expect(await brightnessAt(page, p.x, p.y)).toBeLessThan(90);

		await selectSegment(page);
		for (const row of [1, 2]) {
			await panel.getByRole('listitem').nth(row).getByText('Asphalt').click();
			await expect(page.getByRole('option')).toHaveText(['Asphalt', 'Concrete', 'Grass', 'Dirt']);
			await page.getByRole('option', { name: 'Concrete' }).click();
		}
		// Deselect so the selection tint doesn't colour the road.
		await panel.getByTitle('Close').click();
		for (const p of lanes)
			await expect.poll(() => brightnessAt(page, p.x, p.y)).toBeGreaterThan(130);
	});
});
