import { expect, test, type Page } from '@playwright/test';
import { colourAt, openScene, liveGraph, toScreen, type Pt } from './app';
import { nodeOf } from '../unit/model';

// Places in e2e/scenes/junction-materials.json, by world centre.
const TEE = { x: -250, y: -100 };
const MIX = { x: 0, y: -100 };
const TIE = { x: 250, y: -100 };
const DIRT = { x: -250, y: 120 };
const BEND = { x: 0, y: 120 };

// The three paving colours, told apart: asphalt dark grey, concrete light
// grey, dirt brown.
async function pavingAt(page: Page, at: Pt) {
	const [r, g, b] = await colourAt(page, toScreen(at.x, at.y));
	const grey = Math.max(r, g, b) - Math.min(r, g, b) < 15;
	if (grey && r < 90) return 'asphalt';
	if (grey && r > 130) return 'concrete';
	if (r - b > 40 && r > g) return 'dirt';
	return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

test.describe('Junction material', () => {
	test.beforeEach(async ({ page }) => {
		await openScene(page, 'junction-materials');
	});

	test('a junction takes the material with the most car-lane width', async ({ page }) => {
		// Wide concrete north-south beats narrow asphalt east-west.
		await expect.poll(() => pavingAt(page, MIX)).toBe('concrete');
		// Equal widths: asphalt wins the tie.
		await expect.poll(() => pavingAt(page, TIE)).toBe('asphalt');
		// Not only asphalt and concrete: dirt roads make a dirt junction.
		await expect.poll(() => pavingAt(page, DIRT)).toBe('dirt');
		// Two roads meeting at a node follow the same rule.
		await expect.poll(() => pavingAt(page, BEND)).toBe('concrete');

		// Dragging a road end reshapes the junction but keeps its material.
		const [end, to] = [toScreen(60, -100), toScreen(60, -70)];
		await page.mouse.move(end.x, end.y);
		await page.mouse.down();
		await page.mouse.move(to.x, to.y, { steps: 5 });
		await page.mouse.up();
		expect(nodeOf(await liveGraph(page), 'mix-e').y).toBeCloseTo(-70, 0);
		await expect.poll(() => pavingAt(page, MIX)).toBe('concrete');
	});

	test('changing an arm to concrete repaves its junction', async ({ page }) => {
		// Asphalt west and east outweigh the concrete road south.
		await expect.poll(() => pavingAt(page, TEE)).toBe('asphalt');

		await page.mouse.click(toScreen(-220, -100).x, toScreen(-220, -100).y);
		const panel = page.locator('aside');
		await expect(panel).toBeVisible();
		for (const row of [0, 1]) {
			await panel.getByRole('listitem').nth(row).getByText('Asphalt').click();
			await page.getByRole('option', { name: 'Concrete' }).click();
		}
		// Deselect so the selection tint doesn't colour the road.
		await panel.getByTitle('Close').click();
		await expect.poll(() => pavingAt(page, TEE)).toBe('concrete');
	});
});
