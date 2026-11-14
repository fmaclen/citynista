import { expect, type Page } from '@playwright/test';
import { SCHEMA_VERSION } from '../src/lib/core/city-store';
import { shownAt } from '../src/lib/core/road-line';
import type { CameraState, GraphData } from '../src/lib/core/types';
import type { Place } from '../src/lib/road-model/model';
import { nodeOf, readScene, segmentOf } from '../unit/model';

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

// The red, green and blue (0-255) of each screen pixel in a box, row by row.
export async function pixels(
	page: Page,
	clip: { x: number; y: number; width: number; height: number }
) {
	const png = await page.screenshot({ clip });
	return page.evaluate(async (data) => {
		const img = new Image();
		img.src = `data:image/png;base64,${data}`;
		await img.decode();
		const canvas = document.createElement('canvas');
		canvas.width = img.width;
		canvas.height = img.height;
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(img, 0, 0);
		const px = ctx.getImageData(0, 0, img.width, img.height).data;
		return Array.from({ length: px.length / 4 }, (_, i) => [
			px[i * 4],
			px[i * 4 + 1],
			px[i * 4 + 2]
		]);
	}, png.toString('base64'));
}

// Mean red, green and blue of the 3x3 screen pixels around a point.
export async function colourAt(page: Page, at: Pt) {
	const all = await pixels(page, { x: at.x - 1.5, y: at.y - 1.5, width: 3, height: 3 });
	return [0, 1, 2].map((c) => all.reduce((sum, p) => sum + p[c], 0) / all.length);
}

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
