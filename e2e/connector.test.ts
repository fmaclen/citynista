import { test, expect } from '@playwright/test';

// The lane connector is a per-junction mode entered by double-clicking a
// junction. Dragging from an incoming lane dot to an outgoing lane dot toggles
// that movement, persisted on the node as a disabled connection. Dot screen
// positions are for the connectors-demo 4-way at zoom 18 (world origin =
// viewport centre).
const disabledCount = (page: import('@playwright/test').Page) =>
	page.evaluate(() => {
		const raw = localStorage.getItem('citynista-graph-v2');
		if (!raw) return 0;
		const node = JSON.parse(raw).nodes.find((n: { id: string }) => n.id === 'c');
		return node?.disabledConnections?.length ?? 0;
	});

test.describe('Lane connector', () => {
	test('double-click opens it; dragging a movement toggles it on and off', async ({ page }) => {
		await page.goto('/?fixture=connectors-demo&topdown');
		await page.waitForFunction(() => {
			const raw = localStorage.getItem('citynista-graph-v2');
			return !!raw && JSON.parse(raw).nodes.length === 5;
		});
		await page.mouse.move(640, 360);
		for (let i = 0; i < 18; i++) await page.mouse.wheel(0, -100);

		await page.mouse.dblclick(640, 360);

		const drag = async () => {
			// North incoming dot (cyan) -> East outgoing dot (white).
			await page.mouse.move(619, 281);
			await page.mouse.down();
			await page.mouse.move(668, 330, { steps: 5 });
			await page.mouse.move(717, 379, { steps: 5 });
			await page.mouse.up();
		};

		await drag();
		await expect.poll(() => disabledCount(page)).toBe(1);

		// Dragging the same movement again re-enables it.
		await drag();
		await expect.poll(() => disabledCount(page)).toBe(0);
	});

	test('is modal: clicking a road is ignored until Escape returns to select', async ({ page }) => {
		await page.goto('/?fixture=connectors-demo&topdown');
		await page.waitForFunction(() => {
			const raw = localStorage.getItem('citynista-graph-v2');
			return !!raw && JSON.parse(raw).nodes.length === 5;
		});
		await page.mouse.move(640, 360);
		for (let i = 0; i < 18; i++) await page.mouse.wheel(0, -100);

		await page.mouse.dblclick(640, 360);

		// Clicking the road next to the junction does nothing — no selection,
		// still in connector mode (the lane panel never opens).
		await page.mouse.click(640, 250);
		await expect(page.locator('aside')).not.toBeVisible();

		// Escape returns to select mode, where that road selects normally.
		await page.keyboard.press('Escape');
		await page.mouse.click(640, 250);
		await expect(page.locator('aside')).toBeVisible();
	});
});
