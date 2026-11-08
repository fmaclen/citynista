import { chromium } from '@playwright/test';

// Precise headless screenshot. Loads an example and frames it top-down at an
// exact target/zoom via the ?cam=x,z,zoom deep-link (no localStorage hacks, no
// camera written back). Usage:
//   bun scripts/shot-cam.ts <example> <worldX> <worldY> <zoom> <out.png>
// worldX/worldY are graph coords (graph y -> camera z); zoom>1 zooms in.
const [example, xs, ys, zoomStr, out] = process.argv.slice(2);
const port = process.env.PORT ?? '5173';
const query = new URLSearchParams({
	example,
	cam: `${Number(xs)},${Number(ys)},${Number(zoomStr ?? 1)}`
});

const browser = await chromium.launch({
	args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`http://localhost:${port}/?${query}`);
await page.waitForSelector('canvas');
await page.waitForLoadState('networkidle');
await page.evaluate(
	() =>
		new Promise<void>((r) => {
			let n = 0;
			const t = () => (n++ < 14 ? requestAnimationFrame(t) : r());
			requestAnimationFrame(t);
		})
);
// Park the pointer on the city bar so nothing on the map shows hover.
await page.mouse.move(640, 59);
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out} target=${xs},${ys} zoom=${zoomStr}`);
