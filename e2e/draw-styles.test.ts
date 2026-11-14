import { expect, test, type Page } from '@playwright/test';
import {
	expectSelectMode,
	openEditor,
	openScene,
	roadModel,
	liveGraph,
	screenAt,
	toScreen
} from './app';
import { nodeOf } from '../unit/model';

test.describe('Draw styles', () => {
	test.beforeEach(async ({ page }) => {
		await openEditor(page);
	});

	test('chained segments continue tangentially', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();

		// First segment has nothing to continue: straight. The second bends
		// to leave the first without a kink.
		await canvas.click({ position: { x: 250, y: 400 }, force: true });
		await canvas.click({ position: { x: 450, y: 400 }, force: true });
		await canvas.click({ position: { x: 600, y: 250 }, force: true });
		await page.keyboard.press('Escape');

		const data = await liveGraph(page);
		expect(data.segments.length).toBe(2);
		const curved = data.segments.find((s) => s.controlX !== undefined)!;
		expect(curved).toBeDefined();
		// Tangent continuity: the control sits on the first segment's exit
		// tangent, which is horizontal — same world y as the shared node.
		const shared = nodeOf(data, curved.startNodeId);
		expect(Math.abs(curved.controlY! - shared.y)).toBeLessThan(0.5);
	});

	test('Straight chains straight roads; Curve bends on from the road it continues', async ({
		page
	}) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await page.getByRole('button', { name: 'Straight', exact: true }).click();

		// Above: an L in the straight style, F doing nothing.
		await canvas.click({ position: { x: 250, y: 250 }, force: true });
		await canvas.click({ position: { x: 450, y: 250 }, force: true });
		await canvas.hover({ position: { x: 600, y: 100 }, force: true });
		await page.keyboard.press('f');
		await canvas.click({ position: { x: 600, y: 100 }, force: true });
		await page.keyboard.press('Escape');

		// Below: the same L, curved.
		await page.getByRole('button', { name: 'Curve', exact: true }).click();
		await canvas.click({ position: { x: 250, y: 550 }, force: true });
		await canvas.click({ position: { x: 450, y: 550 }, force: true });
		await canvas.click({ position: { x: 600, y: 400 }, force: true });
		await page.keyboard.press('Escape');

		const data = await liveGraph(page);
		expect(data.segments.length).toBe(4);
		const y = (id: string) => nodeOf(data, id).y;
		const above = data.segments.filter((s) => y(s.startNodeId) < 0);
		const below = data.segments.filter((s) => y(s.startNodeId) > 0);
		expect(above.length).toBe(2);
		for (const s of above) expect(s.controlX).toBeUndefined();
		expect(below.filter((s) => s.controlX !== undefined).length).toBe(1);
	});

	test('F flips the automatic curve to the other side of its chord', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();

		await canvas.click({ position: { x: 250, y: 400 }, force: true });
		await canvas.click({ position: { x: 450, y: 400 }, force: true });
		await canvas.hover({ position: { x: 600, y: 250 }, force: true });
		await page.keyboard.press('f');
		await canvas.click({ position: { x: 600, y: 250 }, force: true });
		await page.keyboard.press('Escape');

		const data = await liveGraph(page);
		const curved = data.segments.find((s) => s.controlX !== undefined)!;
		expect(curved).toBeDefined();
		const a = nodeOf(data, curved.startNodeId);
		const b = nodeOf(data, curved.endNodeId);
		// Which side of the chord a point is on.
		const side = (x: number, y: number) => (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
		// Unflipped, the control sits ahead of the shared start node on the
		// first road's tangent (+x); flipped, it is mirrored across the chord.
		const tangentPoint = side(a.x + 10, a.y);
		expect(Math.sign(side(curved.controlX!, curved.controlY!))).toBe(-Math.sign(tangentPoint));
		expect(Math.abs(curved.controlY! - a.y)).toBeGreaterThan(1);
	});

	test('shift snaps the pending segment to 22.5 degree increments', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();

		await canvas.click({ position: { x: 300, y: 400 }, force: true });
		// 19° off horizontal — snaps to 22.5° under shift.
		await page.keyboard.down('Shift');
		await canvas.click({ position: { x: 540, y: 318 }, force: true });
		await page.keyboard.up('Shift');
		await page.keyboard.press('Escape');

		const data = await liveGraph(page);
		expect(data.segments.length).toBe(1);
		const a = nodeOf(data, data.segments[0].startNodeId);
		const b = nodeOf(data, data.segments[0].endNodeId);
		const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
		expect(Math.abs(angle - -22.5)).toBeLessThan(0.5);
	});

	test('shift-dragging a two-segment node smooths its tangent', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();

		// A corner: two straight segments meeting at a right-ish angle.
		await canvas.click({ position: { x: 300, y: 400 }, force: true });
		await canvas.click({ position: { x: 500, y: 400 }, force: true });
		await canvas.click({ position: { x: 500, y: 250 }, force: true });
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await expectSelectMode(page);

		// Select the corner node, then shift+drag it.
		await canvas.click({ position: { x: 500, y: 400 }, force: true });
		await page.keyboard.down('Shift');
		await page.mouse.move(500, 400);
		await page.mouse.down();
		await page.mouse.move(520, 390, { steps: 4 });
		await page.mouse.up();
		await page.keyboard.up('Shift');

		const data = await liveGraph(page);
		expect(data.segments.length).toBe(2);
		// Both segments gained control points solving the shared tangent.
		expect(data.segments.every((s) => s.controlX !== undefined)).toBe(true);
	});
});

