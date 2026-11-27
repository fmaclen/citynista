import { expect, test, type Page } from '@playwright/test';
import type { GraphData } from '../src/lib/core/types';
import { readScene } from '../unit/model';
import {
	button,
	editorLook,
	expectFreshDrawing,
	gestures,
	graphOf,
	liveGraph,
	nextFrame,
	nodeOf,
	openAt,
	p,
	roadsAt,
	segmentOf,
	shot,
	undoButton,
	type Pt
} from './app';

// A dead end dragged alone over a node or a road of its own kind shows the
// snap marker, and released there joins: onto a node by becoming it, onto a
// road by cutting it there, at the edge a draw's click there attaches at.
// One undo step takes it back. A drop is checked as it will lie once
// joined, its end at the snapped point, every road the join reshapes read
// however far along the roads that reaches; only the join itself and a
// crossing the two made where the press began are excused. No marker shows
// where the drop would retrace a road or meet one-way traffic head-on.

// The marker shown while a dead end is held, if any.
const marker = async (page: Page) => (await editorLook(page)).drop;

// Let go of a refused drop: everything as it was, nothing in the history.
async function putBack(page: Page, before: GraphData) {
	await page.mouse.up();
	await expect.poll(() => liveGraph(page)).toEqual(before);
	await expect(undoButton(page)).toBeDisabled();
	await expectFreshDrawing(page);
}

