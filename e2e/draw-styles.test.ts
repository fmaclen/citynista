import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'citynista-graph-v2';

// World→screen at the default camera: screen = center + world * (720 / 500).

test.describe('Draw styles', () => {
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
