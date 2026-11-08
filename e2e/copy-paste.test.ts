import { expect, test } from '@playwright/test';
import { saveCity } from './save';

const STORAGE_KEY = 'citynista-graph-v2';

interface SavedLaneRef {
	road: string;
	end: 'start' | 'end';
	lane: string;
}

interface SavedConnection {
	from: SavedLaneRef;
	to: SavedLaneRef;
}

interface SavedCrossing {
	road: string;
	end: 'start' | 'end';
	lanes: [string, string];
	at?: number;
	on?: boolean;
}

interface SavedJunction {
	connections: SavedConnection[];
	added?: SavedConnection[];
	removed?: SavedConnection[];
	crossings?: SavedCrossing[];
	control?: Record<string, string>;
	taper?: number;
}

interface SavedLane {
	id?: string;
	role: string;
	material: string;
	width: number;
	direction: string;
	raised?: boolean;
}

interface SavedNode {
	id: string;
	x: number;
	y: number;
	junction?: SavedJunction;
}

interface SavedSegment {
	id: string;
	startNodeId: string;
	endNodeId: string;
	controlX?: number;
	controlY?: number;
	offset?: number;
	lanes: SavedLane[];
}

interface SavedGraph {
	nodes: SavedNode[];
	segments: SavedSegment[];
}

// node-0's U-turn from the backward lane into the forward lane, switched off.
const SEGMENT_0_JUNCTION: SavedJunction = {
	connections: [],
	removed: [
		{
			from: { road: 'segment-0', end: 'start', lane: 'l1' },
			to: { road: 'segment-0', end: 'start', lane: 'l2' }
		}
	]
};

