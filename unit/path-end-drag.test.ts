import { expect, test } from 'bun:test';
import type { Segment } from '../src/lib/core/segment.svelte';
import { cityOf, openEditor } from './editor.svelte';

// Editing costs what changed, not the size of the map (AGENTS.md): a
// footpath's end dragged across open ground reads only the roads near it,
// through the build's grids, to find where it would land (modes/select.ts,
// draw mode's snapping). Each frame's build still compares every road with
// what it drew it from; the drag walks the graph's roads no further.

test('a free footpath end dragged on open ground walks the roads no more than its builds do', () => {
	// A path from (0, -30) to (0, 0), and fifty streets a kilometre away.
	const nodes: Record<string, [number, number]> = { p: [0, 0], q: [0, -30] };
	const roads: Parameters<typeof cityOf>[1] = [{ id: 'path', from: 'q', to: 'p', lanes: 'path' }];
	for (let k = 0; k < 50; k++) {
		nodes[`a${k}`] = [1000 + k * 30, 0];
		nodes[`b${k}`] = [1000 + k * 30, 100];
		roads.push({ id: `street${k}`, from: `a${k}`, to: `b${k}`, lanes: 'street' });
	}
	const ui = openEditor(cityOf(nodes, roads));
	ui.click(0, 0);

	// Every segment the graph hands out, counted.
	let read = 0;
	const segments = ui.editor.graph.segments as Map<string, Segment>;
	const counted = <T>(items: Iterable<T>) =>
		(function* () {
			for (const item of items) {
				read++;
				yield item;
			}
		})();
	const [values, entries] = [segments.values.bind(segments), segments.entries.bind(segments)];
	Object.assign(segments, {
		values: () => counted(values()),
		entries: () => counted(entries()),
		[Symbol.iterator]: () => counted(entries())
	});

	ui.fire('mousedown', 0, 0);
	read = 0;
	for (let k = 1; k <= 5; k++) ui.fire('mousemove', 3 * k, 2 * k);
	const dragging = read;
	ui.fire('mouseup', 15, 10);
	expect([ui.node('p').x, ui.node('p').y]).toEqual([15, 10]);

	// The same five builds, the path's far end nudged each time.
	read = 0;
	for (let k = 1; k <= 5; k++) {
		ui.node('q').x += 0.1;
		ui.editor.rebuildRoads();
	}
	expect(dragging).toBe(read);
});
