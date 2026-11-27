import { expect, test } from '@playwright/test';
import type { GraphData } from '../src/lib/core/types';
import { check } from '../src/lib/road-model/checks';
import {
	button,
	drawingOf,
	editorLook,
	expectFreshDrawing,
	gestures,
	graphOf,
	isCar,
	liveGraph,
	openAt,
	p,
	type Pt,
	screenAt,
	shot,
	walks
} from './app';
import { PATH, STREET } from './paths';
import { expectStrips } from './strips';

// Drawing footpaths: where a click with the Path brush lands and what it
// joins. A footpath meets a street only where it is drawn: on the walkway
// under the pointer, at its curb, or across it, where the crossing is paint
// and cuts nothing; it joins footpaths it starts or ends on, cutting them
// there, and lands on a footpath node lying and showing at the spot it
// snapped to, so none is laid twice and none has no length. Each case is set
// up as a city and drawn through the page, and leaves a screenshot; the
// brush switched mid-draw, a cut's undo steps, a crossing drawn in pieces
// and the other clicks onto a footpath node are in
// unit/footpath-drawing.test.ts.

test.describe.configure({ mode: 'parallel' });

test.afterEach(async ({ page }, testInfo) => {
	await expectFreshDrawing(page);
	await shot(page, testInfo.outputPath('end.png'));
});

const street = {
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
} satisfies GraphData;

// What no drawing stores: a segment of no length, two segments joining the
// same two nodes, two nodes of one kind at one spot.
function flaws(graph: GraphData) {
	const node = new Map(graph.nodes.map((n) => [n.id, n]));
	const ends = (s: GraphData['segments'][number]) => [s.startNodeId, s.endNodeId].sort().join(' ');
	const kind = (id: string) =>
		graph.segments.some((s) => isCar(s) && (s.startNodeId === id || s.endNodeId === id));
	const length = (s: GraphData['segments'][number]) => {
		const [a, b] = [node.get(s.startNodeId)!, node.get(s.endNodeId)!];
		return Math.hypot(a.x - b.x, a.y - b.y);
	};
	return [
		...graph.segments.filter((s) => length(s) < 0.001).map((s) => `${s.id} has no length`),
		...graph.segments.flatMap((s, i) =>
			graph.segments
				.slice(i + 1)
				.filter((t) => ends(t) === ends(s))
				.map((t) => `${s.id} and ${t.id} join the same nodes`)
		),
		...graph.nodes.flatMap((a, i) =>
			graph.nodes
				.slice(i + 1)
				.filter((b) => kind(a.id) === kind(b.id) && Math.hypot(a.x - b.x, a.y - b.y) < 0.001)
				.map((b) => `${a.id} and ${b.id} lie at one spot`)
		)
	];
}

// A sidewalk spot double-clicked with the Path brush: the second click lands
// on the node the first laid, so no footpath has no length, none is laid
// twice, and no two footpath nodes lie at one spot. The other clicks onto a
// footpath node already there are in unit/footpath-drawing.test.ts.
test('a sidewalk spot double-clicked with the Path brush lays one footpath on from it, none of no length', async ({
	page
}) => {
	await openAt(page, street, 4);
	const view = screenAt(4);
	const at = (q: Pt) => view(q.x, q.y);
	await button(page, 'Path');
	await button(page, 'Straight');
	await page.mouse.dblclick(at(p(1, 2)).x, at(p(1, 2)).y);
	await page.mouse.click(at(p(17, 23)).x, at(p(17, 23)).y);
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
	const drawn = await liveGraph(page);
	expect([walks(drawn).length, flaws(drawn)]).toEqual([1, []]);
});

