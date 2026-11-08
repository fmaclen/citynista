import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The road-model editor's milestone: the SW 136th St layout, built from an
// empty map with real mouse and keyboard input only, against a running dev
// server, the way a person would build it:
//   1. two Avenues crossing;
//   2. a left-turn pocket on the eastbound approach: a short segment next to
//      the junction whose median becomes a turn lane and hatching;
//   3. that segment slid sideways so the westbound side runs straight;
//   4. a gentler taper where the pocket opens;
//   5. a second left-turn lane (and the slide again);
//   6. the kerb lane made right-turn only, and the westbound left turn
//      taken away, in the junction's connections;
//   7. a mid-block crossing on the road behind the pocket, slid along it to
//      where people cross, with a refuge in the median.
// Run with the dev server up (`bun run dev`):
//   bun scripts/build-milestone.ts <out-dir> [--fast]
// It records a video (mp4 when ffmpeg is available) and close-zoom stills.

const W = 1280;
const H = 720;
// Top-down px per metre at zoom 1 (500 m fill the viewport height).
const SCALE = H / 500;
const WHEEL = 1.12;

const outDir = process.argv[2] ?? 'test-results/milestone';
const fast = process.argv.includes('--fast');
const port = process.env.PORT ?? '5173';
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const videoDir = join(outDir, 'video-raw');

const browser = await chromium.launch({
	args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
});
const context = await browser.newContext({
	viewport: { width: W, height: H },
	...(fast ? {} : { recordVideo: { dir: videoDir, size: { width: W, height: H } } })
});
// A visible pointer: the recording has no cursor of its own.
await context.addInitScript(() => {
	window.addEventListener('DOMContentLoaded', () => {
		const dot = document.createElement('div');
		dot.style.cssText =
			'position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;' +
			'background:rgba(255,64,64,0.85);border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.6);' +
			'pointer-events:none;z-index:2147483647;transition:transform 80ms;';
		document.body.appendChild(dot);
		const style = document.createElement('style');
		style.textContent = 'body.still #cursor-dot{display:none}';
		document.head.appendChild(style);
		dot.id = 'cursor-dot';
		const move = (e: MouseEvent) => {
			dot.style.left = `${e.clientX}px`;
			dot.style.top = `${e.clientY}px`;
		};
		window.addEventListener('mousemove', move, true);
		// A lane-panel row being dragged sends drag events, not mouse moves.
		window.addEventListener('dragover', move, true);
		window.addEventListener('mousedown', () => (dot.style.transform = 'scale(0.7)'), true);
		window.addEventListener('mouseup', () => (dot.style.transform = ''), true);
	});
});
const page = await context.newPage();
await page.goto(`http://localhost:${port}/?topdown&model`);
await page.waitForSelector('canvas');
await page.waitForSelector('nav');

const pause = (ms: number) => page.waitForTimeout(fast ? Math.min(ms, 150) : ms);
const hold = () => pause(2000);

// The top-down camera: the world point at the viewport centre and the zoom.
const camera = { x: 0, y: 0, notches: 0 };
const ppm = () => SCALE * WHEEL ** camera.notches;
const screen = (x: number, y: number) => ({
	x: W / 2 + (x - camera.x) * ppm(),
	y: H / 2 + (y - camera.y) * ppm()
});

