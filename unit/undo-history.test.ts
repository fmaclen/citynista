import { expect, test } from 'bun:test';
import { cityOf, openEditor } from './editor.svelte';

// The editor keeps the last hundred undo steps. A draw's first click on a
// street cuts it, one step; Escape with nothing laid from it takes that cut
// back with no trace (Editor.discardLastEdit), the history as it was.

test('a draw cut taken back with a full history keeps every step it had', () => {
	const ui = openEditor(
		cityOf({ a: [-50, 0], b: [50, 0], c: [-50, 80], d: [50, 80] }, [
			{ id: 'street', from: 'a', to: 'b', lanes: 'street' },
			{ id: 'other', from: 'c', to: 'd', lanes: 'street' }
		])
	);
	// A hundred moves, each its own step.
	for (let k = 1; k <= 100; k++) {
		ui.node('c').x = -50 + k * 0.1;
		ui.editor.rebuildRoads();
		ui.editor.graph.save();
	}
	ui.editor.activateSlot(0);
	ui.click(0, 0);
	expect(ui.editor.graph.segments.has('street')).toBe(false);
	ui.key('Escape');
	expect(ui.editor.graph.segments.has('street')).toBe(true);

	let steps = 0;
	while (ui.editor.canUndo) {
		ui.editor.undo();
		steps++;
	}
	expect(steps).toBe(100);
	expect(ui.node('c').x).toBeCloseTo(-50, 9);
});

// Undo is offered exactly when it takes something back (Editor.canUndo, the
// toolbar's button): an edit the mode holds that is no step of the history
// yet (a draw's start on a street's side, which Undo takes back alone, or a
// move in hand that letting go would keep, which Undo settles into a step
// and takes back), or a step of the history; never when it would take back
// nothing (a move in hand refused is put back by the settling alone). A start is no edit until a
// road is laid from it, however often it is clicked, so taking every step
// back leaves the city as it was opened, and no step holds a node with no
// road.
test('Undo is offered exactly when it would take something back', () => {
	const PATH = 3;
	const draw = (ui: ReturnType<typeof openEditor>) => ui.editor.activateSlot(PATH);
	// A press moved from `from` by `by` and still held.
	const holding =
		(from: { x: number; y: number }, by: { x: number; y: number }, select = true) =>
		(ui: ReturnType<typeof openEditor>) => {
			if (select) ui.click(from.x, from.y);
			ui.fire('mousedown', from.x, from.y);
			for (let k = 1; k <= 4; k++)
				ui.fire('mousemove', from.x + (by.x * k) / 4, from.y + (by.y * k) / 4);
		};
	const gestures: [string, (ui: ReturnType<typeof openEditor>) => void][] = [
		['a start on a sidewalk', (ui) => (draw(ui), ui.click(0, 4.5))],
		['a start on open ground', (ui) => (draw(ui), ui.click(0, 30, { ctrl: true }))],
		['a start cutting a path', (ui) => (draw(ui), ui.click(0, 60))],
		['a path laid from a sidewalk', (ui) => (draw(ui), ui.click(0, 4.5), ui.click(10, 30))],
		['a sidewalk start let go', (ui) => (draw(ui), ui.click(0, 4.5), ui.key('Escape'))],
		[
			'a sidewalk start, then the brush switched',
			(ui) => (draw(ui), ui.click(0, 4.5), ui.editor.activateSlot(0))
		],
		['a sidewalk start clicked again', (ui) => (draw(ui), ui.click(0, 4.5), ui.click(0, 4.5))],
		[
			'an open-ground start clicked again',
			(ui) => (draw(ui), ui.click(0, 30, { ctrl: true }), ui.click(0, 30, { ctrl: true }))
		],
		['a path start on a path clicked again', (ui) => (draw(ui), ui.click(0, 60), ui.click(0, 60))],
		['a street end held moved', holding({ x: 80, y: 0 }, { x: 0, y: 10 })],
		['a path held moved', holding({ x: 40, y: 60 }, { x: 0, y: 10 })],
		['a path end held across a street', holding({ x: 80, y: 60 }, { x: 0, y: -70 })],
		['a path end held across a path, refused', holding({ x: 80, y: 60 }, { x: 0, y: 40 })],
		['a marquee held', holding({ x: 40, y: 30 }, { x: 10, y: 10 }, false)]
	];
	for (const [name, gesture] of gestures)
		for (const before of [false, true]) {
			const ui = openEditor(
				cityOf({ a: [-80, 0], b: [80, 0], c: [-80, 60], d: [80, 60], e: [-80, 90], f: [100, 90] }, [
					{ id: 'street', from: 'a', to: 'b', lanes: 'street' },
					{ id: 'path', from: 'c', to: 'd', lanes: 'path' },
					{ id: 'other', from: 'e', to: 'f', lanes: 'path' }
				])
			);
			// A step already in the history, or none.
			if (before) ui.drag({ x: -80, y: 60 }, { x: -80, y: 70 });
			ui.editor.mode = 'select';
			const opened = JSON.stringify(ui.saved());
			gesture(ui);
			// The nodes with no road in the newest step.
			const bare = () => {
				const now = ui.saved();
				return now.nodes.filter(
					(n) => !now.segments.some((s) => s.startNodeId === n.id || s.endNodeId === n.id)
				).length;
			};
			for (let step = 0; ; step++) {
				const offered = ui.editor.canUndo;
				const held = bare();
				// Whatever Undo first settles (a press in hand) is no step it
				// takes back.
				ui.editor.settlePress();
				const was = JSON.stringify(ui.editor.graph.toJSON());
				ui.editor.undo();
				ui.editor.mode = 'select';
				const changed = JSON.stringify(ui.editor.graph.toJSON()) !== was;
				expect({ name, before, step, offered, bare: held + bare() }).toEqual({
					name,
					before,
					step,
					offered: changed,
					bare: 0
				});
				if (!offered) break;
			}
			if (!before) expect(JSON.stringify(ui.saved())).toBe(opened);
		}
});
