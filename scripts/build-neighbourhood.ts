import { chromium, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { auditNeighbourhood, summarise } from './neighbourhood-audit';

// Builds the "Neighbourhood" example the way a person would: brushes, clicks,
// handle drags, the lane panel and the lane connector, all through the real UI
// of a running dev server. Nothing here places a node directly. Run with the
// dev server up (`bun run dev`), then:
//   bun scripts/build-neighbourhood.ts [--shots <dir>]
// It writes static/examples/neighbourhood.json.

const W = 1280;
const H = 720;
// Top-down px per metre at zoom 1: 500 m fill the 720 px viewport height.
const SCALE = H / 500;
// Each wheel notch scales zoom by this, anchored at the viewport centre.
const WHEEL = 1.12;
// Saved-camera orbit from the default view, in px of middle-drag.
const ORBIT_PX = [224.4, 100];
// Wheel notches out from there for the saved camera.
const FRAME_NOTCHES = 9;

const shotsAt = process.argv.indexOf('--shots');
const shotsDir = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
const port = process.env.PORT ?? '5173';

// GPU flags: headless software GL z-fights the tilted view in the screenshots.
const browser = await chromium.launch({
	args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.goto(`http://localhost:${port}/?topdown&model`);
await page.waitForSelector('canvas');
await page.waitForSelector('nav');

// The top-down view: the world point at the viewport centre, and wheel notches in.
const camera = { x: 0, y: 0, notches: 0 };
const pxPerMetre = () => SCALE * WHEEL ** camera.notches;
const screen = (x: number, y: number) => ({
	x: W / 2 + (x - camera.x) * pxPerMetre(),
	y: H / 2 + (y - camera.y) * pxPerMetre()
});

async function wheelTo(notches: number) {
	await page.mouse.move(W / 2, H / 2);
	while (camera.notches < notches) {
		await page.mouse.wheel(0, -100);
		camera.notches++;
	}
	while (camera.notches > notches) {
		await page.mouse.wheel(0, 100);
		camera.notches--;
	}
}

// Centre the view on (x, y) by Alt-dragging the map at zoom 1, then zoom in.
// The ?topdown camera pans 1:1 with no inertia. Pointer positions land on
// whole pixels, so every drag moves a whole number of pixels and the camera
// is tracked by what actually moved: it ends within half a pixel of (x, y).
async function view(x: number, y: number, notches = 0) {
	await wheelTo(0);
	let dx = Math.round((camera.x - x) * SCALE);
	let dy = Math.round((camera.y - y) * SCALE);
	camera.x -= dx / SCALE;
	camera.y -= dy / SCALE;
	await page.keyboard.down('Alt');
	while (dx !== 0 || dy !== 0) {
		// Short drags stay clear of the lane panel, the city bar and the toolbar.
		const sx = Math.max(-280, Math.min(280, dx));
		const sy = Math.max(-220, Math.min(220, dy));
		const start = { x: W / 2 - Math.trunc(sx / 2), y: H / 2 - Math.trunc(sy / 2) };
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + sx, start.y + sy, { steps: 8 });
		await page.mouse.up();
		dx -= sx;
		dy -= sy;
	}
	await page.keyboard.up('Alt');
	await wheelTo(notches);
}

// Edits only reach storage on Save (⌘S); wait for the unsaved marker to clear.
async function save() {
	await page.keyboard.press('ControlOrMeta+s');
	await page.getByLabel('Unsaved changes').waitFor({ state: 'detached' });
}

// --shots <dir> saves a screenshot and the graph after each stage.
async function shot(name: string) {
	if (!shotsDir) return;
	await save();
	writeFileSync(
		`${shotsDir}/${name}.json`,
		(await page.evaluate(() => localStorage.getItem('citynista-graph-v2'))) ?? ''
	);
	await page.mouse.move(W - 4, H / 2);
	await page.screenshot({ path: `${shotsDir}/${name}.png` });
}

async function click(x: number, y: number, opts: { shift?: boolean } = {}) {
	const p = screen(x, y);
	if (opts.shift) await page.keyboard.down('Shift');
	await page.mouse.click(p.x, p.y);
	if (opts.shift) await page.keyboard.up('Shift');
}

async function brush(name: string) {
	await page.getByRole('button', { name, exact: true }).click();
}

// A chain of clicks with one brush, then Escape twice (end the chain, leave
// draw mode). Free clicks land on the snapping grid; Shift would also stop a leg
// auto-curving onto the road it continues, but drops the grid snap.
async function road(name: string, points: [number, number][], opts: { shift?: boolean } = {}) {
	await brush(name);
	for (const [x, y] of points) await click(x, y, opts);
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
}

// Re-centre the view (zoom 0) on (x, y) unless it already sits in the part of
// the screen clear of the city bar, the toolbar and the lane panel. A click
// where the panel then opens would lose its mouse-up to the panel, leaving
// the road stuck to the cursor.
async function reach(x: number, y: number) {
	const p = screen(x, y);
	if (camera.notches === 0 && p.x > 40 && p.x < 760 && p.y > 110 && p.y < 610) return;
	await view(x, y);
}

async function tap(x: number, y: number, opts: { shift?: boolean } = {}) {
	await reach(x, y);
	await click(x, y, opts);
}

// A road as a chain of clicks anywhere on the map.
async function street(name: string, points: [number, number][], opts: { shift?: boolean } = {}) {
	await brush(name);
	for (const [x, y] of points) await tap(x, y, opts);
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
}
// Bend a straight road: select it at its chord midpoint (where the curvature
// handle sits) and drag the handle.
async function bend(mid: [number, number], to: [number, number]) {
	await reach(...mid);
	await selectRoad(...mid);
	await drag(mid, to);
	await deselect();
}

// Select several roads: a click, then Shift-clicks.
async function pickRoads(points: [number, number][]) {
	for (const [i, [x, y]] of points.entries()) {
		await tap(x, y, { shift: i > 0 });
		if (i === 0) await panel.waitFor();
	}
}

// Keep drags on the canvas: a release over the toolbar never reaches select
// mode, and the next mouse move keeps dragging.
async function drag(from: [number, number], to: [number, number]) {
	const a = screen(...from);
	const b = screen(...to);
	await page.mouse.move(a.x, a.y);
	await page.mouse.down();
	await page.mouse.move(b.x, b.y, { steps: 12 });
	await page.mouse.up();
}

const panel = page.locator('aside');

async function selectRoad(x: number, y: number) {
	await click(x, y);
	await panel.waitFor();
}

// The panel's own close button: Escape only deselects when focus is on the page.
async function deselect() {
	await panel.getByTitle('Close').click();
	await panel.waitFor({ state: 'hidden' });
}

async function pickOption(trigger: ReturnType<Page['locator']>, label: string) {
	await trigger.click();
	await page.getByRole('option', { name: label, exact: true }).click();
}

// Lane rows in the panel: [grip, swatch, role, material, width, dir, markings, delete].
const laneRow = (index: number) => panel.locator('[role="listitem"]').nth(index);

const DIRECTION = 'Direction of travel (relative to drawing direction)';

// Remove lanes by panel row, one after another (rows renumber as they go).
async function removeLanes(rows: number[]) {
	for (const row of rows) await laneRow(row).getByTitle('Remove lane').click();
}

// Slide the selected road (from `a` to `b`, as drawn) sideways by `by` metres
// to the right of its drawing direction, dragging its offset handle (a
// quarter of the way along) with Shift, which snaps to alignments.
async function slide(a: readonly [number, number], b: readonly [number, number], by: number) {
	const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
	const n = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
	const h = [a[0] + (b[0] - a[0]) * 0.25, a[1] + (b[1] - a[1]) * 0.25] as const;
	await page.keyboard.down('Shift');
	await drag([h[0], h[1]], [h[0] + n[0] * by, h[1] + n[1] * by]);
	await page.keyboard.up('Shift');
}

// A street left-turn pocket: a new lane dragged in beside the centre line, so
// outward from the centre it reads opposing lanes, turn lane, through lanes.
// Lanes run along the drawing direction, so an approach whose junction is at
// its start turns backward. The piece (from `a` to `b`, as drawn) is then
// slid sideways with its offset handle (Shift snaps) until the opposing side
// lines up with the road behind it: that side runs straight, and only the
// through lane moves over, over the taper.
async function pocket(
	a: readonly [number, number],
	b: readonly [number, number],
	backward = false
) {
	const at = [a[0] + (b[0] - a[0]) * 0.5, a[1] + (b[1] - a[1]) * 0.5] as const;
	// Zoomed in, so the offset handle is clear of the node rings.
	await view(at[0], at[1], 8);
	await selectRoad(...at);
	await panel.getByRole('button', { name: 'Add lane' }).click();
	const added = (await panel.locator('[role="listitem"]').count()) - 1;
	if (backward) await laneRow(added).getByTitle(DIRECTION).click();
	await laneRow(added).getByTitle('Drag to reorder').dragTo(laneRow(2));
	// 1.5 m to the right of the drawing direction (left for a backward one).
	await slide(a, b, backward ? -1.6 : 1.6);
	await deselect();
}

// Select the avenue pieces whose both ends lie between two x positions: a
// marquee from open ground beside the avenue. Short pieces sit entirely inside
// their end nodes' rings, where a click would pick the node instead.
async function selectAvenue(fromX: number, toX: number) {
	await drag([fromX, 25], [toX, -25]);
	await panel.waitFor();
}

// An avenue approach's left-turn pocket: the piece next to the junction
// narrows the 5 m grass median to 1.5 m and puts a 3.5 m turn lane beside it,
// so the through lanes run straight on. Over the taper at the piece's far
// node the median narrows and the turn lane opens off the inner through lane.
// Avenue lanes, north to south: sidewalk, grass, two westbound, the median
// (row 4), two eastbound, grass, sidewalk. An approach whose junction is at
// the piece's start carries westbound traffic, so its turn lane is backward
// and goes north of the median.
async function avenuePocket(span: readonly [number, number], westbound: boolean) {
	await selectAvenue(...span);
	await setLane(4, { width: 1.5 });
	await addLaneAt(westbound ? 4 : 5, {
		role: 'Vehicle',
		material: 'Asphalt',
		width: 3.5,
		backward: westbound
	});
	await deselect();
}

// One of the two one-way roads leaving the avenue's west end, on the line of
// the avenue carriageway it continues (offset y). It is drawn with the avenue
// brush from the far west end inward: a free click, a Shift-straight run along
// that line, then a Shift-straight leg into the avenue's end node (a 30 m
// approach, outside the node's snap ring), at the avenue's edge on its own
// side, so it carries on that half of the avenue. Zoomed in, so the neighbouring road
// 12 m away doesn't catch the snaps. A marquee takes both legs, and the lane
// panel strips the other carriageway, the grass and the sidewalk.
async function carriageway(y: number, rows: number[]) {
	await view(-680, 0, 8);
	await brush('Avenue');
	await click(-680, y);
	await view(-420, 0, 8);
	await click(-410, y, { shift: true });
	await click(-380, Math.sign(y) * 8, { shift: true });
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
	await view(-530, 0);
	await drag([-700, 20 * Math.sign(y)], [-375, -Math.sign(y)]);
	await panel.waitFor();
	await removeLanes(rows);
	await deselect();
}

// The lane panel's role and material pickers for one row.
async function setKind(index: number, role: string, material: string) {
	const triggers = laneRow(index).locator('[data-slot="select-trigger"]');
	await pickOption(triggers.nth(0), role);
	await pickOption(triggers.nth(1), material);
}

// Append a lane and drag it to a row.
async function addLaneAt(
	index: number,
	lane: { role?: string; material?: string; width: number; backward?: boolean }
) {
	await panel.getByRole('button', { name: 'Add lane' }).click();
	const added = (await panel.locator('[role="listitem"]').count()) - 1;
	if (lane.role && lane.material) await setKind(added, lane.role, lane.material);
	if (lane.backward) await laneRow(added).getByTitle(DIRECTION).click();
	await setLane(added, { width: lane.width });
	await laneRow(added).getByTitle('Drag to reorder').dragTo(laneRow(index));
}

async function setLane(index: number, edit: { material?: string; width?: number }) {
	const row = laneRow(index);
	if (edit.material)
		await pickOption(row.locator('[data-slot="select-trigger"]').nth(1), edit.material);
	if (edit.width !== undefined) {
		const input = row.locator('input[type="number"]');
		await input.fill(String(edit.width));
		await input.press('Tab');
	}
}

// ---- Plan (metres; +y is south). Every click stays clear of the city bar,
// the toolbar and the lane panel in the view it is made from.
await page.getByTitle('Toggle snapping grid').click();

// The avenue runs west to east and narrows into a street past the park.
await brush('Avenue');
await click(-380, 0);
await click(150, 0);
await brush('Street');
await click(380, 0);
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');

// Plant the avenue's median: the preset's 2 m concrete strip becomes 5 m of
// grass, the width a turn lane (3 m) and its buffer (2 m) take at a pocket.
await selectRoad(-100, 0);
await setLane(4, { material: 'Grass', width: 5 });
await deselect();
await shot('01-avenue');

// North of the avenue: a block grid. The top street is one-way eastbound.
await road('Street', [
	[-320, -90],
	[320, -90]
]);
await road('Street', [
	[-280, -180],
	[280, -180]
]);
await selectRoad(-50, -180);
await laneRow(1).getByTitle('Direction of travel (relative to drawing direction)').click();
await deselect();
for (const x of [-200, -100, 0, 100, 200]) {
	await road('Street', [
		[x, -180],
		[x, 0]
	]);
}
await shot('02-grid');

// South of the avenue: two streets, a crescent bowing south between them, and
// a park road sweeping from the crescent back up to the narrowed street.
await road('Street', [
	[0, 0],
	[0, 150]
]);
await road('Street', [
	[-200, 0],
	[-200, 130]
]);
// Shift keeps these straight so the handles below set the curves.
await road(
	'Street',
	[
		[-200, 130],
		[0, 150]
	],
	{ shift: true }
);
await road(
	'Street',
	[
		[0, 150],
		[260, 0]
	],
	{ shift: true }
);
// The curvature diamond starts at the chord midpoint. The crescent's control
// goes on the line of the west street, so the street flows into it without a
// corner; the park road's goes on the crescent's exit tangent, so the two
// carry on through their junction as one curve.
await selectRoad(-100, 140);
await drag([-100, 140], [-200, 180]);
await deselect();
await selectRoad(130, 75);
await drag([130, 75], [160, 126]);
await deselect();
await shot('03-south');

// A street from the south-west joins the avenue at a shallow angle.
await road('Street', [
	[-380, 100],
	[-290, 0]
]);
await shot('04-merge');

// A footpath crosses the park from the west residential street, over the
// x=0 street mid-block (a zebra), then curves on to meet the park road.
await road('Path', [
	[-200, 70],
	[80, 70],
	[145, 100]
]);
await shot('05-paths');

// Left-turn pockets on every approach to the avenue's two 4-way crossings and
// the grid's central crossing: cut each approach with the split tool, then edit
// the pieces in the lane panel.
await page.getByTitle('Split (click a road to cut it at that point)').click();
for (const [x, y] of [
	[-50, 0],
	[50, 0],
	[0, -45],
	[0, 35],
	[-240, 0],
	[-160, 0],
	[-200, -35],
	[-200, 40],
	[0, -130],
	[0, -60],
	[-40, -90],
	[40, -90]
] as const) {
	await click(x, y);
}
await page.keyboard.press('Escape');

// Avenue pockets: the piece between the cut and the junction.
// [marquee span over the piece, westbound approach]
const avenuePockets = [
	// Main crossing: west approach -50..0, east approach 0..50.
	[[-53, 3], false],
	[[53, -3], true],
	// West street crossing: west approach -240..-200, east approach -200..-160.
	[[-243, -197], false],
	[[-157, -203], true]
] as const;
for (const [span, westbound] of avenuePockets) await avenuePocket(span, westbound);

// Street pockets: each piece from its start to its end as drawn, and whether
// its junction is at its start.
const pockets = [
	// The main crossing's side streets.
	[[0, -45], [0, 0], false],
	[[0, 0], [0, 35], true],
	// The west residential street.
	[[-200, -35], [-200, 0], false],
	[[-200, 0], [-200, 40], true],
	// The grid's central crossing.
	[[0, -130], [0, -90], false],
	[[0, -90], [0, -60], true],
	[[-40, -90], [0, -90], false],
	[[0, -90], [40, -90], true]
] as const;
for (const [a, b, backward] of pockets) await pocket(a, b, backward);
await shot('06-pockets');

// The footpaths become a network: a downtown path runs from the top street,
// across the avenue mid-block, down to the park path; a second downtown path
// crosses it, and a spur runs from the park path down to the crescent. Drawn
// after the pockets, so the avenue crossing lands in the middle of its block
// rather than leaving no room to split the pockets around it.
await road('Path', [
	[-120, -180],
	[-120, 0],
	[-120, 70]
]);
await road('Path', [
	[-200, -60],
	[-100, -60]
]);
await road('Path', [
	[-100, 70],
	[-100, 160]
]);
await shot('07-path-network');

// West of the neighbourhood the avenue's carriageways part into a rural
// divided highway: two one-way roads of bare travel lanes, each continuing its
// avenue carriageway, whose centres sit 6 m either side of the centre line.
// Grid off for the half-metre offsets.
await page.getByTitle('Toggle snapping grid').click();
// Drawn eastward, lanes list north to south: the westbound road keeps the
// avenue's backward pair, the eastbound road its forward pair.
await carriageway(-6, [0, 0, 2, 2, 2, 2, 2]);
await carriageway(6, [0, 0, 0, 0, 0, 2, 2]);
await page.getByTitle('Toggle snapping grid').click();
await shot('08-west-split');

// A freeway along the east edge, crossing the extended street, with a
// southbound off-ramp before the crossing and an on-ramp after it.
await view(300, -150);
await brush('Highway');
await click(500, -320);
await view(300, 150);
await click(500, 280);
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
await view(300, 0);
await road('Street', [
	[380, 0],
	[640, 0]
]);
// Each ramp leaves the freeway at a shallow angle (Shift keeps it straight).
await view(400, 0);
// Each starts at the freeway's west edge, so it is attached beside the
// freeway there and leaves it along its line.
await road('Street', [
	[489, -150],
	[440, 0]
]);
await road('Street', [
	[489, 150],
	[440, 0]
]);
// Both ramps become a single 3.75 m lane; the on-ramp's runs against its
// drawing direction.
await view(420, 0);
await selectRoad(461.5, -34.5);
await click(461.5, 34.5, { shift: true });
await removeLanes([0, 0, 1]);
await setLane(0, { width: 3.75 });
await deselect();
await selectRoad(461.5, 34.5);
await laneRow(0).getByTitle(DIRECTION).click();
await deselect();
// A deceleration lane for 100 m before the off-ramp and an acceleration lane
// for 100 m after the on-ramp: split the freeway, then give each stretch a
// fourth southbound lane on the outside (the panel appends it there) and
// slide the stretch over by half a lane, so the median runs straight on and
// only the outside widens.
await view(500, -200);
await page.getByTitle('Split (click a road to cut it at that point)').click();
await click(500, -250);
await page.keyboard.press('Escape');
await selectRoad(500, -200);
await panel.getByRole('button', { name: 'Add lane' }).click();
await setLane(7, { width: 3.5 });
await slide([500, -250], [500, -150], 1.75);
await deselect();
await view(500, 200);
await page.getByTitle('Split (click a road to cut it at that point)').click();
await click(500, 250);
await page.keyboard.press('Escape');
await selectRoad(500, 200);
await panel.getByRole('button', { name: 'Add lane' }).click();
await setLane(7, { width: 3.5 });
await slide([500, 150], [500, 250], 1.75);
await deselect();
await shot('09-freeway');

// A roundabout south of the park: a ring of four one-way roads, bent into
// arcs with their handles, with a street on each arm.
await view(0, 230, 6);
await road('Street', [
	[0, 210],
	[-20, 230],
	[0, 250],
	[20, 230],
	[0, 210]
]);
await drag([-40, 190], [40, 270]);
await panel.waitFor();
// Inner lanes first, drawn counter-clockwise: two circulating lanes and an
// outer sidewalk.
await removeLanes([0]);
await laneRow(0).getByTitle(DIRECTION).click();
await setLane(0, { width: 3.5 });
await setLane(1, { width: 3.5 });
await deselect();
for (const [mid, corner] of [
	[
		[-10, 220],
		[-20, 210]
	],
	[
		[-10, 240],
		[-20, 250]
	],
	[
		[10, 240],
		[20, 250]
	],
	[
		[10, 220],
		[20, 210]
	]
] as const) {
	await selectRoad(...mid);
	await drag(mid, corner);
	await deselect();
}
// A footpath ring 30-45 m out, detached behind the verge: a square, each side
// bent outward so the four arcs meet tangent-continuous at the corners. Drawn
// before the arms, which then cross it a few metres back from the circle.
await road(
	'Path',
	[
		[30, 200],
		[-30, 200],
		[-30, 260],
		[30, 260],
		[30, 200]
	],
	{ shift: true }
);
for (const [mid, out] of [
	[
		[0, 200],
		[0, 170]
	],
	[
		[-30, 230],
		[-60, 230]
	],
	[
		[0, 260],
		[0, 290]
	],
	[
		[30, 230],
		[60, 230]
	]
] as const) {
	await selectRoad(...mid);
	await drag(mid, out);
	await deselect();
}
// Arms are straight (Shift) and aimed at the ring's centre.
for (const arm of [
	[
		[0, 150],
		[0, 210]
	],
	[
		[-20, 230],
		[-140, 230]
	],
	[
		[20, 230],
		[140, 230]
	],
	[
		[0, 250],
		[0, 310]
	]
] as [number, number][][]) {
	await road('Street', arm, { shift: true });
}
await shot('10-roundabout');

// ---- The wider town. Everything from here is drawn through helpers that
// re-centre the view on each click that would fall outside the clear part of
// the screen, so long roads can run across several views.

// The freeway runs on north and south off the map.
await street('Highway', [
	[500, -320],
	[500, -700]
]);
await street('Highway', [
	[500, 280],
	[500, 600]
]);

// A second and third arterial, both avenues with a 5 m planted median: one
// east-west across the north of downtown (it meets the freeway at grade, the
// editor has no bridges), one north-south crossing the avenue's eastern
// street and the north arterial. The north-south one is drawn through the
// existing node on the eastern street, since a crossing at an existing node is
// never split into a junction.
await street('Avenue', [
	[-560, -420],
	[760, -420]
]);
await pickRoads([
	[0, -420],
	[600, -420]
]);
await setLane(4, { material: 'Grass', width: 5 });
await deselect();
await street('Avenue', [
	[380, -680],
	[380, 0],
	[380, 640]
]);
await pickRoads([
	[380, -550],
	[380, -200],
	[380, 300]
]);
await setLane(4, { material: 'Grass', width: 5 });
await deselect();
await shot('14-arterials');

// Collectors: two-lane streets running from downtown and the south into the
// arterials, with turn pockets where they meet them.
await street('Street', [
	[-200, -180],
	[-200, -700]
]);
await street('Street', [
	[100, -180],
	[100, -680]
]);
await street('Street', [
	[-660, 380],
	[380, 380]
]);
// The diagonal street from the south-west carries on as a collector, curving
// south into the east-west one: drawn straight, then its control put on the
// diagonal's own line so the two flow into each other.
await street(
	'Street',
	[
		[-380, 100],
		[-460, 380]
	],
	{ shift: true }
);
await bend([-420, 240], [-470, 200]);
await page.getByTitle('Split (click a road to cut it at that point)').click();
for (const [x, y] of [
	[-200, -370],
	[-200, -470],
	[100, -370],
	[100, -470],
	[330, 380]
] as const) {
	await tap(x, y);
}
await page.keyboard.press('Escape');
for (const [a, b, backward] of [
	[[-200, -370], [-200, -420], false],
	[[-200, -420], [-200, -470], true],
	[[100, -370], [100, -420], false],
	[[100, -420], [100, -470], true],
	[[330, 380], [380, 380], false]
] as const) {
	await reach((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
	await pocket(a, b, backward);
}
await shot('15-collectors');

// Downtown grows north to the arterial: a cross street, a jogged crossing
// (x=-100 stops at it and carries on 30 m east), a five-way where a skewed
// street leaves for the arterial, and an alley behind the first row of blocks.
await street('Street', [
	[-280, -300],
	[380, -300]
]);
await street('Street', [
	[-100, -180],
	[-100, -300]
]);
await street('Street', [
	[-70, -300],
	[-70, -420]
]);
await street('Street', [
	[0, -180],
	[0, -420]
]);
await street('Street', [
	[200, -180],
	[200, -300]
]);
await street('Street', [
	[200, -300],
	[200, -420]
]);
// Shift: left alone, this leg would curve to continue the street below it.
await street(
	'Street',
	[
		[200, -300],
		[290, -420]
	],
	{ shift: true }
);
// The alley: the street brush without its sidewalks, two 3 m lanes.
await street('Street', [
	[-200, -240],
	[100, -240]
]);
await pickRoads([
	[-150, -240],
	[-50, -240],
	[50, -240]
]);
await removeLanes([0, 2]);
await deselect();
await street('Path', [
	[-150, -300],
	[-150, -420]
]);
await shot('16-downtown-north');

// A suburb north of the arterial. Suburban streets are drawn straight (Shift:
// left alone, each leg would curve to continue whatever road it starts from)
// and then bent with their curvature handles. Two crescents span the
// collectors, cul-de-sacs run off them, footpaths link the cul-de-sacs to the
// next crescent and to a path behind the arterial, an L-shaped street runs
// from the arterial to the west collector, and a bent street runs east to the
// north-south arterial.
await street(
	'Street',
	[
		[-200, -520],
		[100, -520]
	],
	{ shift: true }
);
await bend([-50, -520], [-50, -490]);
await street(
	'Street',
	[
		[-200, -640],
		[100, -640]
	],
	{ shift: true }
);
await bend([-50, -640], [-50, -670]);
// Where each crescent runs at x = -100 and x = 0 (a third of the way along
// either end): roads meeting it there are drawn to its middle, not its edge,
// so they meet it at a junction instead of attaching beside it.
const FIRST_CRESCENT = -520 + 40 / 3;
const SECOND_CRESCENT = -640 - 40 / 3;
// Cul-de-sacs north off the first crescent, and paths from their heads to the
// second crescent.
for (const x of [-100, 0]) {
	await street(
		'Street',
		[
			[x, FIRST_CRESCENT],
			[x, -600]
		],
		{ shift: true }
	);
	await street('Path', [
		[x, -600],
		[x, SECOND_CRESCENT]
	]);
}
// Two more cul-de-sacs north off the second crescent.
await street(
	'Street',
	[
		[-100, SECOND_CRESCENT],
		[-100, -710]
	],
	{ shift: true }
);
await street(
	'Street',
	[
		[0, SECOND_CRESCENT],
		[0, -720]
	],
	{ shift: true }
);
// The L-shaped street turns its corner on a quarter arc: a 45° leg across
// the corner, bent out to it, meets both straights tangent-on.
await street(
	'Street',
	[
		[-420, -420],
		[-420, -540],
		[-380, -580],
		[-200, -580]
	],
	{ shift: true }
);
await bend([-400, -560], [-420, -580]);
await street(
	'Street',
	[
		[-420, -500],
		[-500, -500]
	],
	{ shift: true }
);
await street(
	'Street',
	[
		[100, -600],
		[240, -600],
		[380, -600]
	],
	{ shift: true }
);
await street(
	'Street',
	[
		[240, -600],
		[240, -660]
	],
	{ shift: true }
);
await street('Path', [
	[240, -660],
	[380, -660]
]);
await street(
	'Path',
	[
		[-200, -440],
		[100, -440]
	],
	{ shift: true }
);
await street('Path', [
	[0, -440],
	[0, FIRST_CRESCENT]
]);
await shot('17-north-suburb');

// A suburb in the south-west: a U-shaped loop off the east-west collector
// whose top is two quarter arcs (45° legs bent out to their corners, meeting
// tangent-on at the apex), cul-de-sacs off the collector beside it
// and off the loop, footpaths joining their heads to the loop and the
// collector, and the roundabout's south arm carried on to the collector.
await street(
	'Street',
	[
		[-400, 380],
		[-400, 260],
		[-350, 210],
		[-300, 260],
		[-300, 380]
	],
	{ shift: true }
);
await bend([-375, 235], [-400, 210]);
await bend([-325, 235], [-300, 210]);
await street(
	'Street',
	[
		[-460, 300],
		[-420, 300]
	],
	{ shift: true }
);
await street('Path', [
	[-420, 300],
	[-400, 300]
]);
await street(
	'Street',
	[
		[-300, 320],
		[-240, 320]
	],
	{ shift: true }
);
await street('Path', [
	[-240, 320],
	[-240, 380]
]);
await street('Street', [
	[0, 310],
	[0, 380]
]);
// A small grid west of the collector: two crossing streets, a third ending on
// one of them, a cul-de-sac, and a path from its head to the rural highway's
// footpath (drawn later).
await street(
	'Street',
	[
		[-660, 240],
		[-450, 240]
	],
	{ shift: true }
);
await street(
	'Street',
	[
		[-560, 140],
		[-560, 380]
	],
	{ shift: true }
);
await street(
	'Street',
	[
		[-660, 330],
		[-560, 330]
	],
	{ shift: true }
);
await street(
	'Street',
	[
		[-610, 240],
		[-610, 160]
	],
	{ shift: true }
);
await shot('18-south-west');

// East of the freeway: an industrial street from the north arterial down to
// the end of the eastern street and on, a second one off the arterial, and a
// cross street between them.
await street('Street', [
	[640, -420],
	[640, 0],
	[640, 300]
]);
await street(
	'Street',
	[
		[740, -420],
		[740, -100]
	],
	{ shift: true }
);
await street(
	'Street',
	[
		[640, -200],
		[740, -200]
	],
	{ shift: true }
);
await shot('19-detached-paths');

// A residential band south of the east-west collector: a street parallel to
// it, three streets between them, cul-de-sacs off the back, a mid-block path
// and a footpath behind the collector's verge.
await street('Street', [
	[-280, 520],
	[380, 520]
]);
for (const x of [-200, 0, 200]) {
	await street('Street', [
		[x, 380],
		[x, 520]
	]);
}
for (const [x, end] of [
	[-100, 580],
	[100, 590],
	[280, 580]
] as const) {
	await street('Street', [
		[x, 520],
		[x, end]
	]);
}
await street('Path', [
	[-100, 580],
	[100, 590]
]);
await street('Path', [
	[280, 580],
	[380, 580]
]);
await street('Path', [
	[-100, 380],
	[-100, 520]
]);
await street(
	'Path',
	[
		[-200, 400],
		[380, 400]
	],
	{ shift: true }
);
await shot('20-south-band');

// West of downtown: a collector from the north arterial curving into the
// grid's middle street (with a pocket at the arterial), the cross street
// carried over to it, an L-shaped street out to the arterial with cul-de-sacs
// off it, and paths from their heads to the collector. The middle street's
// first 40 m are cut off and bulldozed so the collector can join it on a
// quarter arc instead of a square corner.
await page.getByTitle('Split (click a road to cut it at that point)').click();
await tap(-280, -90);
await page.keyboard.press('Escape');
await page.getByTitle('Bulldoze (click or drag to demolish)').click();
await tap(-300, -90);
await page.keyboard.press('Escape');
await street(
	'Street',
	[
		[-320, -420],
		[-320, -130],
		[-280, -90]
	],
	{ shift: true }
);
await bend([-300, -110], [-320, -90]);
await street(
	'Street',
	[
		[-280, -300],
		[-320, -300]
	],
	{ shift: true }
);
await street(
	'Street',
	[
		[-320, -200],
		[-420, -200],
		[-460, -240],
		[-460, -420]
	],
	{ shift: true }
);
await bend([-440, -220], [-460, -200]);
await street(
	'Street',
	[
		[-460, -310],
		[-380, -310]
	],
	{ shift: true }
);
await street(
	'Street',
	[
		[-390, -200],
		[-390, -120]
	],
	{ shift: true }
);
await street('Path', [
	[-380, -310],
	[-320, -310]
]);
await street('Path', [
	[-390, -120],
	[-320, -120]
]);
await page.getByTitle('Split (click a road to cut it at that point)').click();
await tap(-320, -370);
await page.keyboard.press('Escape');
await reach(-320, -395);
await pocket([-320, -420], [-320, -370], true);
// A footpath behind the verge of the rural highway, joining the junction
// where the south-west collector leaves the avenue.
await street(
	'Path',
	[
		[-660, 30],
		[-430, 30],
		[-380, 100]
	],
	{ shift: true }
);
await bend([-405, 65], [-380, 30]);
await street('Path', [
	[-610, 160],
	[-610, 30]
]);
// One more path across the park, straight from the west street to the park
// road.
await street(
	'Path',
	[
		[0, 110],
		[210, 60]
	],
	{ shift: true }
);

// East of the freeway: two more industrial dead ends and a short loop.
await street('Street', [
	[640, 200],
	[760, 200]
]);
// A short loop whose corner is a quarter arc.
await street(
	'Street',
	[
		[640, 100],
		[680, 100],
		[720, 140],
		[720, 200]
	],
	{ shift: true }
);
await bend([700, 120], [720, 100]);
// Short dead ends east off the north-south arterial, toward the freeway.
for (const y of [-560, 200, 460]) {
	await street(
		'Street',
		[
			[380, y],
			[470, y]
		],
		{ shift: true }
	);
}
// Loose ends tied up. The grid's dead-end stubs are carried on to the
// collector and the north-south arterial (double-clicking a dead end continues
// its road with the same lanes), two streets through the roundabout's side
// arms, and the footpath behind the north-south arterial.
for (const [end, to] of [
	[
		[-280, -180],
		[-320, -180]
	],
	[
		[280, -180],
		[380, -180]
	],
	[
		[320, -90],
		[380, -90]
	]
] as const) {
	await reach(...end);
	const at = screen(...end);
	await page.mouse.dblclick(at.x, at.y);
	await tap(...to, { shift: true });
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
}
await street(
	'Street',
	[
		[-140, 160],
		[-140, 230],
		[-140, 380]
	],
	{ shift: true }
);
await street(
	'Street',
	[
		[140, 100],
		[140, 230],
		[140, 380]
	],
	{ shift: true }
);
await street(
	'Path',
	[
		[400, -420],
		[400, 460]
	],
	{ shift: true }
);
// Footpaths from two dead ends that otherwise stop in open ground: the south
// band's western stub up to the collector, and the small grid's north end up
// to the rural highway's footpath.
await street(
	'Path',
	[
		[-280, 520],
		[-280, 380]
	],
	{ shift: true }
);
await street(
	'Path',
	[
		[-560, 140],
		[-560, 30]
	],
	{ shift: true }
);
await shot('21-west-and-east');

// Frame the saved camera in the normal (tilted, eased) view. Save first: the
// reload would otherwise drop every edit since the last save.
await save();
await page.goto(`http://localhost:${port}/`);
await page.waitForSelector('nav');
await shot('12-default-camera');
// Middle-drag orbits: 0.0035 rad per px. Turn north-up and ease the tilt.
await page.mouse.move(W / 2, H / 2);
await page.mouse.down({ button: 'middle' });
await page.mouse.move(W / 2 + ORBIT_PX[0], H / 2 + ORBIT_PX[1], { steps: 20 });
await page.mouse.up({ button: 'middle' });
// Zoom out until the freeway, the west roads and the roundabout all fit.
for (let i = 0; i < FRAME_NOTCHES; i++) await page.mouse.wheel(0, 100);
// Let the eased camera settle and persist before reading it back.
await page.waitForTimeout(1000);
await page.getByTitle('Toggle snapping grid').click();
await shot('13-framed');

// Write the example: the city as last saved, plus the view just framed.
const saved = await page.evaluate(() => {
	const id = localStorage.getItem('citynista:current-city');
	const city = JSON.parse(localStorage.getItem(`citynista:city:${id}`) ?? 'null');
	const camera = JSON.parse(localStorage.getItem(`citynista:cam:${id}`) ?? 'null');
	return { version: city?.version, graph: city?.graph, camera };
});
if (!saved.version || !saved.graph || !saved.camera)
	throw new Error('nothing to save: no city version, graph or camera');
writeFileSync('static/examples/neighbourhood.json', JSON.stringify(saved, null, '\t') + '\n');
// The drawing's sanity check: loops, kinks, stray ends and overlaps.
const issues = auditNeighbourhood(saved.graph);
for (const issue of issues) {
	console.log(`${issue.kind}\t(${issue.at.x}, ${issue.at.y})\t${issue.detail}`);
}
console.log('audit', summarise(issues));
console.log(
	`wrote static/examples/neighbourhood.json: ${saved.graph.nodes.length} nodes, ${saved.graph.segments.length} segments`
);

await browser.close();
if (issues.length > 0) {
	console.error(`neighbourhood audit failed: ${issues.length} issue(s)`);
	process.exit(1);
}