test.describe('Shift-drag collinear snapping', () => {
	test.beforeEach(async ({ page }) => {
		await openEditor(page);
	});

	test('a middle node snaps onto the line between far endpoints', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await canvas.click({ position: { x: 300, y: 300 }, force: true });
		await canvas.click({ position: { x: 450, y: 330 }, force: true });
		await canvas.click({ position: { x: 600, y: 300 }, force: true });
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await expectSelectMode(page);

		// Select the bent middle node and shift-drag it near the line
		// between the two far endpoints.
		await canvas.click({ position: { x: 450, y: 330 }, force: true });
		await page.keyboard.down('Shift');
		await page.mouse.move(450, 330);
		await page.mouse.down();
		await page.mouse.move(450, 305, { steps: 5 });
		await page.mouse.up();
		await page.keyboard.up('Shift');

		const data = await liveGraph(page);
		const ys = data.nodes.map((n) => n.y);
		// All three nodes share the far endpoints' y: perfectly straight.
		expect(Math.abs(ys[1] - ys[0])).toBeLessThan(0.01);
		expect(Math.abs(ys[2] - ys[0])).toBeLessThan(0.01);
	});

	test('an end node snaps onto the continuation of the adjacent road', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await canvas.click({ position: { x: 250, y: 300 }, force: true });
		await canvas.click({ position: { x: 450, y: 300 }, force: true });
		await canvas.click({ position: { x: 620, y: 360 }, force: true });
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await expectSelectMode(page);

		// Select the dangling end and shift-drag near the horizontal
		// extension of the first segment.
		await canvas.click({ position: { x: 620, y: 360 }, force: true });
		await page.keyboard.down('Shift');
		await page.mouse.move(620, 360);
		await page.mouse.down();
		await page.mouse.move(640, 308, { steps: 5 });
		await page.mouse.up();
		await page.keyboard.up('Shift');

		const data = await liveGraph(page);
		const ys = data.nodes.map((n) => n.y);
		// The end node lands exactly on the first road's line.
		expect(Math.abs(ys[2] - ys[0])).toBeLessThan(0.01);
		expect(Math.abs(ys[2] - ys[1])).toBeLessThan(0.01);
	});
});

