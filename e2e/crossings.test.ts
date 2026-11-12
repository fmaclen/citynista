import { expect, test, type Page } from '@playwright/test';
import { openScene } from './scenes';
import { saveCity } from './save';

// bend-and-road: a road north to the bend node (0, 0), another on south-east
// from it, and a loose west-east road at y = 80, x -60 to 60. Opened at 2×
// zoom, centred on the bend.
const SCALE = (720 / 500) * 2;
const toScreen = (x: number, y: number) => ({ x: 640 + x * SCALE, y: 360 + y * SCALE });

interface Saved {
	nodes: { id: string; x: number; y: number }[];
	segments: { startNodeId: string; endNodeId: string }[];
}

const saved = async (page: Page) => {
	await saveCity(page);
	return page.evaluate(
		() => JSON.parse(localStorage.getItem('citynista-graph-v2') ?? 'null') as Saved
	);
};

const roadsAt = (graph: Saved, nodeId: string) =>
	graph.segments.filter((s) => s.startNodeId === nodeId || s.endNodeId === nodeId).length;

const drag = async (page: Page, from: { x: number; y: number }, to: { x: number; y: number }) => {
	const a = toScreen(from.x, from.y);
	const b = toScreen(to.x, to.y);
	await page.mouse.move(a.x, a.y);
	await page.mouse.down();
	await page.mouse.move(b.x, b.y, { steps: 8 });
	await page.mouse.up();
};

test.describe('Roads that cross where they show', () => {
	test.beforeEach(async ({ page }) => {
		await openScene(page, 'bend-and-road', 'topdown&cam=0,0,2');
		await expect(page.locator('nav')).toBeVisible();
	});

	test('a road dragged over a node is split there and joins it', async ({ page }) => {
		await drag(page, { x: 30, y: 80 }, { x: 30, y: 0 });

		const graph = await saved(page);
		expect(roadsAt(graph, 'bend')).toBe(4);
		expect(graph.segments).toHaveLength(4);
		await page.screenshot({ path: 'test-results/crossings-drag-over-node.png' });
	});

	test('a road dragged across the middle of another is split where they cross', async ({
		page
	}) => {
		await drag(page, { x: 30, y: 80 }, { x: 30, y: -30 });

		const graph = await saved(page);
		const crossing = graph.nodes.find((n) => Math.hypot(n.x, n.y + 30) < 0.5);
		expect(crossing).toBeDefined();
		expect(roadsAt(graph, crossing!.id)).toBe(4);
	});

	test('a node dragged so its road passes over another node joins it', async ({ page }) => {
		// w (-60, 80) to e moved to (60, -80): the road runs through (0, 0).
		await drag(page, { x: 60, y: 80 }, { x: 60, y: -80 });

		const graph = await saved(page);
		expect(roadsAt(graph, 'bend')).toBe(4);
	});

	test('a road drawn straight through a node joins it', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await canvas.click({ position: toScreen(-80, 0), force: true });
		await canvas.click({ position: toScreen(80, 0), force: true });
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');

		const graph = await saved(page);
		expect(roadsAt(graph, 'bend')).toBe(4);
		await page.screenshot({ path: 'test-results/crossings-draw-through-node.png' });
	});
});
