import { expect, test, type Page } from '@playwright/test';
import { colourAt, openScene, screenAt, type Pt } from './app';

// Every handle rests white over a dark outline and takes the selection
// palette's tint for its state, all through one renderer. The scene, at 4×
// zoom, has a curved road a–b offset 2 m right of its line.
const ZOOM = 4;
const toScreen = screenAt(ZOOM);

// The colour a handle shows in each state (editor-palette.ts).
const tone = ([r, g, b]: number[]) =>
	r > 225 && g > 225 && b > 225
		? 'rest'
		: r < 140 && g > 200 && b > 220
			? 'hover'
			: r > 220 && g > 180 && b < 90
				? 'active'
				: `rgb(${r}, ${g}, ${b})`;
const toneAt = async (page: Page, at: Pt) => tone((await colourAt(page, at)).map(Math.round));

test('a handle rests white and is tinted while hovered and dragged', async ({ page }) => {
	await openScene(page, 'handles', `topdown&cam=0,0,${ZOOM}`);

	// The curved road's curvature handle on the control point (moved by the
	// offset), and its offset handle a quarter of the way along.
	const curve = toScreen(-65, -3);
	const offset = toScreen(-76.61, 12.41);
	const road = toScreen(-53.4, 12.41);
	await page.mouse.click(road.x, road.y);
	await expect(page.locator('aside')).toBeVisible();
	await expect.poll(() => toneAt(page, curve)).toBe('rest');
	expect(await toneAt(page, offset)).toBe('rest');

	await page.mouse.move(curve.x, curve.y);
	await expect.poll(() => toneAt(page, curve)).toBe('hover');
	expect(await toneAt(page, offset)).toBe('rest');
	await page.mouse.down();
	await expect.poll(() => toneAt(page, curve)).toBe('active');
	await page.mouse.up();
	await expect.poll(() => toneAt(page, curve)).toBe('hover');
	await page.mouse.move(curve.x, curve.y + 150);
	await expect.poll(() => toneAt(page, curve)).toBe('rest');
});
