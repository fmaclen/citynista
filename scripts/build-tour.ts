import { chromium, type Locator } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// A tour of the road editor, recorded from real mouse and keyboard input
// against a running dev server, one act per piece of work:
//   1. approach controls (two Avenues crossing get signals; a badge cycles);
//      roads attached at an edge (a slip road, a split avenue);
//   2. junction crossings (switched off and on, slid along, slid past the
//      road's end, shown in the connections overlay);
//   3. a left-turn pocket: paint through the taper, a lane swap, a lane left
//      with no connection;
//   4. a right-turn lane on the kerb side;
//   5. a slid road: its node rings, and a street drawn across it;
//   6. the Neighbourhood example, and dragging one of its junctions.
// Run with the dev server up:
//   bun scripts/build-tour.ts <out-dir> [--fast]

const W = 1280;
const H = 720;
const SCALE = H / 500;
const WHEEL = 1.12;

const outDir = process.argv[2] ?? 'test-results/tour';
const fast = process.argv.includes('--fast');
const port = process.env.PORT ?? '5173';
const base = `http://localhost:${port}`;
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
// A visible pointer, and a caption line: the recording shows neither itself.
await context.addInitScript(() => {
	window.addEventListener('DOMContentLoaded', () => {
		const dot = document.createElement('div');
		dot.style.cssText =
			'position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;' +
			'background:rgba(255,64,64,0.85);border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.6);' +
			'pointer-events:none;z-index:2147483647;transition:transform 80ms;';
		document.body.appendChild(dot);
		const caption = document.createElement('div');
		caption.id = 'tour-caption';
		caption.style.cssText =
			'position:fixed;left:16px;bottom:96px;max-width:560px;padding:8px 12px;border-radius:8px;' +
			'background:rgba(0,0,0,.72);color:#fff;font:600 15px system-ui;pointer-events:none;' +
			'z-index:2147483646;';
		document.body.appendChild(caption);
		const move = (e: MouseEvent) => {
			dot.style.left = `${e.clientX}px`;
			dot.style.top = `${e.clientY}px`;
		};
		window.addEventListener('mousemove', move, true);
		window.addEventListener('dragover', move, true);
		window.addEventListener('mousedown', () => (dot.style.transform = 'scale(0.7)'), true);
		window.addEventListener('mouseup', () => (dot.style.transform = ''), true);
	});
});
const page = await context.newPage();
// A fresh, empty map.
await page.goto(`${base}/robots.txt`);
await page.evaluate(() => localStorage.clear());
await page.goto(`${base}/?topdown&model`);
await page.waitForSelector('canvas');
await page.waitForSelector('nav');

const pause = (ms: number) => page.waitForTimeout(fast ? Math.min(ms, 120) : ms);
const hold = () => pause(1800);
const say = async (text: string) => {
	await page.evaluate((t) => {
		const c = document.getElementById('tour-caption');
		if (c) c.textContent = t;
	}, text);
	await pause(1200);
};

