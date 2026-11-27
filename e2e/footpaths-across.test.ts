import { expect, test, type Page } from '@playwright/test';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { shownAt } from '../src/lib/core/road-line';
import type { Scene } from '../src/lib/core/networks';
import type { GraphData } from '../src/lib/core/types';
import { check } from '../src/lib/road-model/checks';
import { area, intersect, toPath, union } from '../src/lib/road-model/clip';
import { buildModel, nodeOf, readScene, segmentOf } from '../unit/model';
import { piecesOf } from './crossing';
import {
	dragOffset,
	drawingOf,
	expectFreshDrawing,
	gestures,
	graphOf,
	liveGraph,
	openAt,
	openScene,
	p,
	type Pt,
	roadsAt,
	screenAt,
	shot,
	walks
} from './app';

// Footpaths laid over streets: a crossing is paint (core/runs.ts), drawn where
// a footpath's run crosses a roadway, every car approach it lies on giving
// way to it, nothing stored and no control offered for it however its nodes
// are dragged, and drawn on its own road alone; a footpath ended on a street
// joins its near sidewalk or stops at its curb, and rides the street as it
// moves (road-model/overlay.ts, core/drag.ts). Each test leaves a screenshot.

test.afterEach(({ page }) => expectFreshDrawing(page));

const street = createLanesFrom('street');
const yields = (graph: GraphData, id = 'street') =>
	buildModel(graph)
		.scene.road(id)!
		.signs.filter((x) => x.kind === 'yield');
const zebrasOn = (graph: GraphData, id = 'street') =>
	buildModel(graph)
		.scene.road(id)!
		.crossings.filter((c) => c.runs.some((r) => r.kind === 'zebra'));
const approachBadges = (page: Page) => page.getByRole('button', { name: /^Approach control/ });

// How much zebra lies within `r` of a point (m²).
const zebraOver = (scene: Scene, at: Pt, r = 1) => {
	const box = [
		toPath([
			p(at.x - r, at.y - r),
			p(at.x + r, at.y - r),
			p(at.x + r, at.y + r),
			p(at.x - r, at.y + r)
		])
	];
	const zebra = piecesOf(scene).flatMap((d) =>
		d.crossings.flatMap((c) =>
			c.runs.filter((run) => run.kind === 'zebra').flatMap((run) => run.rings.map(toPath))
		)
	);
	return intersect(union(zebra), box).reduce((s, q) => s + area(q), 0);
};

// The car lines of a drawing, every road's sampled path and every car node's
// paths, which a footpath must leave where they were.
const carLines = (scene: Scene) => [
	...scene.place.roads
		.filter((r) => r.lanes.some((l) => l.kind === 'drive'))
		.map((r) => scene.road(r.id)!.path.pts),
	...scene.place.junctions
		.filter((j) => !j.id.startsWith('walk:'))
		.flatMap((j) => scene.node(j.id)!.paths.map((q) => q.line))
];
const nearest = (line: Pt[], at: Pt) => {
	let best = Infinity;
	for (let i = 1; i < line.length; i++) {
		const [a, b] = [line[i - 1], line[i]];
		const [dx, dy] = [b.x - a.x, b.y - a.y];
		const f = Math.max(
			0,
			Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / (dx * dx + dy * dy || 1))
		);
		best = Math.min(best, Math.hypot(a.x + dx * f - at.x, a.y + dy * f - at.y));
	}
	return best;
};
// How far the car lines of `b` lie from those of `a`: each point of each of
// `a`'s lines read against the nearest of `b`'s lines.
function carsMoved(a: Scene, b: Scene) {
	const theirs = carLines(b);
	let worst = 0;
	for (const line of carLines(a))
		for (const at of line) worst = Math.max(worst, Math.min(...theirs.map((l) => nearest(l, at))));
	return worst;
}

// Draws a footpath through some points with the Path preset, straight, each
// click snapping as the owner's do.
async function drawPath(page: Page, view: (x: number, y: number) => Pt, points: Pt[]) {
	await page.getByRole('button', { name: 'Path' }).click();
	await page.getByRole('button', { name: 'Straight', exact: true }).click();
	for (const at of points)
		await page.locator('canvas').click({ position: view(at.x, at.y), force: true });
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
	await page.mouse.move(5, 5);
}

