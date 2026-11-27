import { expect, test, type Page } from '@playwright/test';
import { shownAt } from '../src/lib/core/road-line';
import type { GraphData } from '../src/lib/core/types';
import { readScene } from '../unit/model';
import {
	drawingOf,
	editorLook,
	expectFreshDrawing,
	gestures,
	graphOf,
	liveGraph,
	nodeOf,
	openAt,
	p,
	segmentOf,
	shot,
	undoButton,
	type Pt
} from './app';

// A move changes where roads are, never which nodes and segments there are,
// and may not lay a road across one of its own kind it did not cross when
// the move began: while held there the roads moved show refused, and let go
// there everything goes back, nothing saved and no undo step, the selection
// the press found given back. Every road whose shown line the move draws
// anew is read, whatever moved it (a ramp at the end of a road whose curve
// is bent), on its line as shown (shifts and all). A crossing the two made
// when the press began may stay where it was, give or take half a metre,
// but not slide along either road, and no second one may come. Across the
// other kind a move goes: a footpath over a street, or a street over a
// footpath, is drawn as a crossing and nothing is cut.

const refused = async (page: Page) => (await editorLook(page)).refused;

// Let go of a refused move: everything as it was, nothing in the history.
async function putBack(page: Page, before: GraphData) {
	await page.mouse.up();
	await expect.poll(() => liveGraph(page)).toEqual(before);
	await expect(undoButton(page)).toBeDisabled();
	await expectFreshDrawing(page);
}

