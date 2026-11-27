import { expect, test } from 'bun:test';
import { cityOf, openEditor } from './editor.svelte';

// A footpath node on the ground of a car road dragged rides it
// (core/drag.ts ridersOf): the nearest road of the ground it lies on, and of
// roads as near, the first the moved nodes list.

test('a footpath end on two streets lying on one line rides the first its node lists', () => {
	// Both streets leave (0, 0) along the x axis; the shorter is listed
	// first. The path's end at (60, 0) lies on both.
	const ui = openEditor(
		cityOf({ o: [0, 0], a: [100, 0], b: [160, 0], p: [60, 0], q: [60, -40] }, [
			{ id: 'short', from: 'o', to: 'a', lanes: 'street' },
			{ id: 'long', from: 'o', to: 'b', lanes: 'street' },
			{ id: 'path', from: 'p', to: 'q', lanes: 'path' }
		])
	);
	// The longer street dragged 10 m sideways by its own stretch: (0, 0)
	// moves with it, so the shorter now runs from (0, 10) to (100, 0).
	ui.click(130, 0);
	expect([...ui.editor.selectedSegments]).toEqual(['long']);
	ui.drag({ x: 130, y: 0 }, { x: 130, y: 10 });

	expect(ui.node('o').y).toBeCloseTo(10, 9);
	expect(ui.node('p').x).toBeCloseTo(60, 6);
	expect(ui.node('p').y).toBeCloseTo(4, 6);
});
