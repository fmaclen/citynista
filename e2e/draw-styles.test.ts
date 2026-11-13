import { expect, test } from '@playwright/test';
import { saveCity } from './save';
import { expectSelectMode } from './mode';
import { openScene } from './scenes';

const STORAGE_KEY = 'citynista-graph-v2';

// World→screen at the default camera: screen = center + world * (720 / 500).

test.describe('Draw styles', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/?topdown');
		await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);
		await page.reload();
		await expect(page.locator('canvas')).toBeVisible();
	});

	const savedGraph = async (page: import('@playwright/test').Page) => {
		await saveCity(page);
		return page.evaluate((key) => {
			const data = localStorage.getItem(key);
			return data ? JSON.parse(data) : null;
		}, STORAGE_KEY);
	};

	test('chained segments continue tangentially', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();

		// First segment has nothing to continue: straight. The second bends
		// to leave the first without a kink.
		await canvas.click({ position: { x: 250, y: 400 }, force: true });
		await canvas.click({ position: { x: 450, y: 400 }, force: true });
		await canvas.click({ position: { x: 600, y: 250 }, force: true });
		await page.keyboard.press('Escape');

		const data = await savedGraph(page);
		expect(data.segments.length).toBe(2);
		const curved = data.segments.find((s: { controlX?: number }) => s.controlX !== undefined);
		expect(curved).toBeDefined();
		// Tangent continuity: the control sits on the first segment's exit
		// tangent, which is horizontal — same world y as the shared node.
		const shared = data.nodes.find(
			(n: { id: string }) => n.id === curved.startNodeId || n.id === curved.endNodeId
		);
		expect(Math.abs(curved.controlY - shared.y)).toBeLessThan(0.5);
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

		const data = await savedGraph(page);
		expect(data.segments.length).toBe(4);
		const y = (id: string) => data.nodes.find((n: { id: string }) => n.id === id).y;
		const above = data.segments.filter((s: { startNodeId: string }) => y(s.startNodeId) < 0);
		const below = data.segments.filter((s: { startNodeId: string }) => y(s.startNodeId) > 0);
		expect(above.length).toBe(2);
		for (const s of above) expect(s.controlX).toBeUndefined();
		expect(below.filter((s: { controlX?: number }) => s.controlX !== undefined).length).toBe(1);
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

		const data = await savedGraph(page);
		const curved = data.segments.find((s: { controlX?: number }) => s.controlX !== undefined);
		expect(curved).toBeDefined();
		const node = (id: string) => data.nodes.find((n: { id: string }) => n.id === id);
		const a = node(curved.startNodeId);
		const b = node(curved.endNodeId);
		// Which side of the chord a point is on.
		const side = (x: number, y: number) => (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
		// Unflipped, the control sits ahead of the shared start node on the
		// first road's tangent (+x); flipped, it is mirrored across the chord.
		const tangentPoint = side(a.x + 10, a.y);
		expect(Math.sign(side(curved.controlX, curved.controlY))).toBe(-Math.sign(tangentPoint));
		expect(Math.abs(curved.controlY - a.y)).toBeGreaterThan(1);
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

		const data = await savedGraph(page);
		expect(data.segments.length).toBe(1);
		const a = data.nodes.find((n: { id: string }) => n.id === data.segments[0].startNodeId);
		const b = data.nodes.find((n: { id: string }) => n.id === data.segments[0].endNodeId);
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

		const data = await savedGraph(page);
		expect(data.segments.length).toBe(2);
		// Both segments gained control points solving the shared tangent.
		expect(data.segments.every((s: { controlX?: number }) => s.controlX !== undefined)).toBe(true);
	});
});

test.describe('Zoom-adaptive hit areas', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/?topdown');
		await page.evaluate(() => localStorage.removeItem('citynista-graph-v2'));
		await page.reload();
		await expect(page.locator('canvas')).toBeVisible();
	});

	test('zooming in makes a short segment selectable next to its nodes', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();

		// A short segment: ~35px on screen at the default zoom, shorter than
		// the combined node halos.
		await canvas.click({ position: { x: 400, y: 300 }, force: true });
		await canvas.click({ position: { x: 435, y: 300 }, force: true });
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await expectSelectMode(page);

		// Zoom in hard; zoom anchors at the viewport center, so the segment
		// (world midpoint -154.5, -41.7) lands at a computable screen spot
		// while hit halos stay pixel-sized.
		await page.mouse.move(640, 360);
		for (let i = 0; i < 8; i++) {
			await page.mouse.wheel(0, -100);
		}

		// scale = (720/500) * 1.12^8 ≈ 3.565 px per world unit.
		const x = Math.round(640 - 154.5 * 3.565);
		const y = Math.round(360 - 41.7 * 3.565);

		// Click the middle of the (now long) segment: the lane editor panel
		// opening proves a segment — not a node — was selected.
		await canvas.click({ position: { x, y }, force: true });
		await expect(page.getByRole('heading', { name: 'Lane editor' })).toBeVisible();
	});
});

