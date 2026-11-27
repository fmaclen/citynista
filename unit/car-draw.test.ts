import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import type { GraphData } from '../src/lib/core/types';
import { byId, FILE, gestures, previewOf, type Driver } from './car-draw';
import { frame, openEditor } from './editor.svelte';

// Drawing car roads with car presets does what it always did: each gesture
// in unit/car-draw.ts, done in the editor opened afresh, leaves what is
// recorded of it: the graph after each Undo and Redo on the way, the roads
// the preview shows while a road is pending, and the graph saved at the end.
// Each note is held to two records:
//
// - e2e/car-draw.json, the page's record of every gesture from before
//   footpaths were a network of their own. Its worth is that it predates
//   them, so it is never recorded again. A click on the page lands on a
//   whole pixel and one here does not, which moves a road's end by up to
//   0.15 m (`TOLERANCE`), so a note matches it with every coordinate within
//   that and everything else exactly: as many nodes, each at its recorded
//   node's place under the same id, every segment joining the same nodes
//   with the same lanes, shifts and id.
// - unit/car-draw.json, the same notes as the editor in Node takes them,
//   matched exactly, so a drift smaller than the tolerance shows too.
//   RECORD=1 writes each gesture's notes afresh into it as it runs now,
//   keeping the others', and still holds them to the page's record.

// Metres a pixel at the browser's top-down camera at zoom 4 (720 px for
// 500 m at zoom 1), so snap rings measured in pixels are the page's.
const perPixel = 500 / 720 / 4;
const record = !!process.env.RECORD;
const read = (file = FILE) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
const baseline = read('e2e/car-draw.json');

// Metres a coordinate may stray from the page's record; the gestures stray
// 0.145 m at most.
const TOLERANCE = 0.15;
const coordinates = new Set(['x', 'y', 'controlX', 'controlY']);
// `value` with each coordinate within the tolerance of the one `recorded`
// holds at the same place replaced by it, so comparing the result with
// `recorded` finds only the coordinates that stray further and whatever
// else differs.
function within(value: unknown, recorded: unknown, key?: string): unknown {
	if (typeof value === 'number' && typeof recorded === 'number')
		return key && coordinates.has(key) && Math.abs(value - recorded) <= TOLERANCE
			? recorded
			: value;
	if (Array.isArray(value) && Array.isArray(recorded))
		return value.map((v, i) => within(v, recorded[i]));
	if (value && recorded && typeof value === 'object' && typeof recorded === 'object') {
		const other = recorded as Record<string, unknown>;
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, within(v, other[k], k)]));
	}
	return value;
}

// Gestures whose last click the page's record never saw. On the page the
// lane panel lies over the top right of the map while a road is drawn, and
// a click there lands on the panel, not the map. In "redo with a new start
// on the street" the click at (30, -25) is one, so the second road it asks
// for was never laid: the saved graph in the record is the graph the
// gesture had laid before that click, so that is what it is compared with.
const missedLastClick = new Set(['redo with a new start on the street']);

for (const [name, gesture] of Object.entries(gestures))
	test(`car-only draw gestures do what they always did: ${name}`, async () => {
		const recorded = read();
		const notes: Record<string, unknown> = {};
		const check = (key: string, value: unknown, asPageSaw = value) => {
			if (record) notes[key] = value;
			else expect([key, value]).toEqual([key, recorded[key]]);
			expect([key, within(asPageSaw, baseline[key])]).toEqual([key, baseline[key]]);
		};
		const ui = openEditor(structuredClone(gesture.graph), perPixel);
		// Where the pointer is, so a move to a point steps there from it.
		let at = { x: 0, y: 0 };
		// The graph as it stood before the latest click.
		let beforeClick: unknown;
		const hover = async (x: number, y: number, steps = 4) => {
			for (let k = 1; k <= steps; k++)
				ui.hover(at.x + ((x - at.x) * k) / steps, at.y + ((y - at.y) * k) / steps);
			at = { x, y };
		};
		const press = (key: string, o: { shift?: boolean; ctrl?: boolean } = {}) => ui.key(key, o);
		const driver: Driver = {
			street: async (style = 'Straight') => {
				ui.brush('Street');
				ui.editor.setDrawStyle(style === 'Straight' ? 'straight' : 'curve');
			},
			click: async (x, y) => {
				await hover(x, y, 1);
				beforeClick = byId(ui.graph());
				ui.click(x, y);
			},
			hover: (x, y) => hover(x, y),
			escape: async () => {
				press('Escape');
				press('Escape');
			},
			undo: async () => press('z', { ctrl: true }),
			redo: async () => press('z', { ctrl: true, shift: true }),
			split: async () => {
				ui.editor.mode = 'split';
				frame();
			},
			key: async (name) => press(name),
			join: async () => {
				ui.editor.joinNode(ui.editor.joinableNodeId!);
				frame();
			}
		};
		await gesture.run(driver, async (label, what = 'graph') =>
			check(
				`${name} / ${label}`,
				what === 'graph' ? byId(ui.graph()) : previewOf(ui.editor.ghost?.graph.toJSON())
			)
		);
		// The stored graph: what Save writes.
		ui.editor.currentCityId = 'test';
		ui.editor.save();
		const stored = JSON.parse(localStorage.getItem('citynista:city:test')!).graph as GraphData;
		check(name, byId(stored), missedLastClick.has(name) ? beforeClick : byId(stored));
		if (!record) return;
		const kept = Object.entries(read()).filter(
			([key]) => key !== name && !key.startsWith(`${name} / `)
		);
		writeFileSync(
			FILE,
			JSON.stringify({ ...Object.fromEntries(kept), ...notes }, null, '\t') + '\n'
		);
	});
