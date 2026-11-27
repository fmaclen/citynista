import { expect, test, type Page } from '@playwright/test';
import type { GraphData } from '../src/lib/core/types';
import { nearestOf } from '../src/lib/road-model/overlay';
import { buildModel } from '../unit/model';
import {
	expectFreshDrawing,
	gestures,
	graphOf,
	liveGraph,
	nodeOf,
	openAt,
	p,
	type Pt,
	shot
} from './app';
import { joinOf, PATH, STREET } from './paths';

// A footpath's end joined to a junction's corner sidewalk: whatever draws
// the corner anew (a road of the junction moved, a lane edit) keeps the end
// on it at its place round it (Editor.followWalkways), and a draw onto the
// corner lands on it (modes/picking.ts). Each case is set up as a city and
// acted on through the page, and leaves a screenshot. Every drag at the
// junction refused, escaped or kept, the end slid between a sidewalk and its
// corner, and a cut beside the corner are in unit/footpath-corners.test.ts.

test.describe.configure({ mode: 'parallel' });

test.afterEach(async ({ page }, testInfo) => {
	await expectFreshDrawing(page);
	await shot(page, testInfo.outputPath('end.png'));
});

const ZOOM = 8;
const endAt = async (page: Page) => nodeOf(await liveGraph(page), 'end');

// Streets meeting at j: west and east along x, south down y, and north
// when `four`.
const junction = (four: boolean): GraphData =>
	graphOf(
		[
			['j', 0, 0],
			['a', -27, 0],
			['b', 27, 0],
			['c', 0, 26],
			...(four ? [['d', 0, -26] as [string, number, number]] : [])
		],
		[
			['west', 'a', 'j', STREET],
			['east', 'j', 'b', STREET],
			['south', 'j', 'c', STREET],
			...(four ? [['north', 'd', 'j', STREET] as [string, string, string, typeof STREET]] : [])
		]
	);
// A point on the east-south corner's middle, about a third of the way
// round from east: off its middle, so an end kept there is told from one
// put anywhere else on the corner.
const ON_CORNER = { x: 6.68, y: 4.94 };
// The junction with a footpath out from its east-south corner, at
// ON_CORNER, to (19, 19).
const withPath = (four: boolean) => {
	const g = junction(four);
	g.nodes.push({ id: 'end', ...ON_CORNER }, { id: 'far', x: 19, y: 19 });
	g.segments.push({ id: 'w', startNodeId: 'end', endNodeId: 'far', lanes: PATH });
	return g;
};

// How far round the east-south corner of `junction(four)`, as a fresh
// build draws it, the point of its middle nearest `q` lies.
const roundAt = (four: boolean, q: Pt) => {
	const corner = buildModel(junction(four))
		.scene.node('j')!
		.walkways!.find((w) => w.a.road === 'east' && w.b.road === 'south')!;
	const near = nearestOf([corner.line], (l) => l, q)!;
	return near.along / near.length;
};

test.describe("a footpath's end on a junction's corner stays on it", () => {
	test('a road of the junction swung round keeps it on the corner at its place round it', async ({
		page
	}) => {
		const g = gestures(page, ZOOM);
		await openAt(page, withPath(true), ZOOM);
		const before = await joinOf(page, 'end');
		expect(before.corner).toBe('east/south');
		expect(before.round).toBeCloseTo(roundAt(true, ON_CORNER), 2);
		await g.drag({ x: 27, y: 0 }, { x: 24, y: 18 }, 9);
		await expect.poll(async () => nodeOf(await liveGraph(page), 'b').y).toBeGreaterThan(10);
		const after = await joinOf(page, 'end');
		expect(after.corner).toBe('east/south');
		expect(after.round).toBeCloseTo(before.round!, 1);
		// Undone, the end is where it was.
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => endAt(page)).toMatchObject(ON_CORNER);
	});

	test("the corner's street sidewalk widened keeps it on the corner", async ({ page }) => {
		const g = gestures(page, ZOOM);
		await openAt(page, withPath(false), ZOOM);
		const before = await joinOf(page, 'end');
		expect(before.corner).toBe('east/south');
		expect(before.round).toBeCloseTo(roundAt(false, ON_CORNER), 2);
		await g.click({ x: 21, y: 0 });
		const width = page.locator('[data-lane]').nth(0).getByRole('spinbutton');
		await width.fill('8');
		await width.press('Tab');
		await expect
			.poll(
				async () => (await liveGraph(page)).segments.find((x) => x.id === 'east')!.lanes[0].width
			)
			.toBe(8);
		await page.keyboard.press('Escape');
		const after = await joinOf(page, 'end');
		expect(after.corner).toBe('east/south');
		expect(after.round).toBeCloseTo(before.round!, 1);
	});
});

test.describe("a street's sidewalk and its corner are one walkway", () => {
	test('a footpath drawn onto the corner as it shows ends on the corner', async ({ page }) => {
		const g = gestures(page, ZOOM);
		await openAt(page, junction(true), ZOOM);
		await g.draw('Path', [p(17, 17), ON_CORNER], [false, true]);
		const graph = await liveGraph(page);
		const w = graph.segments.find((x) => x.lanes.every((l) => l.role !== 'vehicle'))!;
		const end = nodeOf(graph, w.endNodeId);
		// On the corner's middle where the click was.
		expect(Math.hypot(end.x - ON_CORNER.x, end.y - ON_CORNER.y)).toBeLessThan(0.1);
		const join = await joinOf(page, end.id);
		expect(join.corner).toBe('east/south');
		expect(join.round).toBeCloseTo(roundAt(true, ON_CORNER), 1);
	});
});
