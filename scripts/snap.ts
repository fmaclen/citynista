import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Headless close-ups of a graph, for checking geometry by eye. Seeds the graph
// as the current city and frames each shot with the ?cam deep-link.
//   bun scripts/snap.ts <graph.json> <out-prefix> x,y,zoom [x,y,zoom ...]
// The dev server must be running on $PORT.
const [file, prefix, ...cams] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(file, 'utf8'));
const graph = raw.graph ?? raw;
const port = process.env.PORT ?? '5173';
const base = `http://localhost:${port}`;

const browser = await chromium.launch({
	args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`${base}/robots.txt`);
await page.evaluate((graph) => {
	localStorage.clear();
	const id = 'snap';
	localStorage.setItem(
		`citynista:city:${id}`,
		JSON.stringify({ id, name: id, graph, camera: null })
	);
	localStorage.setItem('citynista:cities', JSON.stringify([{ id, name: id }]));
	localStorage.setItem('citynista:current-city', id);
}, graph);
for (const [i, cam] of cams.entries()) {
	await page.goto(`${base}/?cam=${cam}${process.env.CONNECTIONS ? '&connections' : ''}`);
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
	await page.mouse.move(640, 59);
	const out = `${prefix}-${i + 1}.png`;
	await page.screenshot({ path: out });
	console.log(`wrote ${out} cam=${cam}`);
}
await browser.close();
