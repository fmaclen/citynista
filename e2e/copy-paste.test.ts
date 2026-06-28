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

const NODE_CONNECTION_LANES = [
	{ type: 'sidewalk', width: 2, direction: 'bidirectional' },
	{ type: 'road', width: 3, direction: 'backward' },
	{ type: 'road', width: 3, direction: 'forward' },
	{ type: 'sidewalk', width: 2, direction: 'bidirectional' }
];

const NODE_CONNECTION_GRAPH_DATA = {
	nodes: [
		{
			id: 'node-a',
			x: -220,
			y: -30,
			disabledConnections: [
				{
					from: { segmentId: 'segment-a-north', laneIndex: 1 },
					to: { segmentId: 'segment-a-east', laneIndex: 2 }
				},
				{
					from: { segmentId: 'segment-a-south', laneIndex: 2 },
					to: { segmentId: 'segment-a-west', laneIndex: 1 }
				},
				{
					from: { segmentId: 'segment-a-east', laneIndex: 0 },
					to: { segmentId: 'segment-a-north', laneIndex: 3 }
				}
			]
		},
		{ id: 'node-a-north', x: -220, y: -110 },
		{ id: 'node-a-east', x: -140, y: -30 },
		{ id: 'node-a-south', x: -220, y: 50 },
		{ id: 'node-a-west', x: -300, y: -30 },
		{
			id: 'node-b',
			x: 100,
			y: -30,
			disabledConnections: [
				{
					from: { segmentId: 'segment-b-west', laneIndex: 1 },
					to: { segmentId: 'segment-b-south', laneIndex: 2 }
				}
			]
		},
		{ id: 'node-b-north', x: 100, y: -110 },
		{ id: 'node-b-east', x: 180, y: -30 },
		{ id: 'node-b-south', x: 100, y: 50 },
		{ id: 'node-b-west', x: 20, y: -30 }
	],
	segments: [
		{
			id: 'segment-a-north',
			startNodeId: 'node-a',
			endNodeId: 'node-a-north',
			lanes: NODE_CONNECTION_LANES
		},
		{
			id: 'segment-a-east',
			startNodeId: 'node-a',
			endNodeId: 'node-a-east',
			lanes: NODE_CONNECTION_LANES
		},
		{
			id: 'segment-a-south',
			startNodeId: 'node-a',
			endNodeId: 'node-a-south',
			lanes: NODE_CONNECTION_LANES
		},
		{
			id: 'segment-a-west',
			startNodeId: 'node-a',
			endNodeId: 'node-a-west',
			lanes: NODE_CONNECTION_LANES
		},
		{
			id: 'segment-b-north',
			startNodeId: 'node-b',
			endNodeId: 'node-b-north',
			lanes: NODE_CONNECTION_LANES
		},
		{
			id: 'segment-b-east',
			startNodeId: 'node-b',
			endNodeId: 'node-b-east',
			lanes: NODE_CONNECTION_LANES
		},
		{
			id: 'segment-b-south',
			startNodeId: 'node-b',
			endNodeId: 'node-b-south',
			lanes: NODE_CONNECTION_LANES
		},
		{
			id: 'segment-b-west',
			startNodeId: 'node-b',
			endNodeId: 'node-b-west',
			lanes: NODE_CONNECTION_LANES
		}
	]
};

const SCALE = 720 / 500;
const toScreen = (x: number, y: number) => ({ x: 640 + x * SCALE, y: 360 + y * SCALE });

interface SavedLane {
	role: string;
	material: string;
	width: number;
	direction: string;
	raised?: boolean;
	markings?: boolean;
}

interface SavedConnection {
	from: { segmentId: string; laneIndex: number };
	to: { segmentId: string; laneIndex: number };
}

