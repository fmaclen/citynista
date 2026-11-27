import { expect, type Page } from '@playwright/test';
import { SCHEMA_VERSION } from '../src/lib/core/city-store';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { shownAt } from '../src/lib/core/road-line';
import type { CameraState, GraphData, Lane, SegmentData } from '../src/lib/core/types';
import type { HandleRef } from '../src/lib/editor.svelte';
import type { HandleState } from '../src/lib/rendering/editor-palette';
import type { Control, Place } from '../src/lib/road-model/model';
import { buildModel, nodeOf, readScene, segmentOf } from '../unit/model';

export { nodeOf, segmentOf };

// Driving the editor in the browser: opening it on a city, reading what it
// stored or holds, and finding world points on screen. The default query
// fixes the top-down camera and exposes the live graph and road model.

export type Pt = { x: number; y: number };

// Opens the editor and waits until it shows `city`: by then the graph is
// loaded and the camera placed, so clicks land where `toScreen` says. A fresh
// browser context has empty storage, so the default is a new empty city.
export async function openEditor(page: Page, query = 'topdown&model', city = 'untitled') {
	await page.goto(`/?${query}`);
	await expect(page.getByTestId('city-name')).toHaveText(city);
}

export async function openScene(page: Page, name: string, query = 'topdown&model') {
	await openGraph(page, readScene(name), query, name);
}

// Boots the editor on a graph stored as the only city, at the current schema
// version, the way a city of your own would boot: through `camera` when given
// (and the query leaves out `topdown`).
export async function openGraph(
	page: Page,
	graph: GraphData,
	query = 'topdown&model',
	id = 'test',
	camera: CameraState | null = null
) {
	// Any same-origin page that doesn't boot the editor, so nothing saves first.
	await page.goto('/robots.txt');
	await page.evaluate(
		({ id, graph, camera, version }) => {
			localStorage.clear();
			localStorage.setItem(
				`citynista:city:${id}`,
				JSON.stringify({ id, name: id, graph, camera, version })
			);
			localStorage.setItem('citynista:cities', JSON.stringify([{ id, name: id, version }]));
			localStorage.setItem('citynista:current-city', id);
		},
		{ id, graph, camera, version: SCHEMA_VERSION }
	);
	await openEditor(page, query, id);
}

// Edits only reach storage on Save. Presses ⌘S/Ctrl+S and waits for the
// unsaved marker to clear.
export async function saveCity(page: Page) {
	await page.keyboard.press('ControlOrMeta+s');
	await expect(page.getByLabel('Unsaved changes')).toHaveCount(0);
}

// The editor's graph and road model as they stand, unsaved edits included.
// Needs `model` in the query, as the default one has.
export const liveGraph = (page: Page) =>
	page.evaluate(() => (window as Window & { __graph?: () => GraphData }).__graph!());
export const roadModel = (page: Page) =>
	page.evaluate(() => (window as Window & { __roadModel?: () => Place }).__roadModel?.());
// Waits until the editor draws its graph as a fresh build of it would
// (`__staleDrawing`): what it keeps from build to build missed no change.
export const expectFreshDrawing = (page: Page) =>
	expect
		.poll(() =>
			page.evaluate(() =>
				(window as Window & { __staleDrawing?: () => string[] }).__staleDrawing!()
			)
		)
		.toEqual([]);
// The drawing of the editor's graph as it stands, built the way the editor
// builds it (core/networks.ts), in Node, once the editor draws it so too.
export const drawingOf = async (page: Page) => {
	await expectFreshDrawing(page);
	return buildModel(await liveGraph(page)).scene;
};

// Screen pixels per metre at the top-down camera at zoom 1, in the 1280×720
// viewport.
export const PX_PER_M = 720 / 500;

// World to screen at the top-down camera at `zoom`, centred on `centre`
// (`cam=x,y,zoom` in the query); by default the world origin is the middle of
// the viewport.
export const screenAt =
	(zoom = 1, centre: Pt = { x: 0, y: 0 }) =>
	(x: number, y: number) => ({
		x: 640 + (x - centre.x) * PX_PER_M * zoom,
		y: 360 + (y - centre.y) * PX_PER_M * zoom
	});
export const toScreen = screenAt();

// What the editor shows over the map, as it reports it: the lane lit from
// the panel, the handle lit for its state, a selected node's setback guides,
// the roads a move in hand shows refused, the sidewalk lanes the connector
// shows its node joined to, the walkway each footpath node selected (or at
// an end of a footpath selected) is joined to (`segment:lane index`), and
// the open connector's node and each
// connection it shows (`segment:lane index` pairs, and the line each is
// drawn along where it follows one), and where the snap
// marker of a dead end held over a drop stands, the crossing whose control
// badge is open by a double-click (its id as drawn, its control and where the
// badge sits), every crossing badge shown (that one, or one on each crossing
// of the selection), and what is selected. Needs `model` in the query.
export interface EditorLook {
	lane: number | null;
	handle: { ref: HandleRef; state: HandleState } | null;
	guides: [Pt, Pt][];
	refused: string[];
	joined: string[];
	joins: { node: string; lane: string }[];
	connector: { node: string; links: [string, string][]; lines: Pt[][] } | null;
	drop: Pt | null;
	crossing: { id: string; control: Control; x: number; y: number } | null;
	crossings: { id: string; control: Control; x: number; y: number }[];
	selection: { nodes: string[]; segments: string[] };
}
export const editorLook = (page: Page) =>
	page.evaluate(() => (window as unknown as { __editorLook: () => EditorLook }).__editorLook());

