import { expect, test } from 'bun:test';
import { cityOf, frame, openEditor } from './editor.svelte';
import type { Graph } from '../src/lib/core/graph.svelte';

// With the brush switched to the other kind while anchored, a draw starts
// where a click of the new brush would (modes/draw.ts `switched`): the
// preview is laid from that start as the click lays the road.

test('a street drawn on from a path end it was switched at previews as it builds', () => {
	const ui = openEditor(
		cityOf({ a: [-60, 0], b: [0, 0] }, [{ id: 'path', from: 'a', to: 'b', lanes: 'path' }])
	);
	ui.editor.setDrawStyle('curve');
	ui.editor.activateSlot(3);
	ui.click(0, 0);
	ui.editor.activateSlot(0);
	ui.hover(40, 20);

	const shape = (s: { hasControlPoint: boolean; controlX?: number; controlY?: number }) =>
		s.hasControlPoint ? [s.controlX, s.controlY] : null;
	const previewed = [...ui.editor.ghost!.graph.segments.values()].find((s) => s.id !== 'path')!;
	ui.click(40, 20);
	const built = [...ui.editor.graph.segments.values()].find((s) => s.id !== 'path')!;

	// Nothing carries on into a new street node: both straight.
	expect(shape(previewed)).toEqual(shape(built));
	expect(shape(built)).toBeNull();
});

// Whatever changes what the next click lays while anchored (the brush armed
// by its key or cycled to, or the draw style), the preview is drawn again at
// once from where the pointer last was: a click there, without moving, lays
// what it showed.
test('a brush or style switched while anchored previews at once what the click lays', () => {
	const shapes = (
		segments: Iterable<{
			id: string;
			lanes: readonly { role: string }[];
			hasControlPoint: boolean;
			controlX?: number;
			controlY?: number;
		}>,
		old: Set<string>
	) =>
		[...segments]
			.filter((s) => !old.has(s.id))
			.map((s) => ({
				lanes: s.lanes.map((l) => l.role),
				control: s.hasControlPoint
					? [s.controlX, s.controlY].map((v) => Math.round(v! * 1e6) / 1e6)
					: null
			}));
	const switches: [string, (ui: ReturnType<typeof openEditor>) => void][] = [
		['street key', (ui) => ui.editor.activateSlot(0)],
		['path key', (ui) => ui.editor.activateSlot(3)],
		['cycled on', (ui) => ui.editor.cycleBrush(1)],
		['cycled back', (ui) => ui.editor.cycleBrush(-1)],
		['straight', (ui) => ui.editor.setDrawStyle('straight')],
		['curve', (ui) => ui.editor.setDrawStyle('curve')]
	];
	for (const style of ['straight', 'curve'] as const)
		for (const [from, slot] of [
			['path', 3],
			['street', 0]
		] as const)
			for (const [name, flip] of switches)
				for (const aim of [
					{ x: 40, y: 20 },
					{ x: 30, y: -35 }
				]) {
					const ui = openEditor(
						cityOf({ a: [-60, 0], b: [0, 0] }, [{ id: 'road', from: 'a', to: 'b', lanes: from }])
					);
					const old = new Set(ui.editor.graph.segments.keys());
					ui.editor.activateSlot(slot);
					ui.editor.setDrawStyle(style);
					ui.click(0, 0);
					ui.hover(aim.x, aim.y);
					flip(ui);
					const previewed = shapes(ui.editor.ghost?.graph.segments.values() ?? [], old);
					ui.click(aim.x, aim.y);
					const built = shapes(ui.editor.graph.segments.values(), old);
					expect({ style, from, name, aim, previewed }).toEqual({
						style,
						from,
						name,
						aim,
						previewed: built
					});
				}
});