test("a footpath's node in the roadway dragged along the street, then out of it: the crossing follows, nothing cut, no control offered", async ({
	page
}, testInfo) => {
	const graph = graphOf(
		[
			['a', -60, 0],
			['b', 60, 0],
			['p', 0, -18],
			['m', 0, 0],
			['q', 0, 18]
		],
		[
			['street', 'a', 'b'],
			['in', 'p', 'm', 'path'],
			['out', 'm', 'q', 'path']
		]
	);
	await openAt(page, graph, 8);
	const g = gestures(page, 8);
	expect(yields(await liveGraph(page))).toHaveLength(2);
	await g.dblclick(p(0, 0));
	await expect(approachBadges(page)).toHaveCount(0);
	const drag = async (from: Pt, to: Pt) => {
		await page.keyboard.press('Escape');
		await g.drag(from, to, 12);
		await expectFreshDrawing(page);
	};
	// 17 m along the street: the crossing follows while the node is still
	// held, and is kept there let go, nothing to offer at m.
	await page.keyboard.press('Escape');
	await g.hold(p(0, 0), p(17, 0), async () => {
		await expectFreshDrawing(page);
		const held = await liveGraph(page);
		expect(nodeOf(held, 'm').x).toBeCloseTo(17, 0);
		expect(zebrasOn(held)).toHaveLength(1);
	});
	await page.mouse.up();
	await expectFreshDrawing(page);
	let after = await liveGraph(page);
	expect(nodeOf(after, 'm').x).toBeCloseTo(17, 0);
	expect(after.nodes.map((x) => x.id)).toEqual(graph.nodes.map((x) => x.id));
	expect(zebrasOn(after)).toHaveLength(1);
	expect(yields(after)).toHaveLength(2);
	await g.dblclick(p(17, 0));
	await expect(approachBadges(page)).toHaveCount(0);
	// Out of the roadway: nothing cut, the crossing drawn as the bent path
	// lies.
	await drag(p(17, 0), p(5, 9));
	after = await liveGraph(page);
	const m = nodeOf(after, 'm');
	expect([m.x, m.y]).toEqual([expect.closeTo(5, 0), expect.closeTo(9, 0)]);
	expect(after.nodes.map((x) => x.id)).toEqual(graph.nodes.map((x) => x.id));
	expect(after.segments.map((x) => x.id)).toEqual(graph.segments.map((x) => x.id));
	expect(after.nodes.every((x) => !x.junction)).toBe(true);
	expect(zebrasOn(after)).toHaveLength(1);
	expect(yields(after)).toHaveLength(2);
	await shot(page, testInfo.outputPath('node-out-of-roadway.png'));
});

test('a street dragged up beside a crossing gets none of it, on every frame', async ({
	page
}, testInfo) => {
	const lanes = street.slice(1, 3);
	await openAt(
		page,
		graphOf(
			[
				['a', -60, 0],
				['b', 60, 0],
				['p', 0, -12],
				['m', 0, 0],
				['q', 0, 3.52],
				['c', -40, 12],
				['d', 40, 12]
			],
			[
				['street', 'a', 'b', lanes],
				['other', 'c', 'd', lanes],
				['in', 'p', 'm', 'path'],
				['out', 'm', 'q', 'path']
			]
		),
		8
	);
	const g = gestures(page, 8);
	await page.keyboard.press('Escape');
	await g.move(p(25, 12));
	await page.mouse.down();
	await g.move(p(25, 7.15), 12);
	await expectFreshDrawing(page);
	await page.mouse.up();
	await expectFreshDrawing(page);
	const after = await liveGraph(page);
	expect(nodeOf(after, 'c').y).toBeLessThan(8);
	expect(zebrasOn(after, 'other')).toHaveLength(0);
	expect(yields(after, 'other')).toHaveLength(0);
	expect(yields(after)).toHaveLength(2);
	await shot(page, testInfo.outputPath('street-beside-crossing.png'));
});

test('a footpath carried on from the end of a sidewalk joins it with no gap', async ({
	page
}, testInfo) => {
	// The compact roundabout (e2e/scenes/roundabout.json): from the end of
	// the east approach's north sidewalk, at its split, on toward the
	// roundabout and away north-west: it starts on that sidewalk, on a node
	// of its own.
	const view = screenAt(6, { x: 40, y: -15 });
	await openScene(page, 'roundabout', 'topdown&model&cam=40,-15,6');
	await drawPath(page, view, [p(50.5, -4.5), p(20, -30)]);
	await expect.poll(async () => walks(await liveGraph(page)).length).toBe(1);
	const graph = await liveGraph(page);
	const { derived, scene } = buildModel(graph);
	const path = walks(graph)[0];
	expect(roadsAt(graph, path.startNodeId)).toEqual([path.id]);
	expect(check(scene)).toEqual([]);
	// It lies on the approach's north sidewalk (its last lane: the approach
	// is drawn westward), the car roads drawn as they were.
	expect(derived.sidewalks.get(path.startNodeId)).toMatchObject([
		{ path: path.id, road: 'approach-e', lane: 'l3' }
	]);
	expect(carsMoved(buildModel(readScene('roundabout')).scene, scene)).toBeLessThan(0.01);
	await shot(page, testInfo.outputPath('footpath-from-sidewalk.png'));
});

