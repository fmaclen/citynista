import { expect, test, type Page } from '@playwright/test';
import type { GraphData } from '../src/lib/core/types';
import { check } from '../src/lib/road-model/checks';
import { attachedEnd, buildModel } from '../unit/model';
import {
	button,
	editorLook,
	expectFreshDrawing,
	graphOf,
	lane,
	liveGraph,
	nodeOf,
	openAt,
	p,
	roadsAt,
	screenAt,
	segmentOf,
	undoButton,
	walks,
	type Pt
} from './app';

// With Shift held from an anchor, draw mode keeps the line's angle over a
// road: the line runs from the start as drawn (attached at an edge, where
// the road laid shows it), and the end lands where the locked line meets
// what the snap found (a road's line, a sidewalk, the edge the snap attaches
// at, a curved edge), joined there as that snap would join it. Where the
// locked line meets a road within the ring of a node the road is drawn
// ending at, the click joins that node and cuts nothing, never another
// road's end lying by it (resolveTarget, onLockedLine, cutThere in
// modes/draw.ts).

// World to screen at `zoom`, centred on `centre`, as `openAt` opens.
const viewAt =
	(zoom: number, centre = p(0, 0)) =>
	(q: Pt) =>
		screenAt(zoom, centre)(q.x, q.y);

// Draws a straight road of `brush` from `from` (with Control when `free`:
// on open ground, whatever lies there), Shift-clicked at `to`.
async function drawLocked(
	page: Page,
	view: (p: Pt) => Pt,
	from: Pt,
	to: Pt,
	{ brush = 'Street', free = true }: { brush?: string; free?: boolean } = {}
) {
	await button(page, brush);
	await button(page, 'Straight');
	if (free) await page.keyboard.down('Control');
	await page.mouse.click(view(from).x, view(from).y);
	if (free) await page.keyboard.up('Control');
	await page.keyboard.down('Shift');
	await page.mouse.move(view(to).x, view(to).y, { steps: 4 });
	await page.mouse.click(view(to).x, view(to).y);
	await page.keyboard.up('Shift');
}

// The road just drawn: its two ends as drawn, and whether its end is
// attached at an edge.
async function drawnEnds(page: Page) {
	await expect(undoButton(page)).toBeEnabled();
	const after = await liveGraph(page);
	const drawn = after.segments.at(-1)!;
	const end = nodeOf(after, drawn.endNodeId);
	return {
		a: attachedEnd(after, drawn.id, drawn.startNodeId),
		b: attachedEnd(after, drawn.id, drawn.endNodeId),
		attached: !!end.junction?.sides?.[drawn.id]
	};
}

// A two-way street along y = 0 from x -65 to 65, 11 m wide, its sidewalks'
// middles at y = ±4.5.
const street = (): GraphData =>
	graphOf(
		[
			['w', -65, 0],
			['e', 65, 0]
		],
		[
			[
				'street',
				'w',
				'e',
				[
					lane('s0', 'pedestrian', 2),
					lane('b', 'vehicle', 3.5, 'backward'),
					lane('f', 'vehicle', 3.5, 'forward'),
					lane('s1', 'pedestrian', 2)
				]
			]
		]
	);

test.describe('the lock runs from the start as drawn to the end as drawn', () => {
	const view = viewAt(4);

	test('a street started at an edge runs at the locked angle from where it shows', async ({
		page
	}) => {
		const graph = graphOf(
			[
				['l', -65, 0],
				['r', 65, 0],
				['u', -65, -50],
				['v', 65, -50]
			],
			[
				['target', 'l', 'r'],
				['base', 'u', 'v']
			]
		);
		await openAt(page, graph, 4);
		await drawLocked(page, view, p(-49, -46.5), p(-3, -3.5), { free: false });
		const { a, b, attached } = await drawnEnds(page);
		expect(attached).toBe(true);
		// 45°: as far across as along.
		expect(b.x - a.x).toBeCloseTo(b.y - a.y, 3);
		await expectFreshDrawing(page);
	});

	test('a street locked straight onto an edge at a node ends on the locked line', async ({
		page
	}) => {
		const graph = graphOf(
			[
				['l', -65, 0],
				['j', 0, 0],
				['r', 65, 0]
			],
			[
				['target', 'l', 'j'],
				['target2', 'j', 'r']
			]
		);
		await openAt(page, graph, 4);
		await drawLocked(page, view, p(1, -32), p(0, -3.5));
		const { a, b, attached } = await drawnEnds(page);
		expect(attached).toBe(true);
		expect(b.x).toBeCloseTo(a.x, 3);
		await expectFreshDrawing(page);
	});

	test('a street attached at a curved edge ends on the locked line', async ({ page }) => {
		const graph = graphOf(
			[
				['a', -65, 0],
				['b', 65, 0]
			],
			[['main', 'a', 'b', 'street', { controlX: 0, controlY: 60 }]]
		);
		await openAt(page, graph, 4);
		await drawLocked(page, view, p(-20, -24), p(-12, 24));
		await expect.poll(async () => (await liveGraph(page)).segments.length).toBe(3);
		const after = await liveGraph(page);
		const joined = after.nodes.find((n) => n.junction?.sides)!;
		const spur = Object.keys(joined.junction!.sides!)[0];
		const from = nodeOf(after, segmentOf(after, spur).startNodeId);
		// Locked straight up from where it starts: the line x = from.x.
		expect(attachedEnd(after, spur, joined.id).x).toBeCloseTo(from.x, 3);
		await expectFreshDrawing(page);
	});
});

