import { expect, test, type Page } from '@playwright/test';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { nodeOf } from '../unit/model';
import {
	editorLook,
	liveGraph,
	openGraph,
	openScene,
	roadModel,
	screenAt,
	type Pt,
	PX_PER_M
} from './app';

// Setback handles on a selected node: an arrow on each road where it stops
// short of the node, which sets that road's setback alone (Shift: every
// road's), and dashed guides marking where. At 4× zoom.
const ZOOM = 4;
const PX = PX_PER_M * ZOOM;
const toScreen = screenAt(ZOOM);

// Each road's first and last point in the road model the drawing runs on.
const roadEnds = async (page: Page) =>
	Object.fromEntries(
		((await roadModel(page))?.roads ?? []).map((r) => [
			r.id,
			{ first: r.points[0], last: r.points.at(-1)! }
		])
	);

async function drag(page: Page, from: Pt, to: Pt) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 8 });
	await page.mouse.up();
}

// Node t of the handles scene: a narrow street (p–t) widening into an avenue
// (t–q), each set to stop 10 m short of t.
test.describe('a node of two roads', () => {
	const node = toScreen(25, 20);
	const east = toScreen(35, 20);

	test.beforeEach(async ({ page }) => {
		await openScene(page, 'handles', `topdown&model&cam=0,0,${ZOOM}`);
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
		const guides = async () =>
			(await editorLook(page)).guides.map(([a, b]) =>
				[a, b].map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }))
			);
		expect(await guides()).toEqual([]);

		await page.mouse.click(node.x, node.y);
		await page.mouse.move(node.x, node.y + 200);
		// Across the west road's 11 m where it stops; from the ring out to the
		// south road, which leaves the node off its line.
		await expect.poll(guides).toContainEqual([
			{ x: -22.5, y: -5.5 },
			{ x: -22.5, y: 5.5 }
		]);
		expect((await guides()).filter(([a]) => a.x === -4.7 && a.y === 0)).toHaveLength(1);
		await page.screenshot({
			path: testInfo.outputPath('junction.png'),
			clip: { x: 640 - 40 * PX, y: 360 - 20 * PX, width: 70 * PX, height: 45 * PX }
		});

		await page.keyboard.press('Escape');
		await expect.poll(guides).toEqual([]);
	});
});

// A street from w east to a T at j (40, 0), cut at c 4 m short of j: two
// pieces with the same lanes, `a` (w–c) and `b` (c–j), one road through c
// (core/place.ts), drawn named by its first piece.
test.describe('a road cut short of a junction', () => {
	const street = () => createLanesFrom('street').map((l, i) => ({ ...l, id: `l${i}` }));
	const graph = {
		nodes: [
			{ id: 'w', x: -40, y: 0 },
			{ id: 'c', x: 36, y: 0 },
			{ id: 'j', x: 40, y: 0 },
			{ id: 'n', x: 40, y: 40 },
			{ id: 's', x: 40, y: -40 }
		],
		segments: [
			{ id: 'a', startNodeId: 'w', endNodeId: 'c', lanes: street() },
			{ id: 'b', startNodeId: 'c', endNodeId: 'j', lanes: street() },
			{ id: 'up', startNodeId: 'j', endNodeId: 'n', lanes: street() },
			{ id: 'down', startNodeId: 'j', endNodeId: 's', lanes: street() }
		]
	};

	test("its arrow moves the whole road's end, past the cut", async ({ page }) => {
		await openGraph(page, graph, `topdown&model&cam=0,0,${ZOOM}`);
		const node = toScreen(40, 0);
		await page.mouse.click(node.x, node.y);
		await expect.poll(async () => (await roadEnds(page)).a?.last.x).toBeLessThan(36);
		const end = (await roadEnds(page)).a.last.x;
		await drag(page, toScreen(end, 0), toScreen(25, 0));
		// 15 m short of j, 11 m past the cut; stored on the piece ending at j.
		await expect.poll(async () => (await roadEnds(page)).a.last.x).toBeCloseTo(25, 0);
		const setbacks = nodeOf(await liveGraph(page), 'j').junction?.setbacks ?? {};
		expect(setbacks.b).toBeCloseTo(15, 0);
	});
});
