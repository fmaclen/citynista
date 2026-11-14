import { expect, test } from '@playwright/test';
import { editorLook, openScene, screenAt } from './app';

// A handle rests until the pointer is over it, then is lit for hover, and for
// active while it is in hand. The scene, at 4× zoom, has a curved road a–b
// offset 2 m right of its line.
const ZOOM = 4;
const toScreen = screenAt(ZOOM);

test('a handle rests, and is lit while hovered and dragged', async ({ page }) => {
	await openScene(page, 'handles', `topdown&model&cam=0,0,${ZOOM}`);
	const lit = async () => (await editorLook(page)).handle;
	const curve = { ref: { kind: 'curve', segmentId: 'curve' } };

	// The curved road's curvature handle on the control point (moved by the
	// offset); the road itself away from it.
	const handle = toScreen(-65, -3);
	const road = toScreen(-53.4, 12.41);
	await page.mouse.click(road.x, road.y);
	await expect(page.locator('aside')).toBeVisible();
	expect(await lit()).toBeNull();

	await page.mouse.move(handle.x, handle.y);
	await expect.poll(lit).toEqual({ ...curve, state: 'hover' });
	await page.mouse.down();
	await expect.poll(lit).toEqual({ ...curve, state: 'active' });
	await page.mouse.up();
	await expect.poll(lit).toEqual({ ...curve, state: 'hover' });
	await page.mouse.move(handle.x, handle.y + 150);
	await expect.poll(lit).toBeNull();
});
