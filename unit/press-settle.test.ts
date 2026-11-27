import { expect, test } from 'bun:test';
import { openEditor } from './editor.svelte';
import { readScene } from './model';

// A crossing slid in the connector and still held is a press in hand, ended
// by whatever settles one (Editor.settlePress): Undo keeps the slide as a
// step and takes it back, a tool switched keeps it, and a move with the
// button up (let go outside the window) is the release that never came.
// None leaves the crossing following the pointer afterwards.

type Ui = ReturnType<typeof openEditor>;
// Each way out, and whether the button is still held after it.
const exits: [string, (ui: Ui) => void, boolean][] = [
	['Undo', (ui) => ui.key('z', { ctrl: true }), true],
	['a tool switched', (ui) => ui.editor.activateSlot(0), true],
	['a move with no button held', (ui) => ui.hover(90, -30), false]
];

for (const [name, exit, held] of exits)
	test(`${name} mid-slide in the connector ends the slide as one undo step`, () => {
		// The handles scene: the crossing on `je` handled at (80.5, -30).
		const ui = openEditor(readScene('handles'), 0.17);
		const east = () => ui.node('j').junction?.crossings?.find((c) => c.road === 'je')?.at ?? null;
		ui.fire('dblclick', 70, -30);
		expect(ui.editor.connectorNodeId).toBe('j');
		ui.fire('mousedown', 80.5, -30);
		for (const x of [82, 84, 86.5]) ui.fire('mousemove', x, -30);
		expect(east()).toBeCloseTo(16.5, 1);

		exit(ui);
		// The pointer moved on and let go: the slide is over.
		ui.fire('mousemove', 93, -30, { buttons: held ? 1 : 0 });
		ui.fire('mouseup', 93, -30);
		if (name === 'Undo') {
			expect(east()).toBeNull();
			expect([ui.editor.canUndo, ui.editor.canRedo]).toEqual([false, true]);
			ui.editor.redo();
		}
		expect(east()).toBeCloseTo(16.5, 1);
		ui.editor.undo();
		expect(east()).toBeNull();
		expect(ui.editor.canUndo).toBe(false);
	});
