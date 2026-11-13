import { expect, test, type Page } from '@playwright/test';
import { openScene } from './scenes';
import { saveCity } from './save';

// Places in e2e/scenes/junction-materials.json, by world centre.
const TEE = { x: -250, y: -100 };
const MIX = { x: 0, y: -100 };
const TIE = { x: 250, y: -100 };
const DIRT = { x: -250, y: 120 };
const BEND = { x: 0, y: 120 };

const SCALE = 720 / 500;
const toScreen = (p: { x: number; y: number }) => ({ x: 640 + p.x * SCALE, y: 360 + p.y * SCALE });

// Mean colour of the 3x3 screen pixels at a world point.
async function colourAt(page: Page, at: { x: number; y: number }) {
	const { x, y } = toScreen(at);
	const png = await page.screenshot({ clip: { x: x - 1.5, y: y - 1.5, width: 3, height: 3 } });
	return page.evaluate(async (data) => {
		const img = new Image();
		img.src = `data:image/png;base64,${data}`;
		await img.decode();
		const canvas = document.createElement('canvas');
		canvas.width = img.width;
		canvas.height = img.height;
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(img, 0, 0);
		const px = ctx.getImageData(0, 0, img.width, img.height).data;
		const sum = [0, 0, 0];
		for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += px[i + c];
		const n = px.length / 4;
		return { r: sum[0] / n, g: sum[1] / n, b: sum[2] / n };
	}, png.toString('base64'));
}

// The three paving colours, told apart: asphalt dark grey, concrete light
// grey, dirt brown.
async function pavingAt(page: Page, at: { x: number; y: number }) {
	const { r, g, b } = await colourAt(page, at);
	const grey = Math.max(r, g, b) - Math.min(r, g, b) < 15;
	if (grey && r < 90) return 'asphalt';
	if (grey && r > 130) return 'concrete';
	if (r - b > 40 && r > g) return 'dirt';
	return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

test.describe('Junction material', () => {
	test.beforeEach(async ({ page }) => {
		await openScene(page, 'junction-materials');
		await expect(page.locator('nav')).toBeVisible();
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
		const end = toScreen({ x: 60, y: -100 });
		await page.mouse.move(end.x, end.y);
		await page.mouse.down();
		await page.mouse.move(end.x, end.y + 30 * SCALE, { steps: 5 });
		await page.mouse.up();
		await saveCity(page);
		const moved = await page.evaluate(
			() =>
				JSON.parse(localStorage.getItem('citynista-graph-v2')!).nodes.find(
					(n: { id: string }) => n.id === 'mix-e'
				) as { x: number; y: number }
		);
		expect(moved.y).toBeCloseTo(-70, 0);
		await expect.poll(() => pavingAt(page, MIX)).toBe('concrete');
	});

	test('changing an arm to concrete repaves its junction', async ({ page }) => {
		// Asphalt west and east outweigh the concrete road south.
		await expect.poll(() => pavingAt(page, TEE)).toBe('asphalt');

		await page.mouse.click(toScreen({ x: -220, y: -100 }).x, toScreen({ x: -220, y: -100 }).y);
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