test.describe('each kind of drag', () => {
	// `b` slanting from (20, 15) to (60, 35), clear of `a`, which runs along
	// y = 0 from x -60 to 100.
	const kinds = { street: 'street', footpath: 'path' } as const;
	const graph = (moved: keyof typeof kinds, under: keyof typeof kinds) =>
		graphOf(
			[
				['a1', -60, 0],
				['a2', 100, 0],
				['b1', 20, 15],
				['b2', 60, 35]
			],
			[
				['a', 'a1', 'a2', kinds[under]],
				['b', 'b1', 'b2', kinds[moved]]
			]
		);
	const ZOOM = 2;
	const CENTRE = p(30, 0);
	const open = (page: Page, moved: keyof typeof kinds, under: keyof typeof kinds) =>
		openAt(page, graph(moved, under), ZOOM, CENTRE);

	// Each kind of drag, laying `b` across `a`: its end, the road, the two
	// nodes a marquee selected, its curve's handle, its shift's handle. Each
	// runs `held` while the drag is held there, then lets go.
	type Drag = (page: Page, held: () => Promise<void>) => Promise<void>;
	const dragHeld = async (page: Page, from: Pt, to: Pt, held: () => Promise<void>) => {
		await gestures(page, ZOOM, CENTRE).hold(from, to, held);
		await page.mouse.up();
	};
	const drags: Record<string, Drag> = {
		'its node dragged': (page, held) => dragHeld(page, p(20, 15), p(20, -25), held),
		'the road dragged': (page, held) => dragHeld(page, p(40, 25), p(40, 0), held),
		'its nodes marquee-selected and dragged': async (page, held) => {
			await gestures(page, ZOOM, CENTRE).drag(p(10, 45), p(70, 10), 10);
			await dragHeld(page, p(60, 35), p(60, 10), held);
		},
		"its curve's handle dragged": async (page, held) => {
			await gestures(page, ZOOM, CENTRE).click(p(30, 20));
			await expect(page.locator('aside')).toBeVisible();
			await dragHeld(page, p(40, 25), p(40, -40), held);
		},
		"its shift's handle dragged": async (page, held) => {
			const graph = await liveGraph(page);
			const s = segmentOf(graph, 'b');
			const [a, b] = [nodeOf(graph, 'b1'), nodeOf(graph, 'b2')];
			const shifted = { ...s, offsetStart: 0, offsetEnd: 0 };
			await gestures(page, ZOOM, CENTRE).click(shownAt(shifted, a, b, 0.6).point);
			await expect(page.locator('aside')).toBeVisible();
			const { point, normal } = shownAt(shifted, a, b, 0.25);
			// 30 m toward `a`, whichever way the road's right lies: across it
			// halfway along.
			const by = normal.y < 0 ? 30 : -30;
			await dragHeld(page, point, p(point.x + normal.x * by, point.y + normal.y * by), held);
		}
	};

	for (const moved of ['street', 'footpath'] as const)
		for (const [name, drag] of Object.entries(drags))
			test(`a ${moved} laid across a ${moved} by ${name} is refused, and put back on release`, async ({
				page
			}, testInfo) => {
				await open(page, moved, moved);
				const before = await liveGraph(page);
				await expect(undoButton(page)).toBeDisabled();
				await drag(page, async () => {
					await expect.poll(() => refused(page)).toEqual(['b']);
					await page.screenshot({ path: testInfo.outputPath('refused.png') });
				});
				await expect.poll(() => refused(page)).toEqual([]);
				await expect.poll(() => liveGraph(page)).toEqual(before);
				await expect(undoButton(page)).toBeDisabled();
				await expectFreshDrawing(page);
			});

	// One drag a kind: what the other drags reach across kinds (no refusal,
	// nothing cut, a kept build drawing as a fresh one) is held in
	// unit/crossings.test.ts and unit/place.test.ts.
	const ids = (graph: GraphData) => ({
		nodes: graph.nodes.map((n) => n.id),
		segments: graph.segments.map((s) => s.id)
	});
	for (const [moved, under, name] of [
		['street', 'footpath', 'its node dragged'],
		['footpath', 'street', 'the road dragged']
	] as const)
		test(`a ${moved} laid across a ${under} by ${name} moves, and nothing is cut`, async ({
			page
		}, testInfo) => {
			await open(page, moved, under);
			const before = await liveGraph(page);
			await drags[name](page, async () => {
				await expect
					.poll(async () => JSON.stringify(await liveGraph(page)))
					.not.toBe(JSON.stringify(before));
				// Never shown refused (a tree without the refusal shows nothing).
				expect((await refused(page)) ?? []).toEqual([]);
			});
			await expect(undoButton(page)).toBeEnabled();
			const after = await liveGraph(page);
			expect(after).not.toEqual(before);
			expect(ids(after)).toEqual(ids(before));
			expect(segmentOf(after, 'a')).toEqual(segmentOf(before, 'a'));
			// Laid across it: a crossing drawn where they cross.
			await expectFreshDrawing(page);
			const scene = await drawingOf(page);
			const street = moved === 'street' ? 'b' : 'a';
			expect(
				scene.road(street)!.crossings.filter((c) => c.runs.some((r) => r.kind === 'zebra'))
			).not.toHaveLength(0);
			await shot(page, testInfo.outputPath('moved.png'));
			await page.keyboard.press('ControlOrMeta+z');
			await expect.poll(() => liveGraph(page)).toEqual(before);
		});
});