test.describe('Attach points', () => {
	// Opens a blank city at `zoom`; world (x, z) shows at the returned screen
	// point.
	const open = async (page: Page, zoom: number) => {
		await openEditor(page, `topdown&model&cam=0,0,${zoom}`);
		return screenAt(zoom);
	};

	// A Street along world x; its roadway is 7 m wide, ±3.5 m off its line.
	const drawStreet = async (page: Page, at: (x: number, z: number) => { x: number; y: number }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await canvas.click({ position: at(-40, 0), force: true });
		await canvas.click({ position: at(40, 0), force: true });
		await page.keyboard.press('Escape');
	};

	// A side road started 3 m off the street's line, inside its outer quarter.
	const branchFromEdge = async (
		page: Page,
		at: (x: number, z: number) => { x: number; y: number },
		screenshot?: string
	) => {
		const canvas = page.locator('canvas');
		await canvas.hover({ position: at(0, -3), force: true });
		if (screenshot) await page.screenshot({ path: screenshot });
		await canvas.click({ position: at(0, -3), force: true });
		await canvas.click({ position: at(0, -30), force: true });
		await page.keyboard.press('Escape');
	};

	test('zoomed in, the edge under the cursor is the live attach point', async ({
		page
	}, testInfo) => {
		const at = await open(page, 4);
		await drawStreet(page, at);
		await branchFromEdge(page, at, testInfo.outputPath('edge-live.png'));

		const data = await liveGraph(page);
		const cut = data.nodes.find((n) => Math.hypot(n.x, n.y) < 0.5)!;
		expect(Object.keys(cut.junction?.sides ?? {})).toHaveLength(1);
	});

	test('zoomed out, a narrow roadway attaches at its middle', async ({ page }) => {
		// 7 m of roadway is about 10 px here, under the 16 px edges need.
		const at = await open(page, 1);
		await drawStreet(page, at);
		await branchFromEdge(page, at);

		const data = await liveGraph(page);
		expect(data.segments).toHaveLength(3);
		const cut = data.nodes.find((n) => Math.hypot(n.x, n.y) < 0.5)!;
		expect(cut.junction?.sides ?? {}).toEqual({});
	});

	test("a road's end reaches its node across its whole width", async ({ page }) => {
		// Half a metre from the street's west end and 3.2 m off its line:
		// outside the end node's 20 px ring (2.3 m here), on the street's edge.
		// (The west end, clear of the lane panel.)
		const at = await open(page, 6);
		await drawStreet(page, at);
		const canvas = page.locator('canvas');
		await canvas.click({ position: at(-39.5, -3.2), force: true });
		await canvas.click({ position: at(-39.5, -30), force: true });
		await page.keyboard.press('Escape');

		const data = await liveGraph(page);
		// The street isn't cut; the new road starts at its end, on its edge.
		expect(data.segments).toHaveLength(2);
		const end = data.nodes.find((n) => Math.hypot(n.x + 40, n.y) < 0.5)!;
		expect(data.segments.filter((s) => [s.startNodeId, s.endNodeId].includes(end.id))).toHaveLength(
			2
		);
		expect(Object.keys(end.junction?.sides ?? {})).toHaveLength(1);
	});

	test('Cmd-click on a road starts a free road without cutting it', async ({ page }) => {
		const at = await open(page, 4);
		await drawStreet(page, at);
		const canvas = page.locator('canvas');
		await canvas.click({ position: at(0, -1), force: true, modifiers: ['ControlOrMeta'] });
		await canvas.click({ position: at(0, -30), force: true });
		await page.keyboard.press('Escape');

		const data = await liveGraph(page);
		// The street stays one road; the new one starts on open ground.
		expect(data.segments).toHaveLength(2);
		const start = data.nodes.find((n) => Math.abs(n.x) < 0.5 && Math.abs(n.y + 1) < 0.5);
		expect(start).toBeDefined();
	});
});

test.describe('Draw preview', () => {
	type Model = {
		roads: { id: string; points: { x: number; y: number }[] }[];
		junctions: { id: string; connections: unknown[] }[];
	};
	const ghostModel = (page: Page) =>
		page.evaluate(() =>
			(window as unknown as { __ghostModel: () => Model | undefined }).__ghostModel()
		);

	test('drawing a wider road onto a road end previews the joint the click builds', async ({
		page
	}, testInfo) => {
		// The bare two-lane road `lone` ends free at lone-b (-60, 100).
		await openScene(page, 'road-joints', 'topdown&model');
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await canvas.click({ position: toScreen(-60, 100), force: true });
		const cursor = toScreen(-20, 140);
		await canvas.hover({ position: cursor, force: true });

		// The preview lays the Street in at lone-b: a joint there, with both
		// roads trimmed back from the node for it.
		await expect.poll(async () => (await ghostModel(page))?.junctions.length).toBe(1);
		const ghost = (await ghostModel(page))!;
		await page.screenshot({ path: testInfo.outputPath('preview.png') });

		await canvas.click({ position: cursor, force: true });
		await page.keyboard.press('Escape');
		await page.screenshot({ path: testInfo.outputPath('built.png') });
		const built = (await roadModel(page))!;

		const near = (p: { x: number; y: number }, q: { x: number; y: number }) =>
			Math.hypot(p.x - q.x, p.y - q.y) < 0.05;
		const scene = new Set(['seam-one', 'seam-two', 'widen-wide', 'widen-narrow', 'lone']);
		const added = (m: Model) => m.roads.find((r) => !scene.has(r.id));
		const ends = (r: Model['roads'][number] | undefined) => [r!.points[0], r!.points.at(-1)!];
		// The new road and the road it joins end where the click left them.
		for (const pick of [added, (m: Model) => m.roads.find((r) => r.id === 'lone')]) {
			const [g0, g1] = ends(pick(ghost));
			const [b0, b1] = ends(pick(built));
			expect(near(g0, b0) && near(g1, b1)).toBe(true);
		}
		const joint = (m: Model) => m.junctions.find((j) => j.id === 'lone-b');
		expect(joint(ghost)?.connections.length).toBe(joint(built)?.connections.length);
		expect(joint(built)?.connections.length).toBeGreaterThan(0);
	});
});