// The same for every other thing that changes what the next click lays,
// in each draw style, circles included: the brush switched, the style, the
// grid toggled, and Shift (the angle lock) or Ctrl (no snapping) pressed or
// let go. The click, without moving, lays what the preview showed, ends and
// all.
test('whatever changes what the next click lays redraws its preview at once', () => {
	type Ui = ReturnType<typeof openEditor>;
	const keyUp = (key: string) => {
		frame();
		window.dispatchEvent(
			Object.assign(new Event('keyup'), {
				key,
				shiftKey: false,
				ctrlKey: false,
				metaKey: false,
				altKey: false
			})
		);
		frame();
	};
	type Change = {
		name: string;
		held?: { shift?: boolean; ctrl?: boolean };
		after?: { shift?: boolean; ctrl?: boolean };
		change: (ui: Ui) => void;
	};
	const changes: Change[] = [
		{ name: 'street key', change: (ui) => ui.editor.activateSlot(0) },
		{ name: 'path key', change: (ui) => ui.editor.activateSlot(3) },
		{ name: 'cycled on', change: (ui) => ui.editor.cycleBrush(1) },
		{ name: 'grid', change: (ui) => ui.editor.toggleGrid() },
		{ name: 'straight', change: (ui) => ui.editor.setDrawStyle('straight') },
		{ name: 'curve', change: (ui) => ui.editor.setDrawStyle('curve') },
		{
			name: 'Shift pressed',
			after: { shift: true },
			change: (ui) => ui.key('Shift', { shift: true })
		},
		{ name: 'Shift let go', held: { shift: true }, change: () => keyUp('Shift') },
		{
			name: 'Ctrl pressed',
			after: { ctrl: true },
			change: (ui) => ui.key('Control', { ctrl: true })
		},
		{ name: 'Ctrl let go', held: { ctrl: true }, change: () => keyUp('Control') }
	];
	let laidSome = 0;
	for (const style of ['straight', 'curve', 'circle'] as const)
		for (const slot of [3, 0])
			for (const grid of [false, true])
				for (const { name, held, after, change } of changes)
					for (const aim of [
						{ x: 24, y: 17 },
						{ x: 33, y: -26 }
					]) {
						const ui = openEditor(
							cityOf({ a: [-60, 0], b: [0, 0] }, [
								{ id: 'road', from: 'a', to: 'b', lanes: 'path' }
							])
						);
						if (grid) ui.editor.toggleGrid();
						const old = new Set(ui.editor.graph.segments.keys());
						ui.editor.activateSlot(slot);
						ui.editor.setDrawStyle(style);
						ui.click(0, 0);
						ui.hover(aim.x, aim.y, held);
						change(ui);
						// The mode a style switch enters is set up before the next event.
						frame();
						const ghost = ui.editor.ghost?.graph;
						// Of a circle, the ring alone: its pieces are curved, those of
						// the road it cuts straight.
						const ring = (shapes: string[]) =>
							style === 'circle' ? shapes.filter((x) => !x.includes('"control":null')) : shapes;
						const previewed = ring(ghost ? laid(ghost, old) : []);
						ui.click(aim.x, aim.y, after);
						const built = ring(laid(ui.editor.graph, old));
						if (built.length) laidSome++;
						expect({ style, slot, grid, name, aim, previewed }).toEqual({
							style,
							slot,
							grid,
							name,
							aim,
							previewed: built
						});
					}
	expect(laidSome).toBeGreaterThan(200);
}, 30_000);

// The roads in `graph` not among `old`: each one's lanes, curve's handle
// and ends, rounded to the micrometre, in a stable order.
function laid(graph: Graph, old: Set<string>) {
	const r = (v: number) => Math.round(v * 1e6) / 1e6;
	const at = (id: string) => {
		const n = graph.nodes.get(id);
		return n ? [r(n.x), r(n.y)] : null;
	};
	return [...graph.segments.values()]
		.filter((s) => !old.has(s.id))
		.map((s) =>
			JSON.stringify({
				lanes: s.lanes.map((l) => l.role),
				control: s.hasControlPoint ? [r(s.controlX!), r(s.controlY!)] : null,
				ends: [at(s.startNodeId), at(s.endNodeId)]
			})
		)
		.sort();
}

