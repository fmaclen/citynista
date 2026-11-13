import { expect, test, type Page } from '@playwright/test';
import { openScene } from './scenes';

// Setback handles on a selected node: an arrow on each road where it stops
// short of the node, which sets that road's setback alone (Shift: every
// road's), and dashed guides marking where. At 4× zoom.
const ZOOM = 4;
const PX = (720 / 500) * ZOOM;
const toScreen = (x: number, y: number) => ({ x: 640 + x * PX, y: 360 + y * PX });

type Pt = { x: number; y: number };

// Each road's first and last point in the road model the drawing runs on.
const roadEnds = (page: Page) =>
	page.evaluate(() => {
		const model = (
			window as Window & { __roadModel?: () => { roads: { id: string; points: Pt[] }[] } }
		).__roadModel?.();
		return Object.fromEntries(
			(model?.roads ?? []).map((r) => [r.id, { first: r.points[0], last: r.points.at(-1)! }])
		);
	});

async function drag(page: Page, from: Pt, to: Pt) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 8 });
	await page.mouse.up();
}

// How many screen pixels inside a box are near white: dashes of a guide, and
// little else on asphalt or ground.
async function whiteIn(page: Page, from: Pt, to: Pt) {
	const x = Math.min(from.x, to.x) - 1.5;
	const y = Math.min(from.y, to.y) - 1.5;
	const png = await page.screenshot({
		clip: { x, y, width: Math.abs(to.x - from.x) + 3, height: Math.abs(to.y - from.y) + 3 }
	});
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
		let white = 0;
		for (let i = 0; i < px.length; i += 4)
			if (px[i] > 225 && px[i + 1] > 225 && px[i + 2] > 225) white++;
		return white;
	}, png.toString('base64'));
}

// Node t of the handles scene: a narrow street (p–t) widening into an avenue
// (t–q), each set to stop 10 m short of t.
test.describe('a node of two roads', () => {
	const node = toScreen(25, 20);
	const east = toScreen(35, 20);

	test.beforeEach(async ({ page }) => {
		await openScene(page, 'handles', `topdown&model&cam=0,0,${ZOOM}`);
		await expect(page.locator('nav')).toBeVisible();
		await page.mouse.click(node.x, node.y);
		await expect.poll(async () => (await roadEnds(page)).wide?.first.x).toBeCloseTo(35, 0);
	});

	test('dragging one arrow moves only its side of the taper', async ({ page }, testInfo) => {
		await drag(page, east, toScreen(42, 20));
		await expect.poll(async () => (await roadEnds(page)).wide.first.x).toBeCloseTo(42, 0);
		expect((await roadEnds(page)).narrow.last.x).toBeCloseTo(15, 0);
		await page.mouse.move(node.x, node.y + 150);
		await page.screenshot({
			path: testInfo.outputPath('two-road-node.png'),
			clip: { x: 640 - 20 * PX, y: 360 + 5 * PX, width: 80 * PX, height: 30 * PX }
		});
	});

	test('Shift-dragging an arrow brings both sides to the same distance', async ({ page }) => {
		// One side moved alone first, so the sides differ.
		await drag(page, east, toScreen(42, 20));
		await expect.poll(async () => (await roadEnds(page)).wide.first.x).toBeCloseTo(42, 0);
		expect((await roadEnds(page)).narrow.last.x).toBeCloseTo(15, 0);

		await page.keyboard.down('Shift');
		await drag(page, toScreen(15, 20), toScreen(12, 20));
		await page.keyboard.up('Shift');
		await expect.poll(async () => (await roadEnds(page)).narrow.last.x).toBeCloseTo(12, 0);
		expect((await roadEnds(page)).wide.first.x).toBeCloseTo(38, 0);
	});

	test('Shift-dragging past the shorter side stops both sides there', async ({ page }) => {
		// Dead end q pulled in to x = 45 leaves the wide side 20 m of room,
		// the narrow side keeps 35.
		await drag(page, toScreen(60, 20), toScreen(45, 20));
		await page.mouse.click(node.x, node.y);
		await expect.poll(async () => (await roadEnds(page)).wide?.last.x).toBeCloseTo(45, 0);

		await page.keyboard.down('Shift');
		await drag(page, toScreen(15, 20), toScreen(-5, 20));
		await page.keyboard.up('Shift');
		await expect.poll(async () => (await roadEnds(page)).wide.first.x).toBeGreaterThan(40);
		const ends = await roadEnds(page);
		expect(25 - ends.narrow.last.x).toBeCloseTo(ends.wide.first.x - 25, 1);
	});
});

// Junction k of the setbacks scene: a road west–east, and one leaving south
// drawn 14 m to its right (west), so the node's ring sits off it. West stops
// 22.5 m short to clear it, east runs right in.
test.describe('a junction of three roads', () => {
	const node = toScreen(-4.67, 0);

	test.beforeEach(async ({ page }) => {
		await openScene(page, 'setbacks', `topdown&model&cam=0,0,${ZOOM}`);
		await expect(page.locator('nav')).toBeVisible();
		await expect.poll(async () => (await roadEnds(page)).ke?.first.x).toBeCloseTo(0, 0);
	});

	test("dragging a road's arrow grows the junction on it, and undo takes it back", async ({
		page
	}) => {
		await page.mouse.click(node.x, node.y);
		// The handle sits a little out from the node when the road runs in.
		await drag(page, toScreen(4, 0), toScreen(20, 0));
		await expect.poll(async () => (await roadEnds(page)).ke.first.x).toBeCloseTo(20, 0);
		expect((await roadEnds(page)).kw.first.x).toBeCloseTo(-22.5, 0);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(async () => (await roadEnds(page)).ke.first.x).toBeCloseTo(0, 0);
	});

	test('dashed guides show while the node is selected', async ({ page }, testInfo) => {
		// Across the west road where it stops; from the ring to the south road.
		const across = [toScreen(-22.5, -5), toScreen(-22.5, 5)] as const;
		const toRoad = [toScreen(-13.5, 0), toScreen(-9, 0)] as const;
		const before = [await whiteIn(page, ...across), await whiteIn(page, ...toRoad)];

		await page.mouse.click(node.x, node.y);
		await page.mouse.move(node.x, node.y + 200);
		await expect.poll(() => whiteIn(page, ...across)).toBeGreaterThan(before[0] + 40);
		expect(await whiteIn(page, ...toRoad)).toBeGreaterThan(before[1] + 20);
		await page.screenshot({
			path: testInfo.outputPath('junction.png'),
			clip: { x: 640 - 40 * PX, y: 360 - 20 * PX, width: 70 * PX, height: 45 * PX }
		});

		await page.keyboard.press('Escape');
		await expect.poll(() => whiteIn(page, ...across)).toBeLessThanOrEqual(before[0] + 5);
		expect(await whiteIn(page, ...toRoad)).toBeLessThanOrEqual(before[1] + 5);
	});
});