let pointer = { x: W / 2, y: H / 2 };
async function moveTo(p: { x: number; y: number }, steps?: number) {
	const d = Math.hypot(p.x - pointer.x, p.y - pointer.y);
	await page.mouse.move(p.x, p.y, { steps: steps ?? Math.max(4, Math.round(d / 12)) });
	pointer = p;
}
// Shift snaps the drawing direction to whole angles, as in the editor.
async function clickAt(x: number, y: number, shift = false) {
	await moveTo(screen(x, y));
	if (shift) await page.keyboard.down('Shift');
	await pause(250);
	await page.mouse.down();
	await page.mouse.up();
	if (shift) await page.keyboard.up('Shift');
	await pause(350);
}
async function dragAlong(from: { x: number; y: number }, to: { x: number; y: number }) {
	await moveTo(screen(from.x, from.y));
	await pause(300);
	await page.mouse.down();
	const a = screen(from.x, from.y);
	const b = screen(to.x, to.y);
	const steps = Math.max(20, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 4));
	for (let i = 1; i <= steps; i++) {
		await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
		await pause(16);
	}
	pointer = b;
	await page.mouse.up();
	await pause(300);
}
async function zoomTo(notches: number) {
	await moveTo({ x: W / 2, y: H / 2 }, 6);
	while (camera.notches !== notches) {
		const step = camera.notches < notches ? 1 : -1;
		await page.mouse.wheel(0, step > 0 ? -100 : 100);
		camera.notches += step;
		await pause(90);
	}
	await pause(300);
}
// Pan so (x, y) sits at the viewport centre: Alt-drag the map.
async function centreOn(x: number, y: number) {
	let dx = Math.round((camera.x - x) * ppm());
	let dy = Math.round((camera.y - y) * ppm());
	camera.x -= dx / ppm();
	camera.y -= dy / ppm();
	await page.keyboard.down('Alt');
	while (dx !== 0 || dy !== 0) {
		const sx = Math.max(-260, Math.min(260, dx));
		const sy = Math.max(-200, Math.min(200, dy));
		const start = { x: W / 2 - Math.trunc(sx / 2), y: H / 2 - Math.trunc(sy / 2) };
		await moveTo(start, 6);
		await page.mouse.down();
		await moveTo({ x: start.x + sx, y: start.y + sy }, 14);
		await page.mouse.up();
		dx -= sx;
		dy -= sy;
	}
	await page.keyboard.up('Alt');
	await pause(200);
}
async function still(name: string) {
	// Park the pointer in a corner, out of the way of hover highlights, and
	// hide its dot for the still.
	const back = pointer;
	await moveTo({ x: 6, y: H - 6 }, 6);
	await page.evaluate(() => document.body.classList.add('still'));
	await pause(250);
	await page.screenshot({ path: join(outDir, `${name}.png`) });
	await page.evaluate(() => document.body.classList.remove('still'));
	await moveTo(back, 6);
}
async function brush(name: string) {
	const button = page.locator(`nav button[aria-label="${name}"]`);
	const box = await button.boundingBox();
	if (box) await moveTo({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
	await pause(200);
	await button.click();
	await pause(300);
}
async function key(k: string) {
	await page.keyboard.press(k);
	await pause(300);
}

// Where the pocket segment begins, and the junction it leads to.
const SPLIT = -70;
const JUNCTION = 0;
// Each Avenue arm stops this far from the junction's centre; the south arm
// further, clear of the pocket's flared south side (3.25 m of slide on a
// 30.5 m road, plus 3 m for the corner).
const MOUTH = 15;
const SOUTH_MOUTH = 21.5;

const panel = page.locator('aside');
const row = (i: number) => panel.locator('[role="listitem"]').nth(i);
async function moveOnto(locator: ReturnType<typeof page.locator>) {
	const box = await locator.boundingBox();
	if (!box) throw new Error('not on screen');
	const p = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	await moveTo(p);
	return p;
}
async function press(locator: ReturnType<typeof page.locator>) {
	await moveOnto(locator);
	await pause(200);
	await page.mouse.down();
	await page.mouse.up();
	await pause(300);
}
async function pickOption(i: number, select: number, label: string) {
	await press(row(i).locator('[data-slot="select-trigger"], button[role="combobox"]').nth(select));
	await press(page.getByRole('option', { name: label, exact: true }));
}
async function typeWidth(i: number, width: number) {
	const input = row(i).locator('input[type="number"]');
	await press(input);
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type(String(width), { delay: 80 });
	await page.keyboard.press('Enter');
	await pause(300);
}
// Drag a lane-panel row by its grip onto another row.
async function moveRow(from: number, to: number) {
	const a = await moveOnto(row(from).getByLabel('Drag to reorder'));
	const box = await row(to).getByLabel('Drag to reorder').boundingBox();
	if (!box) throw new Error('no row');
	await pause(200);
	await page.mouse.down();
	const steps = 24;
	const b = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	for (let k = 1; k <= steps; k++) {
		await page.mouse.move(a.x + ((b.x - a.x) * k) / steps, a.y + ((b.y - a.y) * k) / steps);
		await pause(25);
	}
	pointer = b;
	await page.mouse.up();
	await pause(400);
}
// Add a left-turn lane (3.5 m, eastbound) just right of the westbound lanes.
async function addTurnLane() {
	await press(panel.getByRole('button', { name: 'Add lane' }));
	const last = (await panel.locator('[role="listitem"]').count()) - 1;
	await typeWidth(last, 3.5);
	await moveRow(last, 4);
}
// Double-click a node: opens its connections.
async function doubleClickAt(x: number, y: number) {
	const p = screen(x, y);
	await moveTo(p);
	await pause(250);
	await page.mouse.dblclick(p.x, p.y);
	await pause(800);
}
async function dragBetween(from: { x: number; y: number }, to: { x: number; y: number }) {
	await dragAlong(from, to);
}

await hold();

// ---- 1. Two Avenues crossing.
await zoomTo(4);
await brush('Avenue');
await clickAt(-130, 0);
await clickAt(110, 0);
await key('Escape');
await clickAt(0, -100);
await clickAt(0, 100);
await key('Escape');
await key('Escape');
await hold();
await zoomTo(14);
await still('1-junction');

// ---- 2. The pocket: split off the eastbound approach's last 70 m, and turn
// its median into a 3.5 m left-turn lane beside 1.5 m of hatching.
await zoomTo(10);
await centreOn(-45, 0);
await press(page.locator('nav button[title^="Split"]'));
await clickAt(SPLIT, 0);
await key('Escape');
await hold();
await clickAt(-35, -6);
await hold();
await pickOption(4, 1, 'Asphalt');
await typeWidth(4, 1.5);
await addTurnLane();
await hold();
await still('2-lane-panel');
await press(panel.getByTitle('Close'));
await zoomTo(14);
await centreOn(-40, 0);
await still('2-pocket-centred');

// ---- 3. The pocket is 3 m wider than the road behind it. Slide it south
// (Shift snaps) until its westbound kerb lines up with the road's, so the
// westbound side runs straight and only the eastbound side flares out.
const handleAt = SPLIT + (JUNCTION - SPLIT) * 0.25;
await zoomTo(12);
await centreOn(handleAt + 12, 0);
await clickAt(-30, -6);
await hold();
await still('3-offset-handle');
await page.keyboard.down('Shift');
await dragAlong({ x: handleAt, y: 0 }, { x: handleAt, y: 1.6 });
await page.keyboard.up('Shift');
await hold();
await press(panel.getByTitle('Close'));
await zoomTo(14);
await centreOn(-40, 0);
await still('3-pocket-offset');

// ---- 4. The pocket opens over its default taper (6 m along per metre the
// lanes move across: 18 m here); stretch it to 30 m for a gentler flare.
await zoomTo(15);
await centreOn(SPLIT, 0);
await clickAt(SPLIT, 0);
await hold();
await still('4-taper-handles');
await dragAlong({ x: SPLIT - 9, y: 0 }, { x: SPLIT - 15, y: 0 });
await hold();
await key('Escape');
await hold();
await still('4-taper-30m');

// ---- 5. A second left-turn lane: add it in the lane panel, then slide the
// pocket again so the westbound side stays straight.
await zoomTo(12);
await centreOn(handleAt + 12, 0);
await clickAt(-30, -6);
await hold();
await addTurnLane();
await hold();
await still('5-lane-panel');
await page.keyboard.down('Shift');
await dragAlong({ x: handleAt, y: 1.5 }, { x: handleAt, y: 3.3 });
await page.keyboard.up('Shift');
await hold();
await press(panel.getByTitle('Close'));
await zoomTo(14);
await centreOn(-40, 0);
await still('5-two-turn-lanes');
await zoomTo(16);
await centreOn(SPLIT, 0);
await still('5-taper-close');

// ---- 6. The junction's connections. With 3.25 m of slide the pocket's
// eastbound lanes sit 9.25 and 12.75 m south of the line; the east arm's
// 2.75 and 6.25 m.
await zoomTo(15);
await centreOn(0, 0);
await doubleClickAt(JUNCTION, 0);
await hold();
await still('6-connector');
// The kerb lane right-turn only: take away its straight-on connection.
await dragBetween({ x: -MOUTH, y: 12.75 }, { x: MOUTH, y: 6.25 });
await hold();
await still('6-kerb-right-only-connector');
// No left turn for westbound: the inner westbound lane (2.75 m north on the
// east arm) loses its turn into the south arm's inner lane (2.75 m west).
await dragBetween({ x: MOUTH, y: -2.75 }, { x: -2.75, y: SOUTH_MOUTH });
await hold();
await still('6-no-left-connector');
await key('Escape');
await hold();
await still('6-junction-after');

// ---- 7. A mid-block crossing on the road behind the pocket, where the
// pocket's node is: drag the road's north sidewalk dot to its south one,
// then slide the crossing west along the road.
await zoomTo(13);
await centreOn(SPLIT - 18, 0);
await doubleClickAt(SPLIT, 0);
await hold();
// The road behind the pocket ends 15 m west of the node (half the taper).
await dragBetween({ x: SPLIT - 15, y: -10.5 }, { x: SPLIT - 15, y: 10.5 });
await hold();
await still('7-crossing-added');
// It lands 3 m beyond the taper: slide it 20 m further west.
await dragBetween({ x: SPLIT - 18, y: 0 }, { x: SPLIT - 38, y: 0 });
await hold();
await still('7-crossing-placed-connector');
await key('Escape');
await hold();
await zoomTo(16);
await centreOn(SPLIT - 38, 0);
await still('7-crossing');
await zoomTo(10);
await centreOn(-40, 0);
const overlay = page.locator('nav button[title="Show lane connections"]');
await press(overlay);
await hold();
await still('7-wide-connections');
await hold();

const model = await page.evaluate(() =>
	(window as Window & { __roadModel?: () => unknown }).__roadModel?.()
);
writeFileSync(join(outDir, 'road-model.json'), JSON.stringify(model, null, 1));
const graph = await page.evaluate(() =>
	(window as Window & { __graph?: () => unknown }).__graph?.()
);
writeFileSync(join(outDir, 'graph.json'), JSON.stringify(graph, null, 1));

await context.close();
await browser.close();

if (!fast) {
	const [raw] = readdirSync(videoDir).filter((f) => f.endsWith('.webm'));
	const webm = join(outDir, 'milestone.webm');
	renameSync(join(videoDir, raw), webm);
	rmSync(videoDir, { recursive: true, force: true });
	try {
		execFileSync('ffmpeg', [
			'-y',
			'-loglevel',
			'error',
			'-i',
			webm,
			'-c:v',
			'libx264',
			'-pix_fmt',
			'yuv420p',
			'-movflags',
			'+faststart',
			join(outDir, 'milestone.mp4')
		]);
		rmSync(webm);
	} catch {
		console.log('ffmpeg unavailable: kept the webm');
	}
}
console.log(`written to ${outDir}`);