test.describe("a footpath started on or ended on another's line cuts it there", () => {
	test("started on another's edge, it starts on its line, cutting it there", async ({ page }) => {
		// Close enough in for a street this wide to offer its edges: clicked
		// 0.8 m off its line, inside its edge, then on into the open.
		const g = gestures(page, 10);
		await openAt(
			page,
			graphOf(
				[
					['a', -30, 0],
					['b', 30, 0]
				],
				[['old', 'a', 'b', [{ ...PATH[0], id: 'p' }]]]
			),
			10
		);
		await g.draw('Path', [p(5, 0.8), p(14, 12)], [true, false]);
		await expect.poll(async () => (await liveGraph(page)).segments.length).toBe(3);
		const graph = await liveGraph(page);
		const start = graph.nodes.find(
			(n) =>
				graph.segments.filter((s) => s.startNodeId === n.id || s.endNodeId === n.id).length === 3
		)!;
		expect([start.x, start.y]).toEqual([expect.closeTo(5, 0), expect.closeTo(0, 6)]);
		expect(graph.nodes.filter((n) => n.junction?.sides)).toEqual([]);
		await expectStrips(page);
	});

	test("ended on another's line from open ground, it cuts it into a T", async ({ page }) => {
		// A street with sidewalks, a footpath from its south sidewalk straight
		// down, and a second from open ground onto the first.
		const centre = p(5, 20);
		const g = gestures(page, 6, centre);
		await openAt(
			page,
			graphOf(
				[
					['w', -60, 0],
					['e', 60, 0]
				],
				[
					[
						'street',
						'w',
						'e',
						[
							{
								id: 's1',
								role: 'pedestrian',
								material: 'concrete',
								width: 2,
								direction: 'bidirectional'
							},
							{ id: 'b', role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'backward' },
							{ id: 'f', role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' },
							{
								id: 's2',
								role: 'pedestrian',
								material: 'concrete',
								width: 2,
								direction: 'bidirectional'
							}
						]
					]
				]
			),
			6,
			centre
		);
		await button(page, 'Path');
		await button(page, 'Straight');
		await g.click(p(10, 5.5));
		await g.click(p(10, 40));
		await page.keyboard.press('Escape');
		await g.click(p(-15, 25));
		await g.click(p(10, 25));
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		// The first path starts on the street's sidewalk, the street uncut, the
		// first path cut by the second: three footpaths at the T.
		await expect.poll(async () => (await liveGraph(page)).segments.length).toBe(4);
		const tee = (await liveGraph(page)).nodes.find(
			(n) => Math.abs(n.x - 10) < 1 && Math.abs(n.y - 25) < 1
		)!;
		expect((await drawingOf(page)).node(`walk:${tee.id}`)?.ends).toHaveLength(3);

		// The T's node dragged 9 m east and 6 m south, as far as the owner's:
		// the same node moves, its three footpaths still paved together.
		await g.drag(tee, p(tee.x + 9, tee.y + 6));
		await page.keyboard.press('Escape');
		await expect
			.poll(async () => (await liveGraph(page)).nodes.find((n) => n.id === tee.id))
			.toMatchObject({ x: expect.closeTo(tee.x + 9, 0), y: expect.closeTo(tee.y + 6, 0) });
		const dragged = await drawingOf(page);
		expect(dragged.node(`walk:${tee.id}`)?.ends).toHaveLength(3);
		expect(check(dragged)).toEqual([]);
	});
});

// Footpaths drawn into one node at (0, 0) and widened in the panel: a bend
// at two, a joint at three and four. Each node's case opens on the arms the
// one before it leaves (`laid`), widened and the third arm's lane copied.
test.describe('footpaths drawn into one node and widened in the panel', () => {
	const ZOOM = 4;
	// Arms out of the node, each 20 m long at its angle (degrees) and width.
	const ARMS = [
		{ angle: 10, width: 2 },
		{ angle: 115, width: 3.5 },
		{ angle: 200, width: 1.2 },
		{ angle: 290, width: 2.6 }
	];
	const tip = (a: (typeof ARMS)[number], r = 20) => ({
		x: Math.cos((a.angle * Math.PI) / 180) * r,
		y: Math.sin((a.angle * Math.PI) / 180) * r
	});
	// The first `count` arms as drawn: the first two as one path through the
	// node, each other from the node out; the third with two lanes.
	const laid = (count: number): GraphData => {
		if (!count) return { nodes: [], segments: [] };
		const arms = ARMS.slice(0, count);
		const lanes = (a: (typeof ARMS)[number], k: number) =>
			Array.from({ length: k === 2 ? 2 : 1 }, (_, i) => ({
				...PATH[0],
				id: `p${k}-${i}`,
				width: a.width
			}));
		return {
			nodes: [{ id: 'c', x: 0, y: 0 }, ...arms.map((a, k) => ({ id: `t${k}`, ...tip(a) }))],
			segments: arms.map((a, k) => ({
				id: `arm${k}`,
				startNodeId: k === 0 ? 't0' : 'c',
				endNodeId: k === 0 ? 'c' : `t${k}`,
				lanes: lanes(a, k)
			}))
		};
	};
	for (const count of [2, 3, 4])
		test(`${count === 2 ? 'a bend' : 'a joint'} at a node of ${count}`, async ({
			page
		}, testInfo) => {
			// Open ground, clear of every arm: a click there drops the footpath
			// the panel widened.
			const g = gestures(page, ZOOM, p(0, 0), { ground: p(-40, -40) });
			await openAt(page, laid(count === 2 ? 0 : count - 1), ZOOM);
			// Selects the segment under `q` and sets its one lane's width.
			const widen = async (q: Pt, width: number) => {
				await g.click(q);
				const input = page.locator('aside').locator('input[type="number"]').first();
				await input.fill(String(width));
				await input.press('Tab');
				await page.keyboard.press('Escape');
			};
			const arms = ARMS.slice(0, count);
			if (count === 2) await g.draw('Path', [tip(arms[0]), p(0, 0), tip(arms[1])]);
			else await g.draw('Path', [p(0, 0), tip(arms[count - 1])], [true]);
			await expect.poll(async () => (await liveGraph(page)).segments.length).toBe(count);
			for (const a of count === 2 ? arms : arms.slice(-1)) await widen(tip(a, 12), a.width);
			await expect
				.poll(async () =>
					(await liveGraph(page)).segments.map((s) => s.lanes[0].width).sort((x, y) => x - y)
				)
				.toEqual(arms.map((a) => a.width).sort((x, y) => x - y));
			const { graph } = await expectStrips(page);
			expect(graph.nodes).toHaveLength(count + 1);
			if (count === 3) {
				// A second lane copied onto the arm just drawn: it widens alone,
				// the joint changing no other strip.
				await g.click(tip(arms[2], 12));
				const [arm] = (await editorLook(page)).selection.segments;
				const others = async () => {
					const scene = await drawingOf(page);
					return graph.segments
						.filter((s) => s.id !== arm)
						.map((s) => JSON.stringify(scene.road(s.id), (k, v) => (k === 'key' ? undefined : v)));
				};
				const before = await others();
				const copy = page.locator('aside').getByTitle('Copy lane');
				await expect(copy).toBeEnabled();
				await copy.click();
				await page.keyboard.press('Escape');
				await expect
					.poll(
						async () => (await liveGraph(page)).segments.find((s) => s.id === arm)?.lanes.length
					)
					.toBe(2);
				await expectStrips(page);
				expect(await others()).toEqual(before);
			}
			await shot(page, testInfo.outputPath(`node-of-${count}.png`));
		});
});

test('a footpath finished on a wide sidewalk lands on that one, not on the narrow one beside it', async ({
	page
}) => {
	const g = gestures(page, 8);
	const lanes = [
		{ ...STREET[0], id: 'outer', width: 1 },
		{ ...STREET[0], id: 'inner', width: 8 },
		...STREET.slice(1)
	];
	await openAt(
		page,
		graphOf(
			[
				['a', -35, 0],
				['b', 35, 0]
			],
			[['r', 'a', 'b', lanes]]
		),
		8
	);
	await g.draw('Path', [p(0, -21), p(0, -7.6)], [false, true]);
	await expect.poll(async () => (await liveGraph(page)).segments.length).toBe(2);
	// The lanes run from -9 m: the outer sidewalk to -8, the inner to 0.
	const ends = (await liveGraph(page)).nodes.filter((x) => x.id !== 'a' && x.id !== 'b');
	expect(ends.some((x) => Math.abs(x.y + 4) < 1e-6)).toBe(true);
});

test.describe('A wide footpath sharing both nodes with a narrow one at a shallow angle', () => {
	test('drawn, keeps the drawing rules', async ({ page }) => {
		// A 10 m lead ending at r, continued as a curve to (45, 0): cut at a
		// and b, its middle bowing away from the path.
		const g = gestures(page, 4);
		const graph = graphOf(
			[
				['a', -37, 0],
				['b', 37, 0],
				['r', -45, 0],
				['start', -70, -16.667]
			],
			[
				['straight', 'a', 'b', 'path'],
				['lead', 'start', 'r', 'path']
			]
		);
		graph.segments[1].lanes[0].width = 10;
		await openAt(page, graph, 4);
		await g.dblclick(p(-45, 0));
		await button(page, 'Curve');
		await page.keyboard.down('Control');
		await g.move(p(45, 0), 4);
		await g.click(p(45, 0));
		await page.keyboard.up('Control');
		await page.keyboard.press('Escape');
		const after = await liveGraph(page);
		const ends = (id: string) => {
			const s = after.segments.find((x) => x.id === id)!;
			return [s.startNodeId, s.endNodeId];
		};
		expect(after.segments.filter((s) => ends(s.id).sort().join() === 'a,b')).toHaveLength(2);
		expect(check(await drawingOf(page))).toEqual([]);
	});
});

test('a footpath drawn to a shifted footpath’s node where it lies, not where it shows, keeps a node of its own', async ({
	page
}) => {
	// `shifted` shows 4 m off its node m; a path Ctrl-clicked onto m's spot
	// ends there on a node of its own.
	const g = gestures(page, 4);
	await openAt(
		page,
		graphOf(
			[
				['m', 0, 0],
				['far', 30, 0]
			],
			[['shifted', 'm', 'far', 'path', { offsetStart: 4, offsetEnd: 4 }]]
		),
		4
	);
	await g.draw('Path', [p(0, -20), p(0, 0)]);
	const after = await liveGraph(page);
	const drawn = after.segments.find((s) => s.id !== 'shifted')!;
	expect([drawn.startNodeId, drawn.endNodeId]).not.toContain('m');
});
