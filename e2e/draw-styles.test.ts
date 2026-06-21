import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'citynista-graph-v2';

// World→screen at the default camera: screen = center + world * (720 / 500).

test.describe('Draw styles', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/?topdown');
		await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);
		await page.reload();
		await expect(page.locator('canvas')).toBeVisible();
	});

	const savedGraph = (page: import('@playwright/test').Page) =>
		page.evaluate((key) => {
			const data = localStorage.getItem(key);
			return data ? JSON.parse(data) : null;
		}, STORAGE_KEY);

	test('curved style places the apex click as the control point', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await page.getByTitle('Curved (start, apex, end) (Tab cycles)').click();

		// Start, apex, end — three clicks, one curved segment.
		await canvas.click({ position: { x: 300, y: 400 }, force: true });
		await canvas.click({ position: { x: 450, y: 250 }, force: true });
		await canvas.click({ position: { x: 600, y: 400 }, force: true });
		await page.keyboard.press('Escape');

		const data = await savedGraph(page);
		expect(data.segments.length).toBe(1);
		expect(data.segments[0].controlX).toBeDefined();
		// The apex was above the chord, so the control sits above it too
		// (negative world y is up on screen).
		expect(data.segments[0].controlY).toBeLessThan(0);
	});

	test('smooth style chains tangent-continuous segments', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await page.getByTitle('Smooth (tangent-continuous)').click();

		// First segment has nothing to continue: straight. The second bends
		// to leave the first without a kink.
		await canvas.click({ position: { x: 250, y: 400 }, force: true });
		await canvas.click({ position: { x: 450, y: 400 }, force: true });
		await canvas.click({ position: { x: 600, y: 250 }, force: true });
		await page.keyboard.press('Escape');

		const data = await savedGraph(page);
		expect(data.segments.length).toBe(2);
		const curved = data.segments.find((s: { controlX?: number }) => s.controlX !== undefined);
		expect(curved).toBeDefined();
		// Tangent continuity: the control sits on the first segment's exit
		// tangent, which is horizontal — same world y as the shared node.
		const shared = data.nodes.find(
			(n: { id: string }) => n.id === curved.startNodeId || n.id === curved.endNodeId
		);
		expect(Math.abs(curved.controlY - shared.y)).toBeLessThan(0.5);
	});

	test('shift snaps the pending segment to 22.5 degree increments', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();

		await canvas.click({ position: { x: 300, y: 400 }, force: true });
		// 19° off horizontal — snaps to 22.5° under shift.
		await page.keyboard.down('Shift');
		await canvas.click({ position: { x: 540, y: 318 }, force: true });
		await page.keyboard.up('Shift');
		await page.keyboard.press('Escape');

		const data = await savedGraph(page);
		expect(data.segments.length).toBe(1);
		const a = data.nodes.find((n: { id: string }) => n.id === data.segments[0].startNodeId);
		const b = data.nodes.find((n: { id: string }) => n.id === data.segments[0].endNodeId);
		const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
		expect(Math.abs(angle - -22.5)).toBeLessThan(0.5);
	});

	test('shift-dragging a two-segment node smooths its tangent', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();

		// A corner: two straight segments meeting at a right-ish angle.
		await canvas.click({ position: { x: 300, y: 400 }, force: true });
		await canvas.click({ position: { x: 500, y: 400 }, force: true });
		await canvas.click({ position: { x: 500, y: 250 }, force: true });
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await expect(page.getByTitle('Select')).toHaveAttribute('aria-pressed', 'true');

		// Select the corner node, then shift+drag it.
		await canvas.click({ position: { x: 500, y: 400 }, force: true });
		await page.keyboard.down('Shift');
		await page.mouse.move(500, 400);
		await page.mouse.down();
		await page.mouse.move(520, 390, { steps: 4 });
		await page.mouse.up();
		await page.keyboard.up('Shift');

		const data = await savedGraph(page);
		expect(data.segments.length).toBe(2);
		// Both segments gained control points solving the shared tangent.
		expect(data.segments.every((s: { controlX?: number }) => s.controlX !== undefined)).toBe(true);
	});
});

