import { expect, test, type Page } from '@playwright/test';
import type { GraphData } from '../src/lib/core/types';
import { STOP_ROOM } from '../src/lib/road-model/approach';
import {
	button,
	drawingOf,
	expectFreshDrawing,
	gestures,
	liveGraph,
	openAt,
	openScene,
	p,
	roadsAt,
	screenAt,
	undoButton,
	walks,
	type Pt
} from './app';

// Only building connects: a road drawn across one of its kind is joined to it
// where they cross, and a move never joins (one laying a road across another
// of its kind is refused and put back). A footpath drawn or pasted across a
// street cuts nothing and stores nothing: its crossing is paint, every car
// approach it lies on giving way behind it.

// bend-and-road: a road north to the bend node (0, 0), another on south-east
// from it, and a loose west-east road at y = 80, x -60 to 60. Opened at 2×
// zoom, centred on the bend.
const toScreen = screenAt(2);

test.describe('Roads that cross where they show', () => {
	test.beforeEach(async ({ page }) => {
		await openScene(page, 'bend-and-road', 'topdown&model&cam=0,0,2');
	});

	test("a road dragged over a node, across another's middle, or turned by its node over a node is refused and put back, nothing saved", async ({
		page
	}) => {
		const { drag } = gestures(page, 2);
		const before = await liveGraph(page);
		for (const [from, to] of [
			// The road over the bend node.
			[p(30, 80), p(30, 0)],
			// The road across the middle of the south-east one.
			[p(30, 80), p(30, -30)],
			// w (-60, 80) to e moved to (60, -80): the road runs through (0, 0).
			[p(60, 80), p(60, -80)]
		] as const) {
			await drag(from, to);
			await expect.poll(() => liveGraph(page)).toEqual(before);
			await expect(undoButton(page)).toBeDisabled();
		}
	});

	test('a road drawn straight through a node joins it', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await canvas.click({ position: toScreen(-80, 0), force: true });
		await canvas.click({ position: toScreen(80, 0), force: true });
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');

		const graph = await liveGraph(page);
		expect(roadsAt(graph, 'bend')).toHaveLength(4);
		await page.screenshot({ path: 'test-results/crossings-draw-through-node.png' });
	});

	test('a road drawn across the middle of another is joined where they cross', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await canvas.click({ position: toScreen(-30, 120), force: true });
		await canvas.click({ position: toScreen(-30, 40), force: true });
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');

		const graph = await liveGraph(page);
		const crossing = graph.nodes.find((n) => Math.hypot(n.x + 30, n.y - 80) < 0.5);
		expect(crossing).toBeDefined();
		expect(roadsAt(graph, crossing!.id)).toHaveLength(4);
	});
});