test('a footpath drawn onto a street from one side joins its near sidewalk with no gap, or stops at its curb where it has none, square on or dragged to a lean', async ({
	page
}, testInfo) => {
	// A street from (-60, 0) to (60, 0), its sidewalks' outer edges at y =
	// ±5.5, and a footpath from (0, 25) ended on it near its curb on that
	// side, as the owner drew it; and a street of car lanes alone along y 40,
	// its curbs at y 36.5 and 43.5.
	const view = screenAt(6, { x: 0, y: 10 });
	await openAt(
		page,
		graphOf(
			[
				['w', -60, 0],
				['e', 60, 0],
				['bw', -60, 40],
				['be', 60, 40]
			],
			[
				['street', 'w', 'e'],
				['bare', 'bw', 'be', street.slice(1, 3)]
			]
		),
		6,
		p(0, 10)
	);
	await drawPath(page, view, [p(0, 25), p(0, 3)]);
	const reaches = async () => {
		await expect.poll(async () => walks(await liveGraph(page)).length).toBeGreaterThan(0);
		const graph = await liveGraph(page);
		const { scene } = buildModel(graph);
		expect(check(scene)).toEqual([]);
		const path = walks(graph)[0];
		// It ends on a node of its own, on the near sidewalk's middle.
		const end = nodeOf(graph, path.endNodeId);
		expect(roadsAt(graph, end.id)).toEqual([path.id]);
		expect(end.y).toBeCloseTo(4.5, 6);
		// Its walk runs from the sidewalk's outer edge and no further.
		const ys = scene
			.road(path.id)!
			.surfaces.flatMap((s) =>
				'left' in s.shape ? [...s.shape.left, ...s.shape.right] : s.shape.flat()
			)
			.map((q) => q.y);
		expect(Math.min(...ys)).toBeCloseTo(5.5, 1);
		// Nothing is laid over the street.
		expect(zebraOver(scene, p(0, 0), 8)).toBe(0);
		expect(scene.place.roads.flatMap((r) => scene.road(r.id)!.crossings)).toEqual([]);
	};
	await reaches();
	await shot(page, testInfo.outputPath('footpath-ended-on-street.png'));
	// Its free end dragged 6 m east and back west past square.
	const g = gestures(page, 6, p(0, 10));
	for (const x of [6, -6]) {
		const graph = await liveGraph(page);
		const free = nodeOf(graph, walks(graph)[0].startNodeId);
		await g.drag(free, p(x, 25));
		await expect.poll(async () => nodeOf(await liveGraph(page), free.id).x).toBeCloseTo(x, 0);
		await page.mouse.move(5, 5);
		await reaches();
	}
	await shot(page, testInfo.outputPath('footpath-ended-on-street-leaning.png'));
	// Onto the street of car lanes alone, clicked on its near half: it ends
	// at the near curb, on a node of its own, nothing laid over the street.
	await drawPath(page, view, [p(-30, 20), p(-30, 38)]);
	await expect.poll(async () => walks(await liveGraph(page)).length).toBe(2);
	const graph = await liveGraph(page);
	const { scene } = buildModel(graph);
	expect(check(scene)).toEqual([]);
	const end = nodeOf(graph, walks(graph)[1].endNodeId);
	expect(roadsAt(graph, end.id)).toEqual([walks(graph)[1].id]);
	expect(end.y).toBeCloseTo(36.5, 6);
	expect(zebraOver(scene, p(-30, 40), 4)).toBe(0);
	expect(scene.road('bare')!.crossings).toEqual([]);
	await shot(page, testInfo.outputPath('footpath-ended-at-curb.png'));
});

