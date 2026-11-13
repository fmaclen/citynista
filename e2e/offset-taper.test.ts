import { expect, test, type Page } from '@playwright/test';
import { openGraph } from './scenes';
import { shownAt } from '../src/lib/core/road-line';
import { check } from '../src/lib/lab/checks';
import { crossSection, frameAt, offsetPoint, samplePath } from '../src/lib/lab/geometry';
import type { Place, Road } from '../src/lib/lab/model';
import { Scene } from '../src/lib/lab/scene';
import type { GraphData, Lane } from '../src/lib/core/types';

// A two-way road (lane, buffer, lane) from w (-60,0) east to n (0,0),
// extended east by a road of the same lanes to a dead end e (60,0). Where
// two roads with the same lanes meet the offset handle takes their node
// along; once the extension is cut down to one lane they meet in a taper,
// and its end there keeps a shift instead, so the two-way road stays put.
// At 4× zoom, looking at (10, 0).
const ZOOM = 4;
const PX = (720 / 500) * ZOOM;
const CAM = { x: 10, y: 0 };
type Pt = { x: number; y: number };
const toScreen = ({ x, y }: Pt) => ({ x: 640 + (x - CAM.x) * PX, y: 360 + (y - CAM.y) * PX });

const graphOf = (page: Page) =>
	page.evaluate(() => (window as Window & { __graph?: () => GraphData }).__graph!());
const placeOf = (page: Page) =>
	page.evaluate(() => (window as Window & { __roadModel?: () => Place }).__roadModel?.());
const segmentOf = (graph: GraphData, id: string) => graph.segments.find((s) => s.id === id)!;
const nodeOf = (graph: GraphData, id: string) => graph.nodes.find((n) => n.id === id)!;

const twoWay = (p: string): Lane[] => [
	{ id: `${p}0`, role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'backward' },
	{ id: `${p}1`, role: 'buffer', material: 'concrete', width: 1, direction: 'bidirectional' },
	{ id: `${p}2`, role: 'vehicle', material: 'asphalt', width: 3.5, direction: 'forward' }
];

const GRAPH = {
	nodes: [
		{ id: 'w', x: -60, y: 0 },
		{ id: 'n', x: 0, y: 0 },
		{ id: 'e', x: 60, y: 0 }
	],
	segments: [
		{ id: 'road', startNodeId: 'w', endNodeId: 'n', lanes: twoWay('r') },
		{ id: 'ext', startNodeId: 'n', endNodeId: 'e', lanes: twoWay('x') }
	]
};

// The middle of a road's cross-section as drawn, at a fraction of its length.
function drawnCentre(road: Road, f: number) {
	const path = samplePath(road);
	const d = path.length * f;
	const frame = frameAt(path, d);
	const spans = crossSection(road, d);
	return offsetPoint(frame.p, frame.n, (spans[0].left + spans.at(-1)!.right) / 2);
}

// Drags the selected road's offset handle `by` metres to its right, holding
// Shift when `snap`.
async function dragOffset(page: Page, id: string, by: number, snap: boolean) {
	const graph = await graphOf(page);
	const s = segmentOf(graph, id);
	const shifted = { ...s, offsetStart: s.offsetStart ?? 0, offsetEnd: s.offsetEnd ?? 0 };
	const handle = shownAt(shifted, nodeOf(graph, s.startNodeId), nodeOf(graph, s.endNodeId), 0.25);
	const from = toScreen(handle.point);
	const to = toScreen({
		x: handle.point.x + handle.normal.x * by,
		y: handle.point.y + handle.normal.y * by
	});
	if (snap) await page.keyboard.down('Shift');
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 8 });
	await page.mouse.up();
	if (snap) await page.keyboard.up('Shift');
}

async function selectExtension(page: Page) {
	const at = toScreen({ x: 40, y: 0 });
	await page.mouse.click(at.x, at.y);
	await expect(page.locator('aside')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
	await openGraph(page, GRAPH, `topdown&model&cam=${CAM.x},${CAM.y},${ZOOM}`);
	await expect.poll(async () => (await placeOf(page))?.roads.length).toBe(2);
});

test('an extension with the same lanes takes the node along', async ({ page }) => {
	await selectExtension(page);
	await dragOffset(page, 'ext', 2, false);

	await expect.poll(async () => nodeOf(await graphOf(page), 'n').y).toBeGreaterThan(1);
	const ext = segmentOf(await graphOf(page), 'ext');
	expect(ext.offsetStart ?? 0).toBe(0);
	expect(ext.offsetEnd ?? 0).toBe(0);
});

test('an extension cut to one lane slides onto a lane of the two-way road', async ({
	page
}, testInfo) => {
	const shot = async (name: string) => {
		await page.keyboard.press('Escape');
		await page.mouse.move(toScreen({ x: 10, y: 40 }).x, toScreen({ x: 10, y: 40 }).y);
		await page.screenshot({
			path: testInfo.outputPath(name),
			clip: { x: toScreen({ x: -30, y: 0 }).x, y: 360 - 15 * PX, width: 70 * PX, height: 30 * PX }
		});
	};
	// Cut the extension down to its eastbound lane in the lane panel.
	await selectExtension(page);
	const remove = page.locator('aside').getByTitle('Remove lane');
	for (const left of [2, 1]) {
		await remove.first().click();
		await expect(remove).toHaveCount(left);
	}
	const before = await graphOf(page);
	expect(segmentOf(before, 'ext').lanes.map((l) => l.id)).toEqual(['x2']);
	await shot('taper-before.png');

	// About 2 m south with Shift snaps to 2.25 m, on the eastbound lane.
	await selectExtension(page);
	await dragOffset(page, 'ext', 2, true);

	await expect
		.poll(async () => segmentOf(await graphOf(page), 'ext').offsetStart ?? 0)
		.toBeCloseTo(2.25, 3);
	const after = await graphOf(page);
	expect(nodeOf(after, 'n')).toMatchObject({ x: 0, y: 0 });
	expect(nodeOf(after, 'w')).toMatchObject({ x: -60, y: 0 });
	expect(segmentOf(after, 'road')).toEqual(segmentOf(before, 'road'));
	// The dead end goes along with the road and keeps no shift.
	expect(nodeOf(after, 'e').y).toBeCloseTo(2.25, 3);
	expect(segmentOf(after, 'ext').offsetEnd ?? 0).toBe(0);
	// As drawn: the lane runs on along the eastbound lane's centre, y = 2.25.
	const place = (await placeOf(page))!;
	const road = place.roads.find((r) => r.id === 'ext')!;
	for (const f of [0, 0.5, 1]) expect(drawnCentre(road, f).y).toBeCloseTo(2.25, 1);
	expect(check(new Scene(place))).toEqual([]);
	await shot('taper-after.png');
});