test.describe('a dead end dropped joins', () => {
	// `a` along y = 0 from x -60 to 60, and `b` from (20, 40) to a dead end
	// at (20, 15) above it.
	const kinds = { street: 'street', footpath: 'path' } as const;
	const graph = (kind: keyof typeof kinds) =>
		graphOf(
			[
				['a1', -60, 0],
				['a2', 60, 0],
				['b1', 20, 40],
				['b2', 20, 15]
			],
			[
				['a', 'a1', 'a2', kinds[kind]],
				['b', 'b1', 'b2', kinds[kind]]
			]
		);
	const ZOOM = 3;
	const CENTRE = p(20, 10);
	const open = (page: Page, g: GraphData) => openAt(page, g, ZOOM, CENTRE);

	// Drags b's dead end to `to`: held there, the marker stands on the target
	// at `mark`, and no crossing is refused; then lets go.
	async function dropOn(page: Page, to: Pt, mark: Pt) {
		const { move } = gestures(page, ZOOM, CENTRE);
		await move(p(20, 15));
		await page.mouse.down();
		await move(to, 10);
		await expect
			.poll(async () => {
				const drop = await marker(page);
				return drop && Math.hypot(drop.x - mark.x, drop.y - mark.y) < 0.6;
			})
			.toBe(true);
		expect((await editorLook(page)).refused).toEqual([]);
		await page.mouse.up();
	}

	for (const kind of ['street', 'footpath'] as const) {
		test(`a ${kind}'s dead end dropped on a ${kind}'s node becomes that node, one undo step`, async ({
			page
		}, testInfo) => {
			await open(page, graph(kind));
			const before = await liveGraph(page);
			await dropOn(page, p(60, 0.5), p(60, 0));
			await expect.poll(async () => (await liveGraph(page)).nodes.length).toBe(3);
			const after = await liveGraph(page);
			expect(after.nodes.map((n) => n.id)).toEqual(['a1', 'a2', 'b1']);
			expect(roadsAt(after, 'a2').sort()).toEqual(['a', 'b']);
			await expectFreshDrawing(page);
			await shot(page, testInfo.outputPath('dropped-on-node.png'));
			await page.keyboard.press('ControlOrMeta+z');
			await expect.poll(() => liveGraph(page)).toEqual(before);
			await expect(undoButton(page)).toBeDisabled();
		});

		test(`a ${kind}'s dead end dropped on a ${kind} cuts it there and joins it, one undo step`, async ({
			page
		}, testInfo) => {
			await open(page, graph(kind));
			const before = await liveGraph(page);
			await dropOn(page, p(20, 0.5), p(20, 0));
			await expect.poll(async () => (await liveGraph(page)).segments.length).toBe(3);
			const after = await liveGraph(page);
			// `a` cut in two where the marker stood, on a's line, as a draw's click
			// there cuts it: the node cut holds three roads, `b` one of them, and
			// b2 is gone into it.
			const cut = after.nodes.find((n) => roadsAt(after, n.id).length === 3)!;
			expect([cut.x, cut.y]).toEqual([expect.closeTo(20, 1), expect.closeTo(0, 6)]);
			expect(roadsAt(after, cut.id)).toContain('b');
			expect(after.nodes.map((n) => n.id)).not.toContain('b2');
			expect(after.nodes).toHaveLength(4);
			await expectFreshDrawing(page);
			await shot(page, testInfo.outputPath('dropped-on-road.png'));
			await page.keyboard.press('ControlOrMeta+z');
			await expect.poll(() => liveGraph(page)).toEqual(before);
			await expect(undoButton(page)).toBeDisabled();
		});
	}

	// Where a street's dead end joins and the edge it attaches at, as a draw
	// from its far node (20, 40) ending with a click at `to` lays them: the
	// node its road ends at, where that is, and the side stored there.
	async function joined(page: Page, road: string) {
		const graph = await liveGraph(page);
		const end = nodeOf(graph, segmentOf(graph, road).endNodeId);
		return { at: [end.x, end.y], side: end.junction?.sides?.[road], roads: roadsAt(graph, end.id) };
	}

	for (const [target, to, mark] of [
		['node', p(60, 3), p(60, 3.5)],
		['road', p(20, 3), p(20, 3.5)]
	] as const)
		test(`a street's dead end dropped at the edge of a street's ${target} attaches there as a draw's click there would`, async ({
			page
		}) => {
			await open(page, graph('street'));
			await dropOn(page, to, mark);
			await expect
				.poll(async () => (await liveGraph(page)).nodes.length)
				.toBe(target === 'node' ? 3 : 4);
			const dropped = await joined(page, 'b');
			expect(dropped.side).toBeDefined();
			await expectFreshDrawing(page);

			// The same road drawn: the street alone, a street from (20, 40) to `to`.
			const alone = graph('street');
			alone.nodes = alone.nodes.filter((n) => n.id !== 'b2');
			alone.segments = alone.segments.filter((s) => s.id !== 'b');
			await open(page, alone);
			const { view, move } = gestures(page, ZOOM, CENTRE);
			await button(page, 'Street');
			await button(page, 'Straight');
			await page.keyboard.down('Control');
			await page.mouse.click(view(p(20, 40)).x, view(p(20, 40)).y);
			await page.keyboard.up('Control');
			await move(to, 4);
			await page.mouse.click(view(to).x, view(to).y);
			await expect
				.poll(async () => (await liveGraph(page)).segments.length)
				.toBe(target === 'node' ? 2 : 3);
			const drawn = await joined(page, (await liveGraph(page)).segments.at(-1)!.id);
			expect(dropped.side).toBe(drawn.side);
			expect(dropped.at[0]).toBeCloseTo(drawn.at[0], 2);
			expect(dropped.at[1]).toBeCloseTo(drawn.at[1], 2);
			expect(dropped.roads.length).toBe(drawn.roads.length);
		});

	// The one-way lane runs out of its dead end, as one drawn from the ramp's
	// end out to (-32, 36) runs (a lane run in would meet the ramp's head-on:
	// no marker, as no draw).
	test("a dead end dropped at an attached ramp's end as drawn joins the ramp's node, attached as a draw there", async ({
		page
	}) => {
		const graph = readScene('attached-ramp');
		graph.nodes.push({ id: 'left', x: -32, y: 36 }, { id: 'tip', x: -20, y: 28 });
		graph.segments.unshift(...graphOf([], [['new', 'tip', 'left', 'lane']]).segments);
		await openAt(page, graph, 2);
		const before = await liveGraph(page);
		await gestures(page, 2).hold(p(-20, 28), p(-13.75, 1.6), async () => {
			await expect.poll(() => marker(page)).not.toBeNull();
		});
		await page.mouse.up();
		await expect
			.poll(async () => (await liveGraph(page)).nodes.length)
			.toBe(before.nodes.length - 1);
		const after = await liveGraph(page);
		expect(after.segments.map((s) => s.id).sort()).toEqual(before.segments.map((s) => s.id).sort());
		expect(roadsAt(after, 'm')).toContain('new');
		expect(Object.keys(nodeOf(after, 'm').junction?.sides ?? {})).toContain('new');
		await expectFreshDrawing(page);
	});
});