test.describe('the lock meeting what the snap finds', () => {
	const view = viewAt(4);

	test('a street drawn with Shift onto a road ends where the locked line meets it, joined there', async ({
		page
	}) => {
		await openAt(page, street(), 4);
		// 5 m east of straight down, on the street's line: the road's snap
		// would end it there; Shift holds it straight down.
		await drawLocked(page, view, p(0, -40), p(5, 0));
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await expect.poll(async () => (await liveGraph(page)).segments.length).toBe(3);
		const graph = await liveGraph(page);
		const end = graph.nodes.find((n) => roadsAt(graph, n.id).length === 3)!;
		expect([end.x, end.y]).toEqual([expect.closeTo(0, 3), expect.closeTo(0, 3)]);
	});

	test("a footpath drawn with Shift onto a street's sidewalk ends where the locked line meets it, joined to it", async ({
		page
	}) => {
		await openAt(page, street(), 4);
		// 3 m east of straight down, on the north sidewalk.
		await drawLocked(page, view, p(0, -40), p(3, -4.5), { brush: 'Path' });
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await expect.poll(async () => walks(await liveGraph(page)).length).toBe(1);
		const graph = await liveGraph(page);
		const end = nodeOf(graph, walks(graph)[0].endNodeId);
		expect([end.x, end.y]).toEqual([expect.closeTo(0, 3), expect.closeTo(-4.5, 3)]);
		// The connector shows it joined to the north sidewalk.
		await page.mouse.dblclick(view(end).x, view(end).y);
		await expect.poll(async () => (await editorLook(page)).joined).toEqual(['s0']);
	});

	test('with Shift held, a one-way lane drawn onto a street edge still attaches at that edge', async ({
		page
	}) => {
		// Without Shift too, to show the scene attaches unlocked.
		const view = viewAt(2);
		for (const shift of [false, true]) {
			await openAt(
				page,
				graphOf(
					[
						['a', -60, 0],
						['b', 60, 0]
					],
					[['s', 'a', 'b']]
				),
				2
			);
			await button(page, 'One-way lane');
			await button(page, 'Straight');
			const [a, b] = [view(p(0, 40)), view(p(2, 4.7))];
			await page.keyboard.down('Control');
			await page.mouse.click(a.x, a.y);
			await page.keyboard.up('Control');
			if (shift) await page.keyboard.down('Shift');
			await page.mouse.move(b.x, b.y, { steps: 4 });
			await page.mouse.click(b.x, b.y);
			if (shift) await page.keyboard.up('Shift');
			await page.keyboard.press('Escape');
			await page.keyboard.press('Escape');
			await expect.poll(async () => (await liveGraph(page)).segments.length).toBe(3);
			const graph = await liveGraph(page);
			const cut = graph.nodes.find((n) => roadsAt(graph, n.id).length === 3)!;
			expect([shift, Object.keys(cut.junction?.sides ?? {})]).toEqual([
				shift,
				[graph.segments.at(-1)!.id]
			]);
		}
	});
});

test.describe('the lock meeting a road near a node it ends at joins that node', () => {
	// Draws a street on open ground at (x, -32), Shift held to the edge of
	// the road at (0, -3.5): the lock runs straight down at x, meeting the
	// road `x` from j.
	async function lockedNear(page: Page, graph: GraphData, x: number) {
		const centre = p(x, 0);
		await openAt(page, graph, 4, centre);
		await drawLocked(page, viewAt(4, centre), p(x, -32), p(0, -3.5));
		await expect
			.poll(async () => (await liveGraph(page)).segments.length)
			.toBe(graph.segments.length + 1);
		const after = await liveGraph(page);
		expect(after.nodes.length).toBe(graph.nodes.length + 1);
		expect(after.segments.at(-1)!.endNodeId).toBe('j');
		expect(check(buildModel(after).scene)).toEqual([]);
		await expectFreshDrawing(page);
	}

	test('a taper 0.5 m off', async ({ page }) => {
		const graph = graphOf(
			[
				['l', -65, 0],
				['j', 0, 0],
				['r', 65, 0]
			],
			[
				['street', 'l', 'j'],
				['avenue', 'j', 'r', 'avenue']
			]
		);
		await lockedNear(page, graph, 0.5);
	});

	test('a dead end 0.2 m off', async ({ page }) => {
		const graph = graphOf(
			[
				['l', -65, 0],
				['j', 0, 0]
			],
			[['street', 'l', 'j']]
		);
		await lockedNear(page, graph, -0.2);
	});

	test("Shift's lock meeting a street near its node joins that node, not another street's end lying by it", async ({
		page
	}) => {
		// The lock runs straight down x = 2 to `host`'s edge, 2 m from j, where
		// `nearby` ends at q.
		const graph = graphOf(
			[
				['j', 0, 0],
				['e', 60, 0],
				['q', 2, -3.5],
				['n', -20, -26]
			],
			[
				['host', 'j', 'e'],
				['nearby', 'q', 'n']
			]
		);
		await openAt(page, graph, 4);
		await drawLocked(page, viewAt(4), p(2, -45), p(9, -3.5));
		// The road laid ends at j; crossing `nearby` on the way it is joined to
		// it there, as a road built across another is, and q stays `nearby`'s
		// end alone.
		await expect
			.poll(async () => (await liveGraph(page)).segments.filter((s) => s.id !== 'host').length)
			.toBeGreaterThan(1);
		const after = await liveGraph(page);
		expect(roadsAt(after, 'j').filter((id) => id !== 'host')).toHaveLength(1);
		expect(roadsAt(after, 'q')).toHaveLength(1);
		await expectFreshDrawing(page);
	});
});
