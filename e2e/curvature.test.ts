import { expect, test } from '@playwright/test';
import { openScene, liveGraph, toScreen } from './app';
import { segmentOf } from '../unit/model';

test.describe('Curvature handle', () => {
	test('on a ramp attached at the freeway edge it stays under the cursor', async ({ page }) => {
		// The ramp runs from (-60, -150) to the freeway node at the origin, but
		// its end is drawn at the freeway's west roadway edge, (-13.75, 0), so
		// the road shows its middle at (-36.875, -75), not between its nodes.
		await openScene(page, 'attached-ramp');

		const onRamp = toScreen(-48.4, -112.5);
		await page.mouse.click(onRamp.x, onRamp.y);
		await expect(page.locator('aside')).toBeVisible();

		const handle = toScreen(-36.875, -75);
		await page.mouse.move(handle.x, handle.y);
		await page.mouse.down();
		await page.mouse.move(toScreen(-16.875, -75).x, handle.y, { steps: 5 });
		await page.mouse.up();

		const ramp = segmentOf(await liveGraph(page), 'ramp');
		// Dragged 20 m east from where it was drawn.
		expect(ramp.controlX).toBeCloseTo(-16.875, 0);
		expect(ramp.controlY).toBeCloseTo(-75, 0);
	});
});