test.describe('a drop is checked as it will lie', () => {
	// `own`'s dead end at (-24, 14) held toward `j` on a north-south path at
	// x = `j`, with a `third` path north-south at x = `third`.
	const pastThird = (j: number, third: number) =>
		graphOf(
			[
				['a', -55, 0],
				['tip', -24, 14],
				['j', j, 0],
				['t', j, -40],
				['b', j, 40],
				['u', third, -25],
				['v', third, 25]
			],
			[
				['own', 'a', 'tip', 'path'],
				['north', 't', 'j', 'path'],
				['south', 'j', 'b', 'path'],
				['third', 'u', 'v', 'path']
			]
		);

	test('a path end snapped to a node past a third path is refused, and put back', async ({
		page
	}) => {
		await openAt(page, pastThird(25, 20), 1);
		const before = await liveGraph(page);
		const look = await gestures(page, 1).hold(p(-24, 14), p(17, 0));
		expect(look.drop).toEqual({ x: 25, y: 0 });
		expect(look.refused).toEqual(['own']);
		await page.mouse.up();
		await expect.poll(() => liveGraph(page)).toEqual(before);
		await expect(undoButton(page)).toBeDisabled();
	});

	test('a path end held past a third path but snapped short of it joins, one undo step', async ({
		page
	}) => {
		await openAt(page, pastThird(20, 25), 1);
		const before = await liveGraph(page);
		const look = await gestures(page, 1).hold(p(-24, 14), p(28, 0));
		expect(look.drop).toEqual({ x: 20, y: 0 });
		expect(look.refused).toEqual([]);
		await page.mouse.up();
		await expect.poll(async () => segmentOf(await liveGraph(page), 'own').endNodeId).toBe('j');
		await expectFreshDrawing(page);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => liveGraph(page)).toEqual(before);
	});

	test("a path end dropped on a curve's far end, laid across a third path only once joined there, is refused", async ({
		page
	}) => {
		const graph = graphOf(
			[
				['a', -60, 30],
				['tip', -45, 45],
				['l', -40, 10],
				['r', 40, 10],
				['u', 30, 5],
				['v', 30, 15]
			],
			[
				['own', 'a', 'tip', 'path'],
				['curve', 'l', 'r', 'path', { controlX: 0, controlY: -50 }],
				['third', 'u', 'v', 'path']
			]
		);
		await openAt(page, graph, 2);
		const before = await liveGraph(page);
		// Held there, its line passes above the third path's end; snapped to
		// the curve's end, it crosses the third path.
		const look = await gestures(page, 2).hold(p(-45, 45), p(40, 16.5));
		expect(look.drop).toEqual({ x: 40, y: 10 });
		expect(look.refused).toEqual(['own']);
		await page.mouse.up();
		await expect.poll(() => liveGraph(page)).toEqual(before);
	});

	test('a street dropped on a dead end a ramp leaves at its edge, pushing the ramp across a road, is refused', async ({
		page
	}) => {
		const graph = graphOf(
			[
				['w', -65, 0],
				['j', 0, 0],
				['r', 35, 20],
				['far', 45, 0],
				['tip', 22, -17],
				['p', 15, 10.5],
				['q', 15, 35]
			],
			[
				['host', 'w', 'j'],
				['ramp', 'j', 'r', 'lane'],
				['own', 'far', 'tip'],
				['block', 'p', 'q']
			]
		);
		nodeOf(graph, 'j').junction = { sides: { ramp: 'right' } };
		await openAt(page, graph, 3);
		const before = await liveGraph(page);
		const look = await gestures(page, 3).hold(p(22, -17), p(0, 0));
		expect(look.drop).toEqual({ x: 0, y: 0 });
		expect(look.refused).toEqual(['ramp']);
		await putBack(page, before);
	});

	test("a ramp's free end dropped on a street's end, its line to that end then crossing a lane, is refused", async ({
		page
	}) => {
		// Held 6 m short of c, inside its ring, and a metre short of the
		// street's line, so the end moved there alone lies in its width: the
		// drop joins c, and the ramp's line from j's edge to c crosses
		// `block`, which its line to the pointer passes below.
		const graph = graphOf(
			[
				['w', -65, 0],
				['j', 0, 0],
				['e', 55, 0],
				['tip', 38, 41],
				['p', 60, 18.5],
				['q', 60, 22],
				['b', 107, -25],
				['c', 107, 25]
			],
			[
				['west', 'w', 'j', 'highway'],
				['east', 'j', 'e', 'highway'],
				['ramp', 'j', 'tip', 'lane'],
				['block', 'p', 'q', 'lane'],
				['target', 'b', 'c']
			]
		);
		nodeOf(graph, 'j').junction = { sides: { ramp: 'right' } };
		segmentOf(graph, 'block').lanes[0].width = 1;
		const centre = p(35, 0);
		await openAt(page, graph, 2, centre);
		const { hold } = gestures(page, 2, centre);
		const before = await liveGraph(page);
		const look = await hold(p(38, 41), p(106, 19));
		expect(look.drop).toEqual({ x: 107, y: 25 });
		expect(look.refused).toEqual(['ramp']);
		await putBack(page, before);
		// With Shift held nothing drops: the end moved there alone crosses
		// nothing.
		await page.keyboard.down('Shift');
		const moved = await hold(p(38, 41), p(106, 19));
		expect(moved.drop).toBeNull();
		expect(moved.refused).toEqual([]);
		await page.mouse.up();
		await page.keyboard.up('Shift');
		await expect.poll(async () => nodeOf(await liveGraph(page), 'tip').y).toBeCloseTo(19, 0);
	});

	test('a street end dropped where the cut it makes swings a ramp, carried on past its far node, across a lane is refused', async ({
		page
	}) => {
		// The ramp leaves j at the host's edge and carries on through r into
		// ramp2; dropping `own` on the host cuts it, and the ramp's end at j,
		// placed against the host's halves, swings across `block`.
		const graph = graphOf(
			[
				['j', 0, 0],
				['f', 60, 0],
				['f1', 20, -50],
				['f2', 108, 60],
				['r', 17, 34],
				['r2', 26, 52],
				['far', 19, -25],
				['tip', 25, -14],
				['p', 7, 10],
				['q', 7, 14.9]
			],
			[
				['fleft', 'f1', 'f', 'highway'],
				['fright', 'f', 'f2', 'highway'],
				['host', 'j', 'f'],
				['ramp', 'j', 'r', 'lane'],
				['ramp2', 'r', 'r2', 'lane'],
				['own', 'far', 'tip'],
				['block', 'p', 'q', 'lane']
			]
		);
		nodeOf(graph, 'j').junction = { sides: { ramp: 'right' } };
		nodeOf(graph, 'f').junction = { sides: { host: 'right' } };
		segmentOf(graph, 'block').lanes[0].width = 1;
		const centre = p(24, 0);
		await openAt(page, graph, 3, centre);
		const before = await liveGraph(page);
		const look = await gestures(page, 3, centre).hold(p(25, -14), p(36.05173, -4.84139));
		expect(look.drop).not.toBeNull();
		expect(look.refused).toEqual(['ramp']);
		await putBack(page, before);
	});

	test('a dead end dropped on a road it crossed, coming to cross another, is refused', async ({
		page
	}) => {
		// `own` crosses `host` at x = -8 when the press begins; dropped on `host`
		// at x = 40 it cuts `host` and runs across `block`, which it never crossed.
		const graph = graphOf(
			[
				['a', -60, 0],
				['b', 60, 0],
				['far', -20, 30],
				['tip', 0, -20],
				['low', 20, 5],
				['high', 20, 18]
			],
			[
				['host', 'a', 'b'],
				['own', 'far', 'tip'],
				['block', 'low', 'high']
			]
		);
		await openAt(page, graph, 3);
		const before = await liveGraph(page);
		const look = await gestures(page, 3).hold(p(0, -20), p(40, 0));
		expect(look.drop).not.toBeNull();
		expect(look.refused).toEqual(['own']);
		await putBack(page, before);
	});

	test('whose crossing of the road it cuts moves along that road is refused', async ({ page }) => {
		// `own` curves through (-30, -70) and crosses `host` at x ≈ -56.5.
		// Dropped on `host` at x = 65 it cuts it there and still crosses its
		// western piece, at x ≈ -36.8, where the two never crossed.
		const graph = graphOf(
			[
				['a', -95, 0],
				['b', 95, 0],
				['far', -70, 30],
				['tip', 0, -22]
			],
			[
				['host', 'a', 'b'],
				['own', 'far', 'tip', 'street', { controlX: -30, controlY: -70 }]
			]
		);
		await openAt(page, graph, 3);
		const before = await liveGraph(page);
		const look = await gestures(page, 3).hold(p(0, -22), p(65, 0));
		expect(look.drop).not.toBeNull();
		// Both show refused: `host` is drawn anew as the pieces the cut makes.
		expect(look.refused).toEqual(['host', 'own']);
		await putBack(page, before);
	});

	test('leaving a crossing it made where it was joins', async ({ page }) => {
		// Dropped on `block` straight ahead, `own` still crosses `host` at x = 0.
		const graph = graphOf(
			[
				['a', -60, 0],
				['b', 60, 0],
				['far', 0, 30],
				['tip', 0, -20],
				['low', -40, -30],
				['high', 40, -30]
			],
			[
				['host', 'a', 'b'],
				['own', 'far', 'tip'],
				['block', 'low', 'high']
			]
		);
		await openAt(page, graph, 3);
		const look = await gestures(page, 3).hold(p(0, -20), p(0, -30));
		expect(look.drop).not.toBeNull();
		expect(look.refused).toEqual([]);
		await page.mouse.up();
		await expect.poll(async () => (await liveGraph(page)).segments.length).toBe(4);
		const after = await liveGraph(page);
		expect(after.nodes.map((n) => n.id)).not.toContain('tip');
		const own = segmentOf(after, 'own');
		expect(nodeOf(after, own.endNodeId)).toMatchObject({ x: 0, y: -30 });
		await expectFreshDrawing(page);
	});
});