interface SavedNode {
	id: string;
	x: number;
	y: number;
	disabledConnections?: SavedConnection[];
	enabledConnections?: SavedConnection[];
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

const EXPECTED_SEGMENT_0_LANES: SavedLane[] = [
	{ role: 'pedestrian', material: 'pavement', width: 2, direction: 'bidirectional' },
	{ role: 'vehicle', material: 'asphalt', width: 3, direction: 'backward' },
	{ role: 'vehicle', material: 'asphalt', width: 3, direction: 'forward', markings: false },
	{ role: 'pedestrian', material: 'pavement', width: 2, direction: 'bidirectional' }
];

const laneKey = (lanes: SavedLane[]) =>
	lanes
		.map(
			(lane) =>
				`${lane.role}:${lane.material}:${lane.width}:${lane.direction}${lane.raised ? ':raised' : ''}${lane.markings === false ? ':nomark' : ''}`
		)
		.join(',');

async function seedGraph(page: import('@playwright/test').Page, data = GRAPH_DATA) {
	await page.goto('/?topdown');
	await expect(page.locator('canvas')).toBeVisible();
	await page.evaluate(
		({ key, data }) => {
			localStorage.setItem(key, JSON.stringify(data));
		},
		{ key: STORAGE_KEY, data }
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

async function selectNode(page: import('@playwright/test').Page, x: number, y: number) {
	await page.locator('canvas').click({ position: toScreen(x, y) });
}

const sortedArms = (graph: SavedGraph, nodeId: string) => {
	const node = graph.nodes.find((n) => n.id === nodeId);
	if (!node) return [];

	return graph.segments
		.filter((segment) => segment.startNodeId === nodeId || segment.endNodeId === nodeId)
		.map((segment) => {
			const otherNodeId = segment.startNodeId === nodeId ? segment.endNodeId : segment.startNodeId;
			const other = graph.nodes.find((n) => n.id === otherNodeId);
			const dx = other ? other.x - node.x : 0;
			const dy = other ? other.y - node.y : 0;
			return {
				segmentId: segment.id,
				laneCount: segment.lanes.length,
				angle: Math.atan2(dy, dx)
			};
		})
		.sort((a, b) => a.angle - b.angle)
		.map(({ segmentId, laneCount }) => ({ segmentId, laneCount }));
};

const remapConnections = (
	connections: SavedConnection[],
	sourceArms: { segmentId: string; laneCount: number }[],
	targetArms: { segmentId: string; laneCount: number }[]
) => {
	const sourceArmIndices = new Map(sourceArms.map((arm, index) => [arm.segmentId, index]));
	return connections
		.map((connection) => {
			const fromArmIndex = sourceArmIndices.get(connection.from.segmentId);
			const toArmIndex = sourceArmIndices.get(connection.to.segmentId);
			const fromArm = fromArmIndex !== undefined ? targetArms[fromArmIndex] : undefined;
			const toArm = toArmIndex !== undefined ? targetArms[toArmIndex] : undefined;
			if (
				!fromArm ||
				!toArm ||
				connection.from.laneIndex >= fromArm.laneCount ||
				connection.to.laneIndex >= toArm.laneCount
			) {
				return null;
			}
			return {
				from: { segmentId: fromArm.segmentId, laneIndex: connection.from.laneIndex },
				to: { segmentId: toArm.segmentId, laneIndex: connection.to.laneIndex }
			};
		})
		.filter((connection) => connection !== null);
};

test.describe('segment copy/paste', () => {
	test.beforeEach(async ({ page }) => {
		await seedGraph(page);
	});

	test('pastes copied lanes onto selected segments', async ({ page }) => {
		await selectSegment(page, -150, -90);
		await page.keyboard.press('Meta+c');

		await selectSegment(page, -150, 80);
		await page.keyboard.press('Meta+v');

		const firstKey = laneKey(EXPECTED_SEGMENT_0_LANES);
		await expect
			.poll(async () => {
				const graph = await savedGraph(page);
				const second = graph?.segments.find((segment) => segment.id === 'segment-1');
				return second ? laneKey(second.lanes) : null;
			})
			.toBe(firstKey);

		const graph = await savedGraph(page);
		expect(graph?.segments.find((segment) => segment.id === 'segment-0')?.lanes).toEqual(
			EXPECTED_SEGMENT_0_LANES
		);
	});

	test('pastes copied segments as new graph elements when selection is empty', async ({ page }) => {
		await selectSegment(page, -150, -90);
		await page.keyboard.press('Meta+c');
		await page.keyboard.press('Escape');
		await expect(page.locator('aside')).not.toBeVisible();

		// Paste enters a placement mode that follows the cursor; move the ghost
		// to clear ground (its node centroid lands on the cursor) and click to
		// confirm. Centroid of segment-0's endpoints is (-150, -60), so dropping
		// it at (150, 0) shifts the clone by (+300, +60).
		await page.keyboard.press('Meta+v');
		const drop = toScreen(150, 0);
		await page.mouse.move(drop.x, drop.y);
		await page.mouse.click(drop.x, drop.y);

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
		expect(clone!.lanes).toEqual(EXPECTED_SEGMENT_0_LANES);
		expect(clone!.controlX!).toBeCloseTo(150, 0);
		expect(clone!.controlY!).toBeCloseTo(-60, 0);

		const clonedStart = graph!.nodes.find((node) => node.id === clone!.startNodeId);
		const clonedEnd = graph!.nodes.find((node) => node.id === clone!.endNodeId);
		expect(clonedStart!.x).toBeCloseTo(80, 0);
		expect(clonedStart!.y).toBeCloseTo(0, 0);
		expect(clonedEnd!.x).toBeCloseTo(220, 0);
		expect(clonedEnd!.y).toBeCloseTo(0, 0);
		expect(clonedStart?.disabledConnections).toEqual([
			{
				from: { segmentId: clone!.id, laneIndex: 1 },
				to: { segmentId: clone!.id, laneIndex: 2 }
			}
		]);
	});

	test('cuts a selected segment and pastes it as a new graph element', async ({ page }) => {
		await selectSegment(page, -150, -90);
		await page.keyboard.press('Meta+x');

		// Cut removes the source segment and clears the selection.
		await expect(page.locator('aside')).not.toBeVisible();
		await expect
			.poll(async () => (await savedGraph(page))?.segments.map((segment) => segment.id))
			.toEqual(['segment-1']);

		// The cut segment is still on the clipboard — paste drops a fresh clone.
		await page.keyboard.press('Meta+v');
		const drop = toScreen(150, 0);
		await page.mouse.move(drop.x, drop.y);
		await page.mouse.click(drop.x, drop.y);

		await expect
			.poll(async () => (await savedGraph(page))?.segments.length ?? 0)
			.toBe(2);

		const graph = await savedGraph(page);
		expect(graph?.segments.some((segment) => segment.id === 'segment-0')).toBe(false);
		const clone = graph!.segments.find((segment) => segment.id !== 'segment-1');
		expect(clone).toBeDefined();
		expect(clone!.lanes).toEqual(EXPECTED_SEGMENT_0_LANES);
	});

	test('pastes copied node connector config onto a matching junction', async ({ page }) => {
		await seedGraph(page, NODE_CONNECTION_GRAPH_DATA);

		await selectNode(page, -220, -30);
		await page.keyboard.press('Meta+c');
		await selectNode(page, 100, -30);
		await page.keyboard.press('Meta+v');

		const sourceConnections = NODE_CONNECTION_GRAPH_DATA.nodes[0].disabledConnections;
		const sourceArms = sortedArms(NODE_CONNECTION_GRAPH_DATA, 'node-a');
		const targetArms = sortedArms(NODE_CONNECTION_GRAPH_DATA, 'node-b');
		const expectedConnections = remapConnections(sourceConnections, sourceArms, targetArms);

		await expect
			.poll(async () => {
				const graph = await savedGraph(page);
				const target = graph?.nodes.find((node) => node.id === 'node-b');
				return target?.disabledConnections ?? null;
			})
			.toEqual(expectedConnections);

		const graph = await savedGraph(page);
		const source = graph?.nodes.find((node) => node.id === 'node-a');
		const target = graph?.nodes.find((node) => node.id === 'node-b');
		expect(source?.disabledConnections).toEqual(sourceConnections);
		expect(target?.enabledConnections).toBeUndefined();
	});
});
