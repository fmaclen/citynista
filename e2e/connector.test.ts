import { test, expect } from '@playwright/test';
import { openScene } from './scenes';
import { saveCity } from './save';

// The lane connector is a per-junction mode entered by double-clicking a
// junction. Dragging from an incoming lane dot to an outgoing lane dot toggles
// that movement, persisted on the node as a hand edit (`junction.added` or
// `junction.removed`, depending on whether the movement is a default). Dot
// screen positions are for the connectors-demo scene's 4-way at zoom 18 (world
// origin = viewport centre).
const editCount = async (page: import('@playwright/test').Page) => {
	await saveCity(page);
	return page.evaluate(() => {
		const raw = localStorage.getItem('citynista-graph-v2');
		if (!raw) return 0;
		const node = JSON.parse(raw).nodes.find((n: { id: string }) => n.id === 'c');
		return (node?.junction?.added?.length ?? 0) + (node?.junction?.removed?.length ?? 0);
	});
};

test.describe('Lane connector', () => {
	test('double-click opens it; dragging a movement toggles it on and off', async ({ page }) => {
		await openScene(page, 'connectors-demo');
		await page.waitForFunction(() => {
			const raw = localStorage.getItem('citynista-graph-v2');
			return !!raw && JSON.parse(raw).nodes.length === 5;
		});
		await page.mouse.move(640, 360);
		for (let i = 0; i < 18; i++) await page.mouse.wheel(0, -100);

		await page.mouse.dblclick(640, 360);

		const drag = async () => {
			// North incoming dot (filled) -> East outgoing dot (ring).
			await page.mouse.move(620, 322);
			await page.mouse.down();
			await page.mouse.move(649, 350, { steps: 5 });
			await page.mouse.move(678, 379, { steps: 5 });
			await page.mouse.up();
		};

		await drag();
		await expect.poll(() => editCount(page)).toBe(1);

		// Dragging the same movement again undoes the edit.
		await drag();
		await expect.poll(() => editCount(page)).toBe(0);
	});

	test('is modal: clicking a road is ignored until Escape returns to select', async ({ page }) => {
		await openScene(page, 'connectors-demo');
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
	test('one click on a crossing handle switches it; another switches it back', async ({ page }) => {
		// The handles scene at 4x: T junction j at (70, -30), its west arm's
		// crossing switched off, the handle 10.5 m out along that arm.
		await openScene(page, 'handles', 'topdown&cam=0,0,4');
		const px = (720 / 500) * 4;
		const at = (x: number, y: number) => ({ x: 640 + x * px, y: 360 + y * px });
		const westOn = async () => {
			await saveCity(page);
			return page.evaluate(() => {
				const raw = JSON.parse(localStorage.getItem('citynista-graph-v2') ?? 'null');
				const j = raw.nodes.find((n: { id: string }) => n.id === 'j');
				return j.junction.crossings.find((c: { road: string }) => c.road === 'jw')?.on;
			});
		};
		const junction = at(70, -30);
		await page.mouse.dblclick(junction.x, junction.y);
		const handle = at(59.5, -30.2);
		await page.mouse.click(handle.x, handle.y);
		expect(await westOn()).toBe(true);
		await page.mouse.click(handle.x, handle.y);
		expect(await westOn()).toBe(false);
	});
});