// Selects a road by clicking where it shows, drags its offset handle `by`
// metres across it (to its right as drawn), holding Shift when `snap`, and
// deselects it.
export async function dragOffset(
	page: Page,
	view: (x: number, y: number) => Pt,
	road: string,
	by: number,
	snap = false
) {
	const graph = await liveGraph(page);
	const s = segmentOf(graph, road);
	const shifted = { ...s, offsetStart: s.offsetStart ?? 0, offsetEnd: s.offsetEnd ?? 0 };
	const [a, b] = [nodeOf(graph, s.startNodeId), nodeOf(graph, s.endNodeId)];
	const on = shownAt(shifted, a, b, 0.6).point;
	const middle = view(on.x, on.y);
	await page.mouse.click(middle.x, middle.y);
	await expect(page.locator('aside')).toBeVisible();
	const { point, normal } = shownAt(shifted, a, b, 0.25);
	const from = view(point.x, point.y);
	const to = view(point.x + normal.x * by, point.y + normal.y * by);
	if (snap) await page.keyboard.down('Shift');
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 8 });
	await page.mouse.up();
	if (snap) await page.keyboard.up('Shift');
	await page.keyboard.press('Escape');
}

// Select is the default mode and has no button of its own: the editor is in it
// when no preset slot (draw), Split or Bulldoze is pressed. The grid and lane
// connection toggles are independent and may be on.
export async function expectSelectMode(page: Page) {
	const nav = page.locator('nav');
	await expect(nav.locator('button[aria-label][aria-pressed="true"]')).toHaveCount(0);
	await expect(nav.getByTitle(/^Split/)).toHaveAttribute('aria-pressed', 'false');
	await expect(nav.getByTitle(/^Bulldoze/)).toHaveAttribute('aria-pressed', 'false');
}

// Building graphs to open: a point, lanes, and a graph from point and road
// tuples, each road a lane preset (a street where none is given) or lanes of
// its own, with any other segment fields after them.

export const p = (x: number, y: number): Pt => ({ x, y });

// Asphalt for a vehicle lane, concrete for any other.
export const lane = (
	id: string,
	role: Lane['role'],
	width: number,
	direction: Lane['direction'] = 'bidirectional'
): Lane => ({ id, role, width, direction, material: role === 'vehicle' ? 'asphalt' : 'concrete' });
export const sidewalk = (id: string, width = 2) => lane(id, 'pedestrian', width);

export type Kind = 'street' | 'avenue' | 'highway' | 'path' | 'lane';
export const graphOf = (
	points: [string, number, number][],
	roads: [string, string, string, (Kind | Lane[])?, Partial<SegmentData>?][]
): GraphData => ({
	nodes: points.map(([id, x, y]) => ({ id, x, y })),
	segments: roads.map(([id, startNodeId, endNodeId, lanes = 'street', more]) => ({
		id,
		startNodeId,
		endNodeId,
		lanes: typeof lanes === 'string' ? createLanesFrom(lanes) : lanes,
		...more
	}))
});

// The ids of the roads at a node.
export const roadsAt = (graph: GraphData, node: string) =>
	graph.segments.filter((s) => s.startNodeId === node || s.endNodeId === node).map((s) => s.id);
export const isCar = (s: SegmentData) => s.lanes.some((l) => l.role === 'vehicle');
export const walks = (graph: GraphData) => graph.segments.filter((s) => !isCar(s));

// Opens `graph` top-down at `zoom`, centred on `centre`, where `screenAt`
// with the same two maps world to screen.
export const openAt = (page: Page, graph: GraphData, zoom = 1, centre: Pt = p(0, 0)) =>
	openGraph(page, graph, `topdown&model&cam=${centre.x},${centre.y},${zoom}`);

export const undoButton = (page: Page) => page.getByTitle('Undo (⌘Z)');
export const redoButton = (page: Page) => page.getByTitle('Redo (⇧⌘Z)');
export const unsavedMarker = (page: Page) => page.getByLabel('Unsaved changes');
// The graph as stored, which only Save writes.
export const storedGraph = (page: Page, id = 'test') =>
	page.evaluate(
		(id) => JSON.parse(localStorage.getItem(`citynista:city:${id}`)!).graph as GraphData,
		id
	);
export const nextFrame = (page: Page) => page.evaluate(() => new Promise(requestAnimationFrame));