const GRAPH_DATA = {
	nodes: [
		{ id: 'node-0', x: -220, y: -60, junction: SEGMENT_0_JUNCTION },
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
			offset: 1.5,
			lanes: [
				{ type: 'sidewalk', width: 2, direction: 'bidirectional' },
				{ type: 'road', width: 3, direction: 'backward' },
				{ type: 'turn', width: 3, direction: 'forward', turn: 'left' },
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
	{ id: 'l0', role: 'pedestrian', material: 'pavement', width: 2, direction: 'bidirectional' },
	{ id: 'l1', role: 'vehicle', material: 'asphalt', width: 3, direction: 'backward' },
	{ id: 'l2', role: 'vehicle', material: 'asphalt', width: 3, direction: 'forward' },
	{ id: 'l3', role: 'pedestrian', material: 'pavement', width: 2, direction: 'bidirectional' }
];

// Every arm starts at its junction, so l1 (backward) arrives and l2 (forward)
// leaves.
const at = (road: string, lane: string): SavedLaneRef => ({ road, end: 'start', lane });

const NODE_A_JUNCTION: SavedJunction = {
	connections: [],
	added: [{ from: at('segment-a-east', 'l1'), to: at('segment-a-north', 'l2') }],
	removed: [
		{ from: at('segment-a-north', 'l1'), to: at('segment-a-east', 'l2') },
		{ from: at('segment-a-south', 'l1'), to: at('segment-a-west', 'l2') }
	],
	crossings: [{ road: 'segment-a-east', end: 'start', lanes: ['l0', 'l3'], on: false }],
	control: { 'segment-a-north:start': 'signal', 'segment-a-west:start': 'yield' },
	taper: 12
};

const NODE_B_JUNCTION: SavedJunction = {
	connections: [],
	removed: [{ from: at('segment-b-west', 'l1'), to: at('segment-b-south', 'l2') }]
};

const NODE_CONNECTION_GRAPH_DATA = {
	nodes: [
		{ id: 'node-a', x: -220, y: -30, junction: NODE_A_JUNCTION },
		{ id: 'node-a-north', x: -220, y: -110 },
		{ id: 'node-a-east', x: -140, y: -30 },
		{ id: 'node-a-south', x: -220, y: 50 },
		{ id: 'node-a-west', x: -300, y: -30 },
		{ id: 'node-b', x: 100, y: -30, junction: NODE_B_JUNCTION },
		{ id: 'node-b-north', x: 100, y: -110 },
		{ id: 'node-b-east', x: 180, y: -30 },
		{ id: 'node-b-south', x: 100, y: 50 },
		{ id: 'node-b-west', x: 20, y: -30 }
	],
	segments: (['a', 'b'] as const).flatMap((n) =>
		(['north', 'east', 'south', 'west'] as const).map((arm) => ({
			id: `segment-${n}-${arm}`,
			startNodeId: `node-${n}`,
			endNodeId: `node-${n}-${arm}`,
			lanes: NODE_CONNECTION_LANES
		}))
	)
};

// The hand edits a junction stores; `connections` is worked out from the roads
// and these edits, so it is left out of comparisons.
const edits = (junction: SavedJunction | undefined) =>
	junction ? { ...junction, connections: undefined } : undefined;

const SCALE = 720 / 500;
const toScreen = (x: number, y: number) => ({ x: 640 + x * SCALE, y: 360 + y * SCALE });

const EXPECTED_SEGMENT_0_LANES: SavedLane[] = [
	{ id: 'l0', role: 'pedestrian', material: 'pavement', width: 2, direction: 'bidirectional' },
	{ id: 'l1', role: 'vehicle', material: 'asphalt', width: 3, direction: 'backward' },
	{ id: 'l2', role: 'vehicle', material: 'asphalt', width: 3, direction: 'forward' },
	{ id: 'l3', role: 'pedestrian', material: 'pavement', width: 2, direction: 'bidirectional' }
];

const laneKey = (lanes: SavedLane[]) =>
	lanes
		.map(
			(lane) =>
				`${lane.role}:${lane.material}:${lane.width}:${lane.direction}${lane.raised ? ':raised' : ''}`
		)
		.join(',');

async function seedGraph(page: import('@playwright/test').Page, data: object = GRAPH_DATA) {
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

const savedGraph = async (page: import('@playwright/test').Page) => {
	await saveCity(page);
	return page.evaluate((key) => {
		const data = localStorage.getItem(key);
		return data ? (JSON.parse(data) as SavedGraph) : null;
	}, STORAGE_KEY);
};

async function selectSegment(page: import('@playwright/test').Page, x: number, y: number) {
	await page.locator('canvas').click({ position: toScreen(x, y) });
	await expect(page.locator('aside')).toBeVisible();
}

async function selectNode(page: import('@playwright/test').Page, x: number, y: number) {
	await page.locator('canvas').click({ position: toScreen(x, y) });
}

// A node's roads in the order the editor walks round it (by the angle each
// leaves at), which is how a pasted junction matches roads up.
const sortedArms = (graph: typeof NODE_CONNECTION_GRAPH_DATA, nodeId: string) => {
	const node = graph.nodes.find((n) => n.id === nodeId)!;
	return graph.segments
		.filter((segment) => segment.startNodeId === nodeId || segment.endNodeId === nodeId)
		.map((segment) => {
			const otherId = segment.startNodeId === nodeId ? segment.endNodeId : segment.startNodeId;
			const other = graph.nodes.find((n) => n.id === otherId)!;
			return { id: segment.id, angle: Math.atan2(other.y - node.y, other.x - node.x) };
		})
		.sort((a, b) => a.angle - b.angle)
		.map(({ id }) => id);
};

// The source junction's edits renamed onto the target's roads (same order
// round the node; every arm has the same lanes, so lane ids carry over).
const remapJunction = (junction: SavedJunction, sourceArms: string[], targetArms: string[]) => {
	const road = (id: string) => targetArms[sourceArms.indexOf(id)];
	const ref = (r: SavedLaneRef) => ({ ...r, road: road(r.road) });
	const pair = (c: SavedConnection) => ({ from: ref(c.from), to: ref(c.to) });
	return {
		added: junction.added?.map(pair),
		removed: junction.removed?.map(pair),
		crossings: junction.crossings?.map((c) => ({ ...c, road: road(c.road) })),
		control: Object.fromEntries(
			Object.entries(junction.control ?? {}).map(([key, value]) => {
				const [id, end] = key.split(':');
				return [`${road(id)}:${end}`, value];
			})
		),
		taper: junction.taper
	};
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
		expect(clone!.offset).toBe(1.5);
		// The copied node keeps its junction edits, renamed onto the clone.
		expect(edits(clonedStart!.junction)).toEqual({
			removed: [
				{
					from: { road: clone!.id, end: 'start', lane: 'l1' },
					to: { road: clone!.id, end: 'start', lane: 'l2' }
				}
			]
		});
		expect(edits(graph!.nodes.find((node) => node.id === 'node-0')?.junction)).toEqual(
			edits(SEGMENT_0_JUNCTION)
		);
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

		await expect.poll(async () => (await savedGraph(page))?.segments.length ?? 0).toBe(2);

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

		const expected = remapJunction(
			NODE_A_JUNCTION,
			sortedArms(NODE_CONNECTION_GRAPH_DATA, 'node-a'),
			sortedArms(NODE_CONNECTION_GRAPH_DATA, 'node-b')
		);

		// The paste replaces node-b's own edits outright.
		await expect
			.poll(async () => {
				const graph = await savedGraph(page);
				return edits(graph?.nodes.find((node) => node.id === 'node-b')?.junction) ?? null;
			})
			.toEqual(expected);

		const graph = await savedGraph(page);
		expect(edits(graph?.nodes.find((node) => node.id === 'node-a')?.junction)).toEqual(
			edits(NODE_A_JUNCTION)
		);
	});
});
