import { expect, test } from '@playwright/test';
import type { GraphData, SegmentData } from '../src/lib/core/types';
import { openEditor, openScene, liveGraph, screenAt, toScreen } from './app';
import { nodeOf } from '../unit/model';

// Twice the signed area of the closed chain the segments make, walked start
// to end (world x, z): negative runs counter-clockwise on screen.
const signedArea = (data: GraphData, segments: SegmentData[]) =>
	segments.reduce((sum, s) => {
		const a = nodeOf(data, s.startNodeId);
		const b = nodeOf(data, s.endNodeId);
		return sum + a.x * b.y - b.x * a.y;
	}, 0);

test.describe('Circle tool', () => {
	test.beforeEach(async ({ page }) => {
		await openEditor(page);
	});

	test('the style strip shows while a preset is armed; Tab cycles it', async ({
		page
	}, testInfo) => {
		const strip = page.getByRole('navigation', { name: 'Draw style' });
		const style = (name: string) => strip.getByRole('button', { name, exact: true });
		await expect(strip).toHaveCount(0);

		await page.getByRole('button', { name: 'Street' }).click();
		await expect(strip).toBeVisible();
		await expect(style('Curve')).toHaveAttribute('aria-pressed', 'true');
		await page.screenshot({ path: testInfo.outputPath('style-strip.png') });

		// Tab steps Straight → Curve → Circle and round; the page keeps focus.
		await page.keyboard.press('Tab');
		await expect(style('Circle')).toHaveAttribute('aria-pressed', 'true');
		await expect(style('Curve')).toHaveAttribute('aria-pressed', 'false');
		await page.keyboard.press('Tab');
		await expect(style('Straight')).toHaveAttribute('aria-pressed', 'true');
		await page.keyboard.press('Tab');
		await expect(style('Curve')).toHaveAttribute('aria-pressed', 'true');
		expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);

		// A click picks a style, and it stays through a switch of preset.
		await style('Circle').click();
		await expect(style('Circle')).toHaveAttribute('aria-pressed', 'true');
		await page.getByRole('button', { name: 'One-way lane' }).click();
		await expect(style('Circle')).toHaveAttribute('aria-pressed', 'true');

		await page.keyboard.press('Escape');
		await expect(strip).toHaveCount(0);
		// Nothing armed: Tab is the browser's again.
		await page.keyboard.press('Tab');
		await expect(strip).toHaveCount(0);
	});

	test('lays the armed preset as a closed ring of 8 segments', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await page.getByRole('button', { name: 'Circle', exact: true }).click();

		await canvas.click({ position: { x: 640, y: 360 }, force: true });
		await canvas.click({ position: toScreen(100, 0), force: true });

		const data = await liveGraph(page);
		expect(data.segments.length).toBe(8);
		expect(data.nodes.length).toBe(8);
		for (const node of data.nodes) {
			expect(Math.abs(Math.hypot(node.x, node.y) - 100)).toBeLessThan(0.5);
		}
		// One chain: each segment's end is the next one's start, and walking
		// it comes back round after all 8.
		const from = new Map(data.segments.map((s) => [s.startNodeId, s]));
		let at = data.segments[0];
		for (let i = 0; i < 7; i++) {
			at = from.get(at.endNodeId)!;
			expect(at).toBeDefined();
		}
		expect(at.endNodeId).toBe(data.segments[0].startNodeId);
	});

	test('with the grid on, the centre and the radius snap to it', async ({ page }) => {
		await page.evaluate(() => localStorage.setItem('citynista:grid', '1'));
		await openEditor(page);
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await page.getByRole('button', { name: 'Circle', exact: true }).click();

		await canvas.click({ position: toScreen(3, -4), force: true });
		await canvas.click({ position: toScreen(63, 0), force: true });

		const data = await liveGraph(page);
		expect(data.nodes.length).toBeGreaterThan(0);
		for (const node of data.nodes) {
			expect(Math.abs(Math.hypot(node.x, node.y) - 60)).toBeLessThan(0.5);
		}
	});

	test('a one-way ring runs counter-clockwise on screen, F reverses it', async ({
		page
	}, testInfo) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'One-way lane' }).click();
		await page.getByRole('button', { name: 'Circle', exact: true }).click();
		await expect(page.getByRole('button', { name: 'One-way lane' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);

		// Left ring: the default direction. Its ghost carries the arrow.
		await canvas.click({ position: toScreen(-150, 0), force: true });
		await canvas.hover({ position: toScreen(-90, 0), force: true });
		await page.screenshot({ path: testInfo.outputPath('ghost-arrow.png') });
		await canvas.click({ position: toScreen(-90, 0), force: true });

		// Right ring: flipped.
		await canvas.click({ position: toScreen(150, 0), force: true });
		await canvas.hover({ position: toScreen(210, 0), force: true });
		await page.keyboard.press('f');
		await page.screenshot({ path: testInfo.outputPath('ghost-arrow-flipped.png') });
		await canvas.click({ position: toScreen(210, 0), force: true });

		const data = await liveGraph(page);
		expect(data.segments.length).toBe(16);
		const left = data.segments.filter((s) => nodeOf(data, s.startNodeId).x < 0);
		const right = data.segments.filter((s) => nodeOf(data, s.startNodeId).x > 0);
		expect(signedArea(data, left)).toBeLessThan(0);
		expect(signedArea(data, right)).toBeGreaterThan(0);
		// Traffic runs the way the segments are chained.
		for (const s of data.segments) {
			expect(s.lanes.map((l) => l.direction)).toEqual(['forward']);
		}
	});

	test('a ring drawn across a road splits it into a junction each side', async ({ page }) => {
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await canvas.click({ position: { x: 400, y: 360 }, force: true });
		await canvas.click({ position: { x: 880, y: 360 }, force: true });
		await page.keyboard.press('Escape');

		// Dragged out along the road itself, where a ring node would sit on it.
		await page.getByRole('button', { name: 'Circle', exact: true }).click();
		await canvas.click({ position: { x: 640, y: 360 }, force: true });
		await canvas.click({ position: toScreen(100, 0), force: true });

		const data = await liveGraph(page);
		// The road in three, the ring in eight with nodes at both crossings.
		expect(data.segments.length).toBe(11);
		const degree = (id: string) =>
			data.segments.filter((s) => s.startNodeId === id || s.endNodeId === id).length;
		const junctions = data.nodes.filter((n) => degree(n.id) === 4);
		expect(junctions.length).toBe(2);
		for (const j of junctions) {
			expect(Math.abs(Math.abs(j.x) - 100)).toBeLessThan(1);
			expect(Math.abs(j.y)).toBeLessThan(1);
		}
	});

	test('a 12 m ring over a crossroads cuts all four arms', async ({ page }) => {
		const at = screenAt(8);
		await openScene(page, 'crossroads', 'topdown&model&cam=0,0,8');
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await page.getByRole('button', { name: 'Circle', exact: true }).click();

		// The centre lands on the crossroads node; the radius runs along an arm.
		await canvas.click({ position: { x: 640, y: 360 }, force: true });
		await canvas.click({ position: at(12, 0), force: true });

		const data = await liveGraph(page);
		const degree = (id: string) =>
			data.segments.filter((s) => s.startNodeId === id || s.endNodeId === id).length;
		const cuts = data.nodes.filter((n) => n.id !== 'c' && degree(n.id) === 4);
		expect(cuts.length).toBe(4);
		for (const n of cuts) expect(Math.abs(Math.hypot(n.x, n.y) - 12)).toBeLessThan(0.05);
		expect(degree('c')).toBe(4);
		// Four arms in eight pieces, and the ring in two pieces per quarter.
		expect(data.segments.length).toBe(16);
	});

	test('a ring over roads at uneven angles cuts each, where the ghost showed', async ({ page }) => {
		const at = screenAt(4);
		await openScene(page, 'uneven-three', 'topdown&model&cam=0,0,4');
		const canvas = page.locator('canvas');
		await page.getByRole('button', { name: 'Street' }).click();
		await page.getByRole('button', { name: 'Circle', exact: true }).click();

		// Roads leave the centre at 0°, 100° and 200°; the cursor sits between.
		const cursor = at(20 * Math.cos(Math.PI / 3.6), 20 * Math.sin(Math.PI / 3.6));
		await canvas.click({ position: { x: 640, y: 360 }, force: true });
		await canvas.hover({ position: cursor, force: true });
		const ghost = await page.evaluate(() =>
			(window as unknown as { __ghostGraph: () => GraphData }).__ghostGraph()
		);
		await canvas.click({ position: cursor, force: true });

		const data = await liveGraph(page);
		const degree = (id: string) =>
			data.segments.filter((s) => s.startNodeId === id || s.endNodeId === id).length;
		const cuts = data.nodes.filter((n) => n.id !== 'c' && degree(n.id) === 4);
		expect(cuts.length).toBe(3);
		for (const degrees of [0, 100, 200]) {
			const a = (degrees * Math.PI) / 180;
			expect(
				cuts.some((n) => Math.hypot(n.x - 20 * Math.cos(a), n.y - 20 * Math.sin(a)) < 0.05)
			).toBe(true);
		}
		// Three roads in six pieces; gaps of 160°, 100° and 100° in ring
		// pieces of at most 45°: 4 + 3 + 3.
		expect(data.segments.length).toBe(16);
		// The laid ring's nodes are the ghost's.
		expect(ghost.nodes.length).toBe(10);
		for (const g of ghost.nodes) {
			expect(data.nodes.some((n) => Math.hypot(n.x - g.x, n.y - g.y) < 0.01)).toBe(true);
		}
	});
});
