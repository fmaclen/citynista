import { chromium } from '@playwright/test';

// Usage: bun scripts/shot.ts <fixture> <worldX> <worldY> <zoomSteps> <out.png>
// Pans the topdown camera so (worldX,worldY) is centered, optional wheel zoom-in steps.
const [fixture, xs, ys, zs, out] = process.argv.slice(2);
const cx = Number(xs);
const cy = Number(ys);
const zoomSteps = Number(zs ?? 0);

const W = 1280;
const H = 720;
const SCALE = 720 / 500; // px per world unit at default camera

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
const port = process.env.PORT ?? '5173';
await page.goto(`http://localhost:${port}/?fixture=${fixture}&topdown`);
await page.waitForSelector('canvas');
await page.waitForSelector('nav');
await page.waitForLoadState('networkidle');
// settle a few animation frames
await page.evaluate(
	() =>
		new Promise<void>((resolve) => {
			let n = 0;
			const tick = () => (n++ < 8 ? requestAnimationFrame(tick) : resolve());
			requestAnimationFrame(tick);
		})
);

// world (cx,cy) currently sits at screen (W/2 + cx*SCALE, H/2 - cy*SCALE); drag it to center.
const sx = W / 2 + cx * SCALE;
const sy = H / 2 + cy * SCALE;
const dx = W / 2 - sx;
const dy = H / 2 - sy;
if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
	await page.keyboard.down('Space');
	await page.mouse.move(W / 2, H / 2);
	await page.mouse.down();
	await page.mouse.move(W / 2 + dx, H / 2 + dy, { steps: 12 });
	await page.mouse.up();
	await page.keyboard.up('Space');
}
for (let i = 0; i < zoomSteps; i++) {
	await page.mouse.move(W / 2, H / 2);
	await page.mouse.wheel(0, -100);
}
// park the cursor off-canvas-content so no hover ring obscures the target
await page.mouse.move(8, 712);
await page.evaluate(
	() =>
		new Promise<void>((resolve) => {
			let n = 0;
			const tick = () => (n++ < 8 ? requestAnimationFrame(tick) : resolve());
			requestAnimationFrame(tick);
		})
);
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out} (center=${cx},${cy} zoom=${zoomSteps})`);