test.describe('Zoom-adaptive hit areas', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/?topdown');
		await page.evaluate(() => localStorage.removeItem('citynista-graph-v2'));
		await page.reload();
		await expect(page.locator('canvas')).toBeVisible();
	});

	test('zooming in makes a short segment selectable next to its nodes', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();

		// A short segment: ~35px on screen at the default zoom, shorter than
		// the combined node halos.
		await canvas.click({ position: { x: 400, y: 300 }, force: true });
		await canvas.click({ position: { x: 435, y: 300 }, force: true });
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await expect(page.getByTitle('Select')).toHaveAttribute('aria-pressed', 'true');

		// Zoom in hard; zoom anchors at the viewport center, so the segment
		// (world midpoint -154.5, -41.7) lands at a computable screen spot
		// while hit halos stay pixel-sized.
		await page.mouse.move(640, 360);
		for (let i = 0; i < 8; i++) {
			await page.mouse.wheel(0, -100);
		}

		// scale = (720/500) * 1.12^8 ≈ 3.565 px per world unit.
		const x = Math.round(640 - 154.5 * 3.565);
		const y = Math.round(360 - 41.7 * 3.565);

		// Click the middle of the (now long) segment: the lane editor panel
		// opening proves a segment — not a node — was selected.
		await canvas.click({ position: { x, y }, force: true });
		await expect(page.getByRole('heading', { name: 'Lanes' })).toBeVisible();
	});
});

test.describe('Shift-drag collinear snapping', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/?topdown');
		await page.evaluate(() => localStorage.removeItem('citynista-graph-v2'));
		await page.reload();
		await expect(page.locator('canvas')).toBeVisible();
	});

	const savedGraph = (page: import('@playwright/test').Page) =>
		page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph-v2');
			return data ? JSON.parse(data) : null;
		});

	test('a middle node snaps onto the line between far endpoints', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await canvas.click({ position: { x: 300, y: 300 }, force: true });
		await canvas.click({ position: { x: 450, y: 330 }, force: true });
		await canvas.click({ position: { x: 600, y: 300 }, force: true });
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await expect(page.getByTitle('Select')).toHaveAttribute('aria-pressed', 'true');

		// Select the bent middle node and shift-drag it near the line
		// between the two far endpoints.
		await canvas.click({ position: { x: 450, y: 330 }, force: true });
		await page.keyboard.down('Shift');
		await page.mouse.move(450, 330);
		await page.mouse.down();
		await page.mouse.move(450, 305, { steps: 5 });
		await page.mouse.up();
		await page.keyboard.up('Shift');

		const data = await savedGraph(page);
		const ys = data.nodes.map((n: { y: number }) => n.y);
		// All three nodes share the far endpoints' y: perfectly straight.
		expect(Math.abs(ys[1] - ys[0])).toBeLessThan(0.01);
		expect(Math.abs(ys[2] - ys[0])).toBeLessThan(0.01);
	});

	test('an end node snaps onto the continuation of the adjacent road', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await canvas.click({ position: { x: 250, y: 300 }, force: true });
		await canvas.click({ position: { x: 450, y: 300 }, force: true });
		await canvas.click({ position: { x: 620, y: 360 }, force: true });
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await expect(page.getByTitle('Select')).toHaveAttribute('aria-pressed', 'true');

		// Select the dangling end and shift-drag near the horizontal
		// extension of the first segment.
		await canvas.click({ position: { x: 620, y: 360 }, force: true });
		await page.keyboard.down('Shift');
		await page.mouse.move(620, 360);
		await page.mouse.down();
		await page.mouse.move(640, 308, { steps: 5 });
		await page.mouse.up();
		await page.keyboard.up('Shift');

		const data = await savedGraph(page);
		const ys = data.nodes.map((n: { y: number }) => n.y);
		// The end node lands exactly on the first road's line.
		expect(Math.abs(ys[2] - ys[0])).toBeLessThan(0.01);
		expect(Math.abs(ys[2] - ys[1])).toBeLessThan(0.01);
	});
});