// The top-down camera: the world point at the viewport centre, and zoom.
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
async function clickAt(x: number, y: number, shift = false) {
	await moveTo(screen(x, y));
	if (shift) await page.keyboard.down('Shift');
	await pause(200);
	await page.mouse.down();
	await page.mouse.up();
	if (shift) await page.keyboard.up('Shift');
	await pause(300);
}
async function doubleClickAt(x: number, y: number) {
	const p = screen(x, y);
	await moveTo(p);
	await pause(250);
	await page.mouse.dblclick(p.x, p.y);
	await pause(700);
}
async function dragAlong(
	from: { x: number; y: number },
	to: { x: number; y: number },
	shift = false
) {
	const a = screen(from.x, from.y);
	const b = screen(to.x, to.y);
	await moveTo(a);
	await pause(250);
	if (shift) await page.keyboard.down('Shift');
	await page.mouse.down();
	const steps = Math.max(16, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 4));
	for (let i = 1; i <= steps; i++) {
		await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
		await pause(14);
	}
	pointer = b;
	await page.mouse.up();
	if (shift) await page.keyboard.up('Shift');
	await pause(300);
}
async function zoomTo(notches: number) {
	await moveTo({ x: W / 2, y: H / 2 }, 6);
	while (camera.notches !== notches) {
		const step = camera.notches < notches ? 1 : -1;
		await page.mouse.wheel(0, step > 0 ? -100 : 100);
		camera.notches += step;
		await pause(70);
	}
	await pause(250);
}
// Pan so (x, y) sits at the viewport centre: Alt-drag the map.
async function centreOn(x: number, y: number) {
	let dx = Math.round((camera.x - x) * ppm());
	let dy = Math.round((camera.y - y) * ppm());
	camera.x -= dx / ppm();
	camera.y -= dy / ppm();
	if (dx === 0 && dy === 0) return;
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
async function view(x: number, y: number, notches: number) {
	await zoomTo(0);
	await centreOn(x, y);
	await zoomTo(notches);
}
let shot = 0;
async function still(name: string) {
	await page.screenshot({ path: join(outDir, `${String(++shot).padStart(2, '0')}-${name}.png`) });
}
async function press(locator: Locator) {
	const box = await locator.boundingBox();
	if (!box) throw new Error('not on screen');
	await moveTo({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
	await pause(200);
	await page.mouse.down();
	await page.mouse.up();
	await pause(300);
}
async function key(k: string) {
	await page.keyboard.press(k);
	await pause(250);
}
const panel = page.locator('aside');
const row = (i: number) => panel.locator('[role="listitem"]').nth(i);
async function brush(name: string) {
	await press(page.locator(`nav button[aria-label="${name}"]`));
}
async function typeWidth(i: number, width: number) {
	await press(row(i).locator('input[type="number"]'));
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type(String(width), { delay: 60 });
	await page.keyboard.press('Enter');
	await pause(250);
}
async function pickOption(i: number, select: number, label: string) {
	await press(row(i).locator('[data-slot="select-trigger"], button[role="combobox"]').nth(select));
	await press(page.getByRole('option', { name: label, exact: true }));
}
async function moveRow(from: number, to: number) {
	const a = await row(from).getByLabel('Drag to reorder').boundingBox();
	const b = await row(to).getByLabel('Drag to reorder').boundingBox();
	if (!a || !b) throw new Error('no row');
	await moveTo({ x: a.x + a.width / 2, y: a.y + a.height / 2 });
	await page.mouse.down();
	const end = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
	for (let k = 1; k <= 20; k++)
		await page.mouse.move(
			pointer.x + ((end.x - pointer.x) * k) / 20,
			pointer.y + ((end.y - pointer.y) * k) / 20
		);
	pointer = end;
	await page.mouse.up();
	await pause(350);
}

// ---- Reading the road model, to aim at lane dots and crossing handles.
type ModelRoad = {
	id: string;
	points: { x: number; y: number }[];
	stretches: { offset?: number; lanes: { id: string; width: number }[] }[];
	crossings?: { at: number; lanes: string[] }[];
};
const roads = () =>
	page.evaluate(
		() => (window as unknown as { __roadModel: () => { roads: ModelRoad[] } }).__roadModel().roads
	);
// The end of the road meeting `node` that leaves it most nearly toward
// `toward`, with its drawing direction.
async function roadEnd(node: readonly [number, number], toward: readonly [number, number]) {
	let best: {
		road: ModelRoad;
		p: { x: number; y: number };
		d: { x: number; y: number };
		start: boolean;
	} | null = null;
	let bestScore = -Infinity;
	for (const road of await roads()) {
		const pts = road.points;
		for (const start of [true, false]) {
			const p = start ? pts[0] : pts[pts.length - 1];
			if (Math.hypot(p.x - node[0], p.y - node[1]) > 45) continue;
			const q = start ? pts[1] : pts[pts.length - 2];
			const l = Math.hypot(q.x - p.x, q.y - p.y) || 1;
			const out = { x: (q.x - p.x) / l, y: (q.y - p.y) / l };
			const h = { x: toward[0] - node[0], y: toward[1] - node[1] };
			const score = (out.x * h.x + out.y * h.y) / (Math.hypot(h.x, h.y) || 1);
			if (score > bestScore) {
				bestScore = score;
				const d = start ? out : { x: -out.x, y: -out.y };
				best = { road, p, d, start };
			}
		}
	}
	if (!best) throw new Error(`no road at ${node}`);
	return best;
}
// A lane dot (middle of the lane at that road end).
async function laneDot(
	node: readonly [number, number],
	toward: readonly [number, number],
	lane: string
) {
	const { road, p, d } = await roadEnd(node, toward);
	const n = { x: -d.y, y: d.x };
	const st = road.stretches[0];
	const total = st.lanes.reduce((s, l) => s + l.width, 0);
	let x = -total / 2 + (st.offset ?? 0);
	for (const l of st.lanes) {
		if (l.id === lane)
			return { x: p.x + n.x * (x + l.width / 2), y: p.y + n.y * (x + l.width / 2) };
		x += l.width;
	}
	throw new Error(`no lane ${lane}`);
}
// The middle of the crossing on the road leaving `node` toward `toward`.
async function crossingMid(node: readonly [number, number], toward: readonly [number, number]) {
	const { road } = await roadEnd(node, toward);
	const c = road.crossings?.[0];
	if (!c) throw new Error('no crossing');
	const a = road.points[0];
	const b = road.points[road.points.length - 1];
	const l = Math.hypot(b.x - a.x, b.y - a.y);
	const off = road.stretches[0].offset ?? 0;
	const n = { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
	return {
		x: a.x + ((b.x - a.x) * c.at) / l + n.x * off,
		y: a.y + ((b.y - a.y) * c.at) / l + n.y * off
	};
}
async function connect(from: { x: number; y: number }, to: { x: number; y: number }) {
	await dragAlong(from, to);
	await pause(400);
}
// The approach badge nearest a world point.
async function badgeNear(x: number, y: number) {
	const target = screen(x, y);
	const badges = page.getByRole('button', { name: /Approach control/ });
	let best = badges.first();
	let bestD = Infinity;
	for (let i = 0; i < (await badges.count()); i++) {
		const box = await badges.nth(i).boundingBox();
		if (!box) continue;
		const d = Math.hypot(box.x + box.width / 2 - target.x, box.y + box.height / 2 - target.y);
		if (d < bestD) {
			bestD = d;
			best = badges.nth(i);
		}
	}
	return best;
}

// ---- 1. Two Avenues crossing: every approach gets signals.
await say('Two Avenues crossing');
await zoomTo(4);
await brush('Avenue');
await clickAt(-130, 0);
await clickAt(110, 0);
await key('Escape');
await clickAt(0, -100);
await clickAt(0, 100);
await key('Escape');
await key('Escape');
await view(0, 0, 13);
await hold();
await say('Busy roads crossing get signals by default: stop lines, arrows, crossings on every arm');
await still('signals');
await say('Double-click the junction: each approach has a badge; click one to change it');
await doubleClickAt(0, 0);
await hold();
await still('connector-badges');
await press(await badgeNear(20, -6));
await hold();
await press(await badgeNear(20, -6));
await hold();
await still('east-stop');
await press(await badgeNear(20, -6));
await press(await badgeNear(20, -6));
await hold();

// ---- 2. Crossings: one model everywhere.
await say('Double-click a crossing handle to switch it off (hollow), and on again');
const north = await crossingMid([0, 0], [0, -100]);
await doubleClickAt(north.x, north.y);
await hold();
await still('north-crossing-off');
await doubleClickAt(north.x, north.y);
await hold();
await say('Drag a crossing along its road: the stop line moves behind it');
const east = await crossingMid([0, 0], [110, 0]);
await dragAlong(east, { x: east.x + 9, y: east.y });
await hold();
await still('east-crossing-moved');
await say('Dragged past the end of its road, it stops at the end');
await zoomTo(9);
await centreOn(60, 0);
const east2 = await crossingMid([0, 0], [110, 0]);
await dragAlong(east2, { x: 140, y: east2.y });
await hold();
await still('east-crossing-at-end');
await dragAlong(await crossingMid([0, 0], [110, 0]), { x: east.x, y: east.y });
await key('Escape');
await view(0, 0, 11);
await say('Crossings also show in the lane connections overlay');
await press(page.locator('nav button[title="Show lane connections"]'));
await hold();
await still('connections-overlay');
await press(page.locator('nav button[title="Show lane connections"]'));

// ---- Roads attached at an edge: a slip road off a freeway, and an avenue
// that splits into two one-way roads.
await say('Start a road on the edge of another: it joins beside it, lane to lane, no turns');
await view(300, 0, 3);
await brush('Highway');
await clickAt(300, -60);
await clickAt(300, 60);
await key('Escape');
await key('Escape');
await brush('Street');
await clickAt(288.5, -30);
await clickAt(250, 40);
await key('Escape');
await key('Escape');
await say('Strip it to one lane: it peels off the kerb lane');
await clickAt(275.9, 14);
await hold();
for (const i of [0, 0, 1]) await press(row(i).getByTitle('Remove lane'));
await press(panel.getByTitle('Close'));
await view(283, -15, 10);
await hold();
await still('slip-road');
await say(
	'An avenue end, split: each one-way road starts on its own edge and carries that half on'
);
await view(300, 200, 6);
await brush('Avenue');
await clickAt(220, 200);
await clickAt(300, 200);
await key('Escape');
await key('Escape');
await brush('Avenue');
await clickAt(300, 192);
await clickAt(380, 170);
await key('Escape');
await key('Escape');
await brush('Avenue');
await clickAt(300, 208);
await clickAt(380, 230);
await key('Escape');
await key('Escape');
await say('Strip each to its own two lanes');
await clickAt(343, 193.5);
await hold();
for (const i of [0, 0, 2, 2, 2, 2, 2]) await press(row(i).getByTitle('Remove lane'));
await press(panel.getByTitle('Close'));
await clickAt(343, 206.5);
await hold();
for (const i of [0, 0, 0, 0, 0, 2, 2]) await press(row(i).getByTitle('Remove lane'));
await press(panel.getByTitle('Close'));
await view(320, 200, 9);
await hold();
await still('split');

// ---- 3. A left-turn pocket: paint through the taper.
await say('A left-turn pocket: split the approach, give the piece a turn lane, slide it over');
await view(-50, 0, 10);
await press(page.locator('nav button[title^="Split"]'));
await clickAt(-70, 0);
await key('Escape');
await clickAt(-35, -6);
await hold();
await pickOption(4, 1, 'Asphalt');
await typeWidth(4, 1.5);
await press(panel.getByRole('button', { name: 'Add lane' }));
await typeWidth(9, 3.5);
await moveRow(9, 4);
await hold();
// Slide it south so the westbound side runs straight (Shift snaps).
await dragAlong({ x: -52.5, y: 0 }, { x: -52.5, y: 1.6 }, true);
await hold();
await press(panel.getByTitle('Close'));
await view(-65, 4, 15);
await say('Through the taper: even dashes, a smooth yellow line, the kerb line all the way');
await hold();
await still('taper-paint');
await say('Swap two lanes in the connector: the kerb line stays');
await view(-70, 4, 14);
await doubleClickAt(-70, 0);
const inner = await laneDot([-70, 0], [-130, 0], 'l5');
const kerb = await laneDot([-70, 0], [-130, 0], 'l6');
const innerOut = await laneDot([-70, 0], [0, 0], 'l5');
const kerbOut = await laneDot([-70, 0], [0, 0], 'l6');
await connect(inner, innerOut);
await connect(kerb, kerbOut);
await connect(inner, kerbOut);
await connect(kerb, innerOut);
await key('Escape');
await hold();
await still('lane-swap');
await say('A lane left with no connection ends in a line across it');
await doubleClickAt(-70, 0);
await connect(await laneDot([-70, 0], [-130, 0], 'l6'), await laneDot([-70, 0], [0, 0], 'l5'));
await key('Escape');
await hold();
await still('lane-ends');
await say('Undo puts the default connections back');
for (let i = 0; i < 5; i++) await key('ControlOrMeta+z');
await hold();

// ---- 4. A right-turn lane on the kerb side.
await say('A right-turn lane: split the north approach and add a lane on the kerb side');
await view(0, -40, 10);
await press(page.locator('nav button[title^="Split"]'));
await clickAt(0, -55);
await key('Escape');
await clickAt(-6, -30);
await hold();
await press(panel.getByRole('button', { name: 'Add lane' }));
await typeWidth(9, 3.5);
await moveRow(9, 7);
await hold();
// Slide it west by half a lane so the northbound side runs straight.
await dragAlong({ x: 0, y: -41.25 }, { x: -1.8, y: -41.25 }, true);
await press(panel.getByTitle('Close'));
await view(-2, -22, 15);
await clickAt(-19, -45);
await say('The new kerb lane turns right only; the others go straight and left');
await hold();
await still('right-turn');

// ---- 5. A slid road.
await say('Select the slid pocket: its rings sit on the road you see');
await view(-35, 3, 11);
await clickAt(-35, 3);
await hold();
await still('offset-selected');
await press(panel.getByTitle('Close'));
await say('A street drawn across the slid road joins it where the road is');
await brush('Street');
await clickAt(-38, -40);
await clickAt(-38, 45);
await key('Escape');
await key('Escape');
await hold();
await still('street-across-offset');

// ---- 6. The Neighbourhood example.
await say('The Neighbourhood example, rebuilt with pockets, slides and connections');
await page.goto(`${base}/?example=neighbourhood&topdown&stats`);
await page.waitForSelector('canvas');
await page.waitForLoadState('networkidle');
camera.x = 0;
camera.y = 0;
camera.notches = 0;
await pause(1500);
await still('neighbourhood');
await view(0, 0, 10);
await say('Avenue pockets: the median narrows and the turn lane opens');
await hold();
await still('neighbourhood-pockets');
await view(500, 140, 6);
await say('The freeway on-ramp merges into an acceleration lane');
await hold();
await still('neighbourhood-ramp');
await say('Dragging a junction stays smooth on the whole map');
await view(0, -90, 8);
await dragAlong({ x: 0, y: -90 }, { x: 10, y: -84 });
await dragAlong({ x: 10, y: -84 }, { x: 0, y: -90 });
await hold();
await still('neighbourhood-drag');
await say('');

await context.close();
await browser.close();

if (!fast) {
	const [raw] = readdirSync(videoDir).filter((f) => f.endsWith('.webm'));
	const webm = join(outDir, 'tour.webm');
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
			join(outDir, 'tour.mp4')
		]);
		rmSync(webm);
	} catch {
		console.log('ffmpeg unavailable: kept the webm');
	}
}
console.log(`written to ${outDir}`);
