import { expect, test } from '@playwright/test';
import { openScene } from './scenes';
import { saveCity } from './save';

const SCALE = 720 / 500;
const toScreen = (x: number, y: number) => ({ x: 640 + x * SCALE, y: 360 + y * SCALE });

test.describe('Curvature handle', () => {
	test('on a ramp attached at the freeway edge it stays under the cursor', async ({ page }) => {
		// The ramp runs from (-60, -150) to the freeway node at the origin, but
		// its end is drawn at the freeway's west roadway edge, (-13.75, 0), so
		// the road shows its middle at (-36.875, -75), not between its nodes.
		await openScene(page, 'attached-ramp');
		await expect(page.locator('nav')).toBeVisible();

		const onRamp = toScreen(-48.4, -112.5);
		await page.mouse.click(onRamp.x, onRamp.y);
		await expect(page.locator('aside')).toBeVisible();

		const handle = toScreen(-36.875, -75);
		await page.mouse.move(handle.x, handle.y);
		await page.mouse.down();
		await page.mouse.move(handle.x + 20 * SCALE, handle.y, { steps: 5 });
		await page.mouse.up();

		await saveCity(page);
		const ramp = await page.evaluate(
			() =>
				JSON.parse(localStorage.getItem('citynista-graph-v2')!).segments.find(
					(s: { id: string }) => s.id === 'ramp'
				) as { controlX: number; controlY: number }
		);
		// Dragged 20 m east from where it was drawn.
		expect(ramp.controlX).toBeCloseTo(-16.875, 0);
		expect(ramp.controlY).toBeCloseTo(-75, 0);
	});
});