// A lane edit gives the armed brush a new cross-section, never its old one
// changed in place, so the brush is of the kind its lanes now make
// (`carries` is read once per cross-section): it snaps, cuts and lays as a
// brush of that kind, whichever way the edit turned it and however made.
test('a brush turned the other kind by a lane edit draws as that kind', () => {
	type Edit = (lanes: { role: string; direction?: string }[]) => void;
	const edits: [string, number, Edit, boolean][] = [
		['street, car lanes removed', 0, (l) => l.splice(1, 2), false],
		[
			'street, car lanes retyped',
			0,
			(l) => [1, 2].forEach((k) => (l[k].role = 'pedestrian')),
			false
		],
		['path, lane retyped', 3, (l) => (l[0].role = 'vehicle'), true],
		[
			'path, car lane added',
			3,
			(l) => l.splice(1, 0, { role: 'vehicle', direction: 'forward' }),
			true
		]
	];
	for (const [name, slot, edit, car] of edits)
		for (const live of [false, true])
			for (const [on, at] of [
				['street', { x: 0, y: 0 }],
				['path', { x: 0, y: 60 }]
			] as const) {
				const ui = openEditor(
					cityOf({ a: [-80, 0], b: [80, 0], c: [-80, 60], d: [80, 60] }, [
						{ id: 'street', from: 'a', to: 'b', lanes: 'street' },
						{ id: 'path', from: 'c', to: 'd', lanes: 'path' }
					])
				);
				ui.editor.activateSlot(slot);
				ui.editor.setDrawStyle('straight');
				ui.hover(at.x, at.y);
				ui.editor.editLanes((lanes) => {
					const fresh = lanes as {
						role: string;
						direction?: string;
						material?: string;
						width?: number;
					}[];
					edit(fresh);
					for (const lane of fresh)
						Object.assign(lane, { material: lane.material ?? 'asphalt', width: lane.width ?? 3.5 });
				}, live);
				const old = new Set(ui.editor.graph.segments.keys());
				ui.click(at.x, at.y);
				ui.click(at.x + 20, at.y + 25);
				const laid = [...ui.editor.graph.segments.values()].filter((s) => !old.has(s.id));
				const kinds = laid.map((s) => s.lanes.some((l) => l.role === 'vehicle'));
				// Cut only where the road clicked is of the brush's kind.
				const cut = !ui.editor.graph.segments.has(on);
				expect({ name, live, on, cut, kinds: [...new Set(kinds)] }).toEqual({
					name,
					live,
					on,
					cut: car === (on === 'street'),
					kinds: [car]
				});
			}
});

// The preview draws the road the click will lay, also where that road is
// drawn as one with the road it carries on from (a curve leaving a road's
// end along its line, a straight piece dead ahead: Derived.units).
test('the road about to be laid is drawn before the click, carried on from another or not', () => {
	for (const style of ['straight', 'curve'] as const)
		for (const [lanes, slot] of [
			['street', 0],
			['path', 3]
		] as const)
			for (const aim of [
				{ x: 40, y: 0 },
				{ x: 40, y: 20 },
				{ x: 30, y: -35 }
			]) {
				const ui = openEditor(
					cityOf({ a: [-60, 0], b: [0, 0] }, [{ id: 'road', from: 'a', to: 'b', lanes }])
				);
				ui.editor.activateSlot(slot);
				ui.editor.setDrawStyle(style);
				ui.click(0, 0);
				ui.hover(aim.x, aim.y);
				const ghost = ui.editor.ghost!;
				const pending = [...ghost.graph.segments.keys()].filter((id) => id !== 'road');
				expect({ style, lanes, aim, pending: pending.length }).toEqual({
					style,
					lanes,
					aim,
					pending: 1
				});
				expect({ style, lanes, aim, drawn: ghost.renderer.drawnSegments() }).toEqual({
					style,
					lanes,
					aim,
					drawn: expect.arrayContaining(pending)
				});
			}
});
