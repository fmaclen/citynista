import { expect, test, type Page } from '@playwright/test';
import { openGraph } from './app';
import { readScene } from '../unit/model';

// Seen at a steep tilt, the road model's surfaces meet without a hairline of
// the ground between them: they lie in one plane, painted in layer order
// (rendering/road-renderer.ts), with no step from one to the next to see
// under.

// The screen below the horizon and above the toolbar.
const CLIP = { x: 0, y: 200, width: 1280, height: 420 };

// Of the screen in CLIP: how many pixels are asphalt, and how many are the
// ground's grass (or part grass, part paving) in thin pieces: each
// 8-connected piece of them with no 5 × 5 square of grass in it, so neither
// open ground nor the narrowing tip of it in a corner, only a crack through
// the paving. Counted in the page, which decodes the screenshot.
async function look(page: Page) {
	const png = await page.screenshot({ clip: CLIP });
	return page.evaluate(async (data) => {
		const img = new Image();
		img.src = `data:image/png;base64,${data}`;
		await img.decode();
		const [width, height] = [img.width, img.height];
		const canvas = document.createElement('canvas');
		[canvas.width, canvas.height] = [width, height];
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(img, 0, 0);
		const px = ctx.getImageData(0, 0, width, height).data;
		const rgb = (i: number) => [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]];
		const isGround = (i: number) => {
			const [r, g, b] = rgb(i);
			return g - r > 30 && g - b > 20;
		};
		const ground = (x: number, y: number) =>
			x >= 0 && y >= 0 && x < width && y < height && isGround(y * width + x);
		let asphalt = 0;
		for (let i = 0; i < width * height; i++) {
			const [r, g, b] = rgb(i);
			if (Math.max(r, g, b) - Math.min(r, g, b) < 12 && r < 90) asphalt++;
		}
		const seen = new Uint8Array(width * height);
		let hairlines = 0;
		for (let i = 0; i < width * height; i++) {
			if (seen[i] || !isGround(i)) continue;
			const piece: number[] = [];
			const stack = [i];
			seen[i] = 1;
			while (stack.length) {
				const k = stack.pop()!;
				piece.push(k);
				const [x, y] = [k % width, Math.floor(k / width)];
				for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						const n = (y + dy) * width + x + dx;
						if (ground(x + dx, y + dy) && !seen[n]) {
							seen[n] = 1;
							stack.push(n);
						}
					}
			}
			const solid = piece.some((k) => {
				const [x, y] = [k % width, Math.floor(k / width)];
				for (let dy = -2; dy <= 2; dy++)
					for (let dx = -2; dx <= 2; dx++) if (!ground(x + dx, y + dy)) return false;
				return true;
			});
			// A piece cut by the clip's edge may be open ground beyond it.
			const cut = piece.some((k) => k < width || k >= (height - 1) * width);
			if (!solid && !cut) hairlines += piece.length;
		}
		return { asphalt, hairlines };
	}, png.toString('base64'));
}

test('no hairline of ground shows between surfaces at a steep tilt', async ({ page }) => {
	// A junction of three roads with sidewalks, close in, at the steepest
	// tilt the camera allows, looking across two of them.
	await openGraph(page, readScene('setbacks'), 'model', 'setbacks', {
		zoom: 10,
		targetX: 0,
		targetZ: 0,
		azimuth: (3 * Math.PI) / 4,
		polar: (70 * Math.PI) / 180
	});
	await expect.poll(async () => (await look(page)).asphalt).toBeGreaterThan(30_000);
	expect((await look(page)).hairlines).toBe(0);
});