test("a footpath's end on a sidewalk rides with the street as its shift's handle moves it", async ({
	page
}, testInfo) => {
	// A street from (-70, 0) to (70, 0), a T at each end, and a footpath from
	// its south sidewalk at (0, 4.5) to (0, 25). The street's shift handle
	// dragged 3 m toward the footpath: the end keeps its place beside the
	// street's line as it shows, on the same sidewalk.
	await openAt(
		page,
		graphOf(
			[
				['a', -70, 0],
				['b', 70, 0],
				['an', -70, -30],
				['as', -70, 30],
				['bn', 70, -30],
				['bs', 70, 30],
				['c', 0, 4.5],
				['d', 0, 25]
			],
			[
				['s', 'a', 'b'],
				['an', 'a', 'an'],
				['as', 'a', 'as'],
				['bn', 'b', 'bn'],
				['bs', 'b', 'bs'],
				['w', 'c', 'd', 'path']
			]
		),
		2
	);
	const was = buildModel(await liveGraph(page)).derived.sidewalks.get('c');
	expect(was).toBeDefined();
	await dragOffset(page, screenAt(2), 's', 3);
	const after = await liveGraph(page);
	const road = segmentOf(after, 's');
	const shifted = { ...road, offsetStart: road.offsetStart ?? 0, offsetEnd: road.offsetEnd ?? 0 };
	// The street moved: halfway along, where the end lies, its line shows
	// further toward the footpath.
	const shown = shownAt(shifted, nodeOf(after, 'a'), nodeOf(after, 'b'), 0.5).point;
	expect(shown.y).toBeGreaterThan(1);
	const c = nodeOf(after, 'c');
	expect([c.x, c.y]).toEqual([expect.closeTo(shown.x, 1), expect.closeTo(shown.y + 4.5, 1)]);
	expect(buildModel(after).derived.sidewalks.get('c')?.[0].lane).toBe(was![0].lane);
	await shot(page, testInfo.outputPath('rider-shifted.png'));
});

test('a crossing is given way to only where a footpath crosses the street, whatever was saved there', async ({
	page
}) => {
	// Saved with the footpaths sharing the street's nodes: at c1 (-20, 0) a
	// footpath from the north only ends, at c2 (20, 0) one crosses; each
	// stored a stop each way on the street, which only carries on through
	// both and so draws none.
	const lanes = () => createLanesFrom('street').map((l, i) => ({ ...l, id: `l${i}` }));
	await openAt(
		page,
		{
			nodes: [
				{ id: 'w', x: -60, y: 0 },
				{ id: 'c1', x: -20, y: 0, junction: { control: { 'a:end': 'stop', 'b:start': 'stop' } } },
				{ id: 'c2', x: 20, y: 0, junction: { control: { 'b:end': 'stop', 'd:start': 'stop' } } },
				{ id: 'e', x: 60, y: 0 },
				{ id: 'n1', x: -20, y: -25 },
				{ id: 'n2', x: 20, y: -25 },
				{ id: 's2', x: 20, y: 25 }
			],
			segments: [
				{ id: 'a', startNodeId: 'w', endNodeId: 'c1', lanes: lanes() },
				{ id: 'b', startNodeId: 'c1', endNodeId: 'c2', lanes: lanes() },
				{ id: 'd', startNodeId: 'c2', endNodeId: 'e', lanes: lanes() },
				{ id: 'p', startNodeId: 'n1', endNodeId: 'c1', lanes: createLanesFrom('path') },
				{ id: 'q', startNodeId: 'n2', endNodeId: 'c2', lanes: createLanesFrom('path') },
				{ id: 'r', startNodeId: 'c2', endNodeId: 's2', lanes: createLanesFrom('path') }
			]
		},
		4
	);
	// Loaded, the crossing footpath has a node of its own at c2
	// (core/separate.ts), holding it alone.
	const graph = await liveGraph(page);
	const own = graph.nodes.find((n) => n.id !== 'c2' && n.x === 20 && n.y === 0)!;
	expect(roadsAt(graph, own.id).sort()).toEqual(['q', 'r']);
	expect(roadsAt(graph, 'c2').sort()).toEqual(['b', 'd']);
	const g = gestures(page, 4);
	for (const x of [20, -20]) {
		await g.dblclick(p(x, 0));
		await expect(approachBadges(page)).toHaveCount(0);
		await page.keyboard.press('Escape');
	}
	// Drawn: the two give-way lines behind the crossing at c2, none at c1,
	// and no stop line.
	const signs = (await drawingOf(page)).road('a')!.signs;
	expect(signs.filter((s) => s.kind === 'stop')).toHaveLength(0);
	const given = signs.filter((s) => s.kind === 'yield');
	expect(given).toHaveLength(2);
	for (const s of given) expect(Math.abs(s.a.x - 20)).toBeLessThan(8);
});