test.describe('no marker shows', () => {
	test('a one-way end held over one-way traffic it would meet head-on shows no marker and does not join', async ({
		page
	}) => {
		const graph = graphOf(
			[
				['a', -60, 0],
				['b', -20, 20],
				['c', 20, 0],
				['d', 75, 0]
			],
			[
				['ab', 'a', 'b'],
				['dc', 'd', 'c']
			]
		);
		for (const s of graph.segments)
			s.lanes = s.lanes
				.filter((l) => l.role === 'vehicle')
				.slice(0, 1)
				.map((l) => ({ ...l, direction: 'forward' }));
		await openAt(page, graph, 2);
		await gestures(page, 2).hold(p(-20, 20), p(20, 0.5), async () => {
			await nextFrame(page);
			expect(await marker(page)).toBeNull();
		});
		await page.mouse.up();
		await expect.poll(async () => nodeOf(await liveGraph(page), 'b').x).toBeGreaterThan(15);
		expect((await liveGraph(page)).nodes).toHaveLength(4);
	});

	test('a dead end held over its far node, or a node its far node already leads to, shows no marker', async ({
		page
	}) => {
		const graph = graphOf(
			[
				['a', -30, 0],
				['b', -20, 35],
				['c', 40, 0]
			],
			[
				['ab', 'a', 'b'],
				['ac', 'a', 'c']
			]
		);
		await openAt(page, graph, 2);
		const before = await liveGraph(page);
		const { hold } = gestures(page, 2);
		// Over its own road's far end: no marker, and let go there it joins
		// nothing.
		await hold(p(-20, 35), p(-30, 0), async () => {
			await nextFrame(page);
			expect(await marker(page)).toBeNull();
		});
		await page.mouse.up();
		const over = await liveGraph(page);
		expect(over.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
		expect(over.segments.map((s) => s.id)).toEqual(['ab', 'ac']);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => liveGraph(page)).toEqual(before);
		// Over a node its far end's other road leads to: no marker, and it
		// moves as any end.
		await hold(p(-20, 35), p(40, 0.5), async () => {
			await nextFrame(page);
			expect(await marker(page)).toBeNull();
		});
		await page.mouse.up();
		await expect.poll(async () => nodeOf(await liveGraph(page), 'b').x).toBeGreaterThan(35);
		const after = await liveGraph(page);
		expect(after.nodes).toHaveLength(3);
		expect(roadsAt(after, 'c')).toEqual(['ac']);
	});
});