test.describe('what a move reads', () => {
	test("a road's curve bent so the ramp at its end swings across a road is refused", async ({
		page
	}) => {
		const graph = graphOf(
			[
				['w', -60, 0],
				['j', 0, 0],
				['e', 60, 0],
				['r', 30, 20],
				['p', 12, 6],
				['q', 12, 10.65]
			],
			[
				['west', 'w', 'j'],
				['east', 'j', 'e'],
				['ramp', 'j', 'r', 'lane'],
				['bar', 'p', 'q']
			]
		);
		nodeOf(graph, 'j').junction = { sides: { ramp: 'right' } };
		await openAt(page, graph, 3);
		const at = gestures(page, 3);
		await at.click(p(-35, 0));
		await expect.poll(async () => (await editorLook(page)).selection.segments).toEqual(['west']);
		const before = await liveGraph(page);
		const look = await at.hold(p(-30, 0), p(-30, 14));
		expect(look.handle?.ref.kind).toBe('curve');
		expect(look.refused).toEqual(['ramp']);
		await putBack(page, before);
	});

	test('the junction of a road shifted 14 m nudged 2 m along moves', async ({ page }) => {
		const graph = readScene('setbacks');
		// ks shows 14 m west of its line, so the nudge leaves it clear of
		// `bar`, which its line unshifted, leaning from k's new place to s,
		// would cross.
		graph.nodes.push({ id: 'p', x: 0.5, y: 10 }, { id: 'q', x: 3, y: 10 });
		graph.segments.push(...graphOf([], [['bar', 'p', 'q', 'lane']]).segments);
		// The node shows in the middle of its roads' ends: the shifted one 14 m off.
		const centre = p(-14 / 3, 0);
		await openAt(page, graph, 4, centre);
		const look = await gestures(page, 4, centre).hold(centre, p(centre.x + 2, 0));
		expect(look.selection.nodes).toEqual(['k']);
		expect(look.refused).toEqual([]);
		await page.mouse.up();
		await expect.poll(async () => nodeOf(await liveGraph(page), 'k').x).toBeGreaterThan(1.5);
		await expectFreshDrawing(page);
	});

	test('a refused drag gives back the selection the press found', async ({ page }) => {
		const graph = graphOf(
			[
				['a', -60, 0],
				['b', 60, 0],
				['c', -40, 15],
				['d', 40, 35]
			],
			[
				['a', 'a', 'b'],
				['b', 'c', 'd']
			]
		);
		await openAt(page, graph, 2);
		const at = gestures(page, 2);
		await at.click(p(-25, 0));
		await expect.poll(async () => (await editorLook(page)).selection.segments).toEqual(['a']);
		await at.hold(p(0, 25), p(0, 0), async () => {
			await expect.poll(() => refused(page)).toEqual(['b']);
		});
		await page.mouse.up();
		await expect
			.poll(async () => (await editorLook(page)).selection)
			.toEqual({ nodes: [], segments: ['a'] });
		await expect(undoButton(page)).toBeDisabled();
	});
});

test.describe('a crossing the press found', () => {
	// A street across `host`'s line at x = 0, from (0, 30) to a dead end at
	// (0, -20), and a third street lying across its way at y = -30.
	const across = () =>
		graphOf(
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
	// Presses at `from`, drags to `to` and reads what the editor shows held
	// there, before letting go.
	const dragHeld = async (page: Page, from: Pt, to: Pt) => {
		const look = await gestures(page, 3).hold(from, to);
		await page.mouse.up();
		return look;
	};

	test('sliding a crossing along the road it crosses is refused', async ({ page }) => {
		await openAt(page, across(), 3);
		const before = await liveGraph(page);
		const look = await dragHeld(page, p(0, 15), p(20, 15));
		expect(look.refused).toEqual(['own']);
		await expect.poll(() => liveGraph(page)).toEqual(before);
		await expect(undoButton(page)).toBeDisabled();
		await expectFreshDrawing(page);
	});

	test('that keeps a crossing where it was moves', async ({ page }) => {
		// `own`'s far end dragged along its own line: the crossing stays at x = 0.
		await openAt(page, across(), 3);
		const look = await dragHeld(page, p(0, 30), p(0, 40));
		expect(look.refused).toEqual([]);
		await expect
			.poll(async () => (await liveGraph(page)).nodes.find((n) => n.id === 'far')?.y)
			.toBeGreaterThan(38);
		await expect(undoButton(page)).toBeEnabled();
		await expectFreshDrawing(page);
	});

	test('crossing the road it crosses a second time is refused', async ({ page }) => {
		// `host` arches up to y = -40, through y = -20 at x ≈ ±28.3; `own`
		// along y = -20 crosses its western arm. Its end dragged along its
		// own line to x = 40 crosses the eastern arm as well, the first
		// crossing left where it was.
		const graph = graphOf(
			[
				['a', -40, 0],
				['b', 40, 0],
				['far', -40, -20],
				['tip', -10, -20]
			],
			[
				['host', 'a', 'b', 'street', { controlX: 0, controlY: -80 }],
				['own', 'far', 'tip']
			]
		);
		await openAt(page, graph, 3);
		const before = await liveGraph(page);
		const look = await dragHeld(page, p(-10, -20), p(40, -20));
		expect(look.drop).toBeNull();
		expect(look.refused).toEqual(['own']);
		await expect.poll(() => liveGraph(page)).toEqual(before);
		await expectFreshDrawing(page);
	});
});