// A two-way street along y = 0 from x -65 to 65, 11 m wide, its sidewalks'
// middles at y = ±4.5. At 4×, centred on (0, 0).
const street: GraphData = {
	nodes: [
		{ id: 'w', x: -65, y: 0 },
		{ id: 'e', x: 65, y: 0 }
	],
	segments: [
		{
			id: 'street',
			startNodeId: 'w',
			endNodeId: 'e',
			lanes: [
				{
					id: 's0',
					role: 'pedestrian',
					material: 'concrete',
					width: 2,
					direction: 'bidirectional'
				},
				{ id: 'b', role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'backward' },
				{ id: 'f', role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' },
				{ id: 's1', role: 'pedestrian', material: 'concrete', width: 2, direction: 'bidirectional' }
			]
		}
	]
};
const near = screenAt(4);
const at = (p: Pt) => near(p.x, p.y);

// The give-way lines on the street, each with its middle's x.
async function giveWays(page: Page) {
	const scene = await drawingOf(page);
	return scene
		.road('street')!
		.signs.flatMap((s) => (s.kind === 'yield' ? [(s.a.x + s.b.x) / 2] : []));
}

// Draws a straight footpath from a to b, off any snap (Ctrl held).
async function drawPath(page: Page, a: Pt, b: Pt) {
	await button(page, 'Path');
	await button(page, 'Straight');
	await page.keyboard.down('Control');
	await page.mouse.click(at(a).x, at(a).y);
	await page.mouse.move(at(b).x, at(b).y, { steps: 4 });
	await page.mouse.click(at(b).x, at(b).y);
	await page.keyboard.up('Control');
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
}

// What a footpath laid across the street left: the graph as it was but for
// the footpath's own segment and two ends, none of them storing anything,
// and a give-way line each way just behind the zebra at `x` (its 2 m from
// x - 1 to x + 1).
async function expectPaint(page: Page, before: GraphData, footpaths: number, xs: number[]) {
	const graph = await liveGraph(page);
	expect(graph.segments.slice(0, before.segments.length)).toEqual(before.segments);
	expect(graph.nodes.slice(0, before.nodes.length)).toEqual(before.nodes);
	expect(walks(graph)).toHaveLength(footpaths);
	expect(graph.nodes).toHaveLength(before.nodes.length + 2 * footpaths);
	expect(graph.nodes.filter((n) => n.junction)).toEqual(before.nodes.filter((n) => n.junction));
	await expectFreshDrawing(page);
	const ways = await giveWays(page);
	expect(ways).toHaveLength(2 * xs.length);
	for (const x of xs) {
		const behind = ways.map((w) => Math.abs(w - x) - 1).filter((d) => d > 0 && d < STOP_ROOM + 1);
		expect([x, behind.length]).toEqual([x, 2]);
	}
}

test.describe('Footpaths across streets are paint', () => {
	test('a footpath drawn across a street cuts nothing, and each way gives way behind its zebra', async ({
		page
	}, testInfo) => {
		await openAt(page, street, 4);
		const before = await liveGraph(page);
		await drawPath(page, { x: 10, y: 24 }, { x: 10, y: -24 });
		await expect.poll(async () => walks(await liveGraph(page)).length).toBe(1);
		await expectPaint(page, before, 1, [10]);
		await page.mouse.move(5, 5);
		await page.screenshot({ path: testInfo.outputPath('drawn-across.png') });
	});

	test('a footpath pasted across a street cuts nothing, and each way gives way behind its zebra', async ({
		page
	}, testInfo) => {
		// Drawn beside the street, then copied and pasted across it.
		await openAt(page, street, 4);
		const before = await liveGraph(page);
		await drawPath(page, { x: -20, y: 12 }, { x: -20, y: 30 });
		await expect.poll(async () => walks(await liveGraph(page)).length).toBe(1);
		const drawn = await liveGraph(page);
		await page.mouse.click(at({ x: -20, y: 21 }).x, at({ x: -20, y: 21 }).y);
		await page.keyboard.press('ControlOrMeta+c');
		await page.keyboard.press('ControlOrMeta+v');
		const target = { x: 20, y: 0 };
		await page.mouse.move(at(target).x, at(target).y, { steps: 4 });
		await page.mouse.click(at(target).x, at(target).y);
		await expect.poll(async () => walks(await liveGraph(page)).length).toBe(2);
		const pasted = walks(await liveGraph(page))[1];
		const ys = (await liveGraph(page)).nodes
			.filter((n) => n.id === pasted.startNodeId || n.id === pasted.endNodeId)
			.map((n) => n.y);
		// Laid across the street.
		expect(Math.min(...ys)).toBeLessThan(-6);
		expect(Math.max(...ys)).toBeGreaterThan(6);
		expect((await liveGraph(page)).segments.slice(0, drawn.segments.length)).toEqual(
			drawn.segments
		);
		await expectPaint(page, before, 2, [20]);
		await page.mouse.move(5, 5);
		await page.screenshot({ path: testInfo.outputPath('pasted-across.png') });
	});
});