export const snapshot = async (page: Page) => JSON.stringify(await liveGraph(page));

// After an edit (the graph `before` it, as `snapshot` reads it), one undo
// step that gives back the graph as it was, a redo that makes it again, and
// a save and reload reading it back; `reads` checks what the edit made in
// each state it is in, `readsBefore` what stood before it.
export async function throughHistory(
	page: Page,
	before: string,
	reads: () => Promise<void>,
	readsBefore: () => Promise<void> = async () => {}
) {
	const after = await snapshot(page);
	expect(after).not.toBe(before);
	await reads();
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => snapshot(page)).toBe(before);
	await readsBefore();
	await page.keyboard.press('ControlOrMeta+Shift+z');
	await expect.poll(() => snapshot(page)).toBe(after);
	await reads();
	await saveCity(page);
	await page.reload();
	await expect(page.getByTestId('city-name')).toHaveText('test');
	expect(await snapshot(page)).toBe(after);
	await expect(unsavedMarker(page)).toHaveCount(0);
	await reads();
}

// A screenshot with the pointer out of the way.
export const shot = async (page: Page, path: string) => {
	await page.mouse.move(5, 5);
	await page.screenshot({ path });
};
export const button = (page: Page, name: string) =>
	page.getByRole('button', { name, exact: true }).click();

// Gestures at world points, top-down at `zoom` centred on `centre` (as
// `openAt` opens). `ground` is open ground: a click there drops the
// selection, and with it the crossing badges a selected road shows.
export function gestures(
	page: Page,
	zoom = 1,
	centre: Pt = p(0, 0),
	{ ground }: { ground?: Pt } = {}
) {
	const toView = screenAt(zoom, centre);
	const view = (q: Pt) => toView(q.x, q.y);
	const move = (q: Pt, steps = 1) => page.mouse.move(view(q).x, view(q).y, { steps });
	const click = async (q: Pt) => {
		await move(q);
		await page.mouse.click(view(q).x, view(q).y);
	};
	const dblclick = (q: Pt) => page.mouse.dblclick(view(q).x, view(q).y);
	// Presses at one point and lets go at another.
	const drag = async (from: Pt, to: Pt, steps = 8) => {
		await move(from);
		await page.mouse.down();
		await move(to, steps);
		await page.mouse.up();
	};
	// Presses at `from` and moves to `to` by way of the midpoint, held there
	// until the move has been checked (one frame after the last pointer
	// move); runs `whileHeld` and reads what the editor shows, the button
	// still down.
	const hold = async (from: Pt, to: Pt, whileHeld?: () => Promise<void>) => {
		await move(from);
		await page.mouse.down();
		await move(p((from.x + to.x) / 2, (from.y + to.y) / 2), 4);
		await move(to, 4);
		await nextFrame(page);
		await whileHeld?.();
		return editorLook(page);
	};
	// Draws a straight run of the brush through some points, each click free
	// of any snap (Ctrl held) but where `snap` says.
	const draw = async (brush: string, points: Pt[], snap: boolean[] = []) => {
		await button(page, brush);
		await button(page, 'Straight');
		for (const [k, q] of points.entries()) {
			if (snap[k]) await page.keyboard.up('Control');
			else await page.keyboard.down('Control');
			await move(q, 4);
			await page.mouse.click(view(q).x, view(q).y);
		}
		await page.keyboard.up('Control');
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
	};
	const deselect = async () => {
		if (!ground) throw new Error('gestures: no open ground given to deselect on');
		await click(ground);
		await expect
			.poll(async () => (await editorLook(page)).selection)
			.toEqual({ nodes: [], segments: [] });
	};
	// Opens the badge of the crossing at `q` by double-clicking its zebra,
	// after a click on `ground` when given, and waits for it.
	const openBadge = async (q: Pt) => {
		if (ground) await click(ground);
		await dblclick(q);
		await expect.poll(async () => (await editorLook(page)).crossing).not.toBeNull();
	};
	const closeBadge = async () => {
		await page.keyboard.press('Escape');
		await expect.poll(async () => (await editorLook(page)).crossing).toBeNull();
	};
	// The control the badge of the crossing at `q` reads.
	const badgeAt = async (q: Pt) => {
		await openBadge(q);
		const control = (await editorLook(page)).crossing!.control;
		await closeBadge();
		return control;
	};
	// Clicks the badge of the crossing at `q` on until it reads `control`.
	const setControl = async (q: Pt, control: Control) => {
		await openBadge(q);
		const badge = page.getByRole('button', { name: /^Crossing control/ });
		for (let k = 0; k < 4; k++) {
			if ((await editorLook(page)).crossing?.control === control) break;
			await badge.click();
		}
		await expect.poll(async () => (await editorLook(page)).crossing?.control).toBe(control);
		await closeBadge();
	};
	return { view, move, click, dblclick, drag, hold, draw, deselect, badgeAt, setControl };
}
