import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'citynista-graph-v2';

const GRAPH_DATA = {
	nodes: [
		{
			id: 'node-0',
			x: -220,
			y: -60,
			disabledConnections: [
				{
					from: { segmentId: 'segment-0', laneIndex: 1 },
					to: { segmentId: 'segment-0', laneIndex: 2 }
				}
			]
		},
		{ id: 'node-1', x: -80, y: -60 },
		{ id: 'node-2', x: -220, y: 80 },
		{ id: 'node-3', x: -80, y: 80 }
	],
	segments: [
		{
			id: 'segment-0',
			startNodeId: 'node-0',
			endNodeId: 'node-1',
			controlX: -150,
			controlY: -120,
			lanes: [
				{ type: 'sidewalk', width: 2, direction: 'bidirectional' },
				{ type: 'road', width: 3, direction: 'backward' },
				{ type: 'turn', width: 3, direction: 'forward', turn: 'left', markings: false },
				{ type: 'sidewalk', width: 2, direction: 'bidirectional' }
			]
		},
		{
			id: 'segment-1',
			startNodeId: 'node-2',
			endNodeId: 'node-3',
			lanes: [
				{ type: 'sidewalk', width: 3, direction: 'bidirectional' },
				{ type: 'grass', width: 1, direction: 'bidirectional' },
				{ type: 'road', width: 3.5, direction: 'backward' },
				{ type: 'road', width: 3.5, direction: 'forward' },
				{ type: 'grass', width: 1, direction: 'bidirectional' },
				{ type: 'sidewalk', width: 3, direction: 'bidirectional' }
			]
		}
	]
};

const SCALE = 720 / 500;
const toScreen = (x: number, y: number) => ({ x: 640 + x * SCALE, y: 360 + y * SCALE });

interface SavedLane {
	type: string;
	width: number;
	direction: string;
	turn?: string;
	markings?: boolean;
}

interface SavedNode {
	id: string;
	x: number;
	y: number;
	disabledConnections?: {
		from: { segmentId: string; laneIndex: number };
		to: { segmentId: string; laneIndex: number };
	}[];
}

interface SavedSegment {
	id: string;
	startNodeId: string;
	endNodeId: string;
	controlX?: number;
	controlY?: number;
	lanes: SavedLane[];
}

interface SavedGraph {
	nodes: SavedNode[];
	segments: SavedSegment[];
}

const laneKey = (lanes: SavedLane[]) =>
	lanes
		.map(
			(lane) =>
				`${lane.type}:${lane.width}:${lane.direction}${lane.turn ? ':' + lane.turn : ''}${lane.markings === false ? ':nomark' : ''}`
		)
		.join(',');

async function seedGraph(page: import('@playwright/test').Page) {
	await page.goto('/?topdown');
	await expect(page.locator('canvas')).toBeVisible();
	await page.evaluate(
		({ key, data }) => {
			localStorage.setItem(key, JSON.stringify(data));
		},
		{ key: STORAGE_KEY, data: GRAPH_DATA }
	);
	await page.reload();
	await expect(page.locator('canvas')).toBeVisible();
	await expect(page.locator('nav')).toBeVisible();
}

const savedGraph = (page: import('@playwright/test').Page) =>
	page.evaluate((key) => {
		const data = localStorage.getItem(key);
		return data ? (JSON.parse(data) as SavedGraph) : null;
	}, STORAGE_KEY);

async function selectSegment(page: import('@playwright/test').Page, x: number, y: number) {
	await page.locator('canvas').click({ position: toScreen(x, y) });
	await expect(page.locator('aside')).toBeVisible();
}

test.describe('segment copy/paste', () => {
	test.beforeEach(async ({ page }) => {
		await seedGraph(page);
	});

	test('pastes copied lanes onto selected segments', async ({ page }) => {
		await selectSegment(page, -150, -90);
		await page.keyboard.press('Meta+c');

		await selectSegment(page, -150, 80);
		await page.keyboard.press('Meta+v');

		const firstKey = laneKey(GRAPH_DATA.segments[0].lanes);
		await expect
			.poll(async () => {
				const graph = await savedGraph(page);
				const second = graph?.segments.find((segment) => segment.id === 'segment-1');
				return second ? laneKey(second.lanes) : null;
			})
			.toBe(firstKey);

		const graph = await savedGraph(page);
		expect(graph?.segments.find((segment) => segment.id === 'segment-0')?.lanes).toEqual(
			GRAPH_DATA.segments[0].lanes
		);
	});

	test('pastes copied segments as new graph elements when selection is empty', async ({ page }) => {
		await selectSegment(page, -150, -90);
		await page.keyboard.press('Meta+c');
		await page.keyboard.press('Escape');
		await expect(page.locator('aside')).not.toBeVisible();

		await page.keyboard.press('Meta+v');

		await expect
			.poll(async () => {
				const graph = await savedGraph(page);
				return graph?.segments.length ?? 0;
			})
			.toBe(GRAPH_DATA.segments.length + 1);

		const graph = await savedGraph(page);
		expect(graph).not.toBeNull();
		const clone = graph!.segments.find(
			(segment) => !GRAPH_DATA.segments.some((s) => s.id === segment.id)
		);
		expect(clone).toBeDefined();
		expect(clone!.lanes).toEqual(GRAPH_DATA.segments[0].lanes);
		expect(clone!.controlX).toBe(GRAPH_DATA.segments[0].controlX! + 16);
		expect(clone!.controlY).toBe(GRAPH_DATA.segments[0].controlY! + 16);

		const clonedStart = graph!.nodes.find((node) => node.id === clone!.startNodeId);
		const clonedEnd = graph!.nodes.find((node) => node.id === clone!.endNodeId);
		expect(clonedStart).toMatchObject({ x: -204, y: -44 });
		expect(clonedEnd).toMatchObject({ x: -64, y: -44 });
		expect(clonedStart?.disabledConnections).toEqual([
			{
				from: { segmentId: clone!.id, laneIndex: 1 },
				to: { segmentId: clone!.id, laneIndex: 2 }
			}
		]);
	});
});