test.describe('Shift-drag collinear snapping', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/?topdown');
		await page.evaluate(() => localStorage.removeItem('citynista-graph-v2'));
		await page.reload();
		await expect(page.locator('canvas')).toBeVisible();
	});

	const savedGraph = async (page: import('@playwright/test').Page) => {
		await saveCity(page);
		return page.evaluate(() => {
			const data = localStorage.getItem('citynista-graph-v2');
			return data ? JSON.parse(data) : null;
		});
	};

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

		const data = await savedGraph(page);
		const ys = data.nodes.map((n: { y: number }) => n.y);
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

		const data = await savedGraph(page);
		const ys = data.nodes.map((n: { y: number }) => n.y);
		// The end node lands exactly on the first road's line.
		expect(Math.abs(ys[2] - ys[0])).toBeLessThan(0.01);
		expect(Math.abs(ys[2] - ys[1])).toBeLessThan(0.01);
	});
});

test.describe('Attach points', () => {
	interface Saved {
		nodes: { id: string; x: number; y: number; junction?: { sides?: Record<string, string> } }[];
		segments: { id: string; startNodeId: string; endNodeId: string }[];
	}

	// Opens a blank city at `zoom`; world (x, z) shows at the returned screen
	// point (720 / 500 px per metre at zoom 1).
	const open = async (page: import('@playwright/test').Page, zoom: number) => {
		await page.goto('/robots.txt');
		await page.evaluate(() => localStorage.clear());
		await page.goto(`/?topdown&cam=0,0,${zoom}`);
		await expect(page.locator('canvas')).toBeVisible();
		const px = (720 / 500) * zoom;
		return (x: number, z: number) => ({ x: 640 + x * px, y: 360 + z * px });
	};

	const saved = async (page: import('@playwright/test').Page): Promise<Saved> => {
		await saveCity(page);
		return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), STORAGE_KEY);
	};

	// A Street along world x; its roadway is 7 m wide, ±3.5 m off its line.
	const drawStreet = async (
		page: import('@playwright/test').Page,
		at: (x: number, z: number) => { x: number; y: number }
	) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await canvas.click({ position: at(-40, 0), force: true });
		await canvas.click({ position: at(40, 0), force: true });
		await page.keyboard.press('Escape');
	};

	// A side road started 3 m off the street's line, inside its outer quarter.
	const branchFromEdge = async (
		page: import('@playwright/test').Page,
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

		const data = await saved(page);
		const cut = data.nodes.find((n) => Math.hypot(n.x, n.y) < 0.5)!;
		expect(Object.keys(cut.junction?.sides ?? {})).toHaveLength(1);
	});

	test('zoomed out, a narrow roadway attaches at its middle', async ({ page }) => {
		// 7 m of roadway is about 10 px here, under the 16 px edges need.
		const at = await open(page, 1);
		await drawStreet(page, at);
		await branchFromEdge(page, at);

		const data = await saved(page);
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

		const data = await saved(page);
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

		const data = await saved(page);
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
	const model = (page: import('@playwright/test').Page, which: '__ghostModel' | '__roadModel') =>
		page.evaluate(
			(fn) => (window as unknown as Record<string, () => Model | undefined>)[fn]?.(),
			which
		);
	const SCALE = 720 / 500;
	const toScreen = (p: { x: number; y: number }) => ({
		x: 640 + p.x * SCALE,
		y: 360 + p.y * SCALE
	});

	test('drawing a wider road onto a road end previews the joint the click builds', async ({
		page
	}, testInfo) => {
		// The bare two-lane road `lone` ends free at lone-b (-60, 100).
		await openScene(page, 'road-joints', 'topdown&model');
		const canvas = page.locator('canvas');
		await expect(canvas).toBeVisible();
		await page.getByRole('button', { name: 'Street' }).click();
		await canvas.click({ position: toScreen({ x: -60, y: 100 }), force: true });
		const cursor = toScreen({ x: -20, y: 140 });
		await canvas.hover({ position: cursor, force: true });

		// The preview lays the Street in at lone-b: a joint there, with both
		// roads trimmed back from the node for it.
		await expect.poll(async () => (await model(page, '__ghostModel'))?.junctions.length).toBe(1);
		const ghost = (await model(page, '__ghostModel'))!;
		await page.screenshot({ path: testInfo.outputPath('preview.png') });

		await canvas.click({ position: cursor, force: true });
		await page.keyboard.press('Escape');
		await page.screenshot({ path: testInfo.outputPath('built.png') });
		const built = (await model(page, '__roadModel'))!;

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
