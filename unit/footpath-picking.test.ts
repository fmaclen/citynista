import { expect, test } from 'bun:test';
import { cityOf, openEditor } from './editor.svelte';
import { createSnapping } from '../src/lib/modes/draw';
import { createLanesFrom } from '../src/lib/core/lane-template';

// A footpath is picked where it shows and nowhere else (segmentHitAt in
// modes/picking.ts): on its own paving, a street's sidewalk or verge it runs
// over included, but never on a car road's lanes or median, where nothing of
// it is drawn, unless on a crossing it is part of (its zebra or refuge). A
// click on bare asphalt picks the street there, whatever footpath runs under,
// and draw mode's Path brush snaps there to the street's side, never to the
// footpath (footpathScore).

// A street of `preset` along y = `shift` (stored either way), its car lanes
// and median `half` metres either side of its middle; a footpath from 25 m
// south at `angle` to the street, ended `depth` metres past the street's
// middle (`across`: on through to 25 m north).
test('a click on car lanes picks a footpath only on its crossing', () => {
	const streets = [
		{ preset: 'street' as const, half: 3.5 },
		{ preset: 'avenue' as const, half: 8 }
	];
	for (const { preset, half } of streets)
		for (const [shift, reversed] of [
			[0, false],
			[2, true]
		] as const)
			for (const angle of [90, 35])
				for (const depth of [-half - 1, -2, 0, 2, 'across' as const])
					for (const perPixel of [0.02, 0.2]) {
						const dir = {
							x: Math.cos((angle * Math.PI) / 180),
							y: Math.sin((angle * Math.PI) / 180)
						};
						const at = (y: number) => ({ x: 7 + ((y - shift) * dir.x) / dir.y, y });
						const endY = depth === 'across' ? shift + 25 : shift + depth;
						const [p, q] = [at(shift - 25), at(endY)];
						const city = cityOf({ a: [-100, 0], b: [100, 0], p: [p.x, p.y], q: [q.x, q.y] }, [
							reversed
								? { id: 'street', from: 'b', to: 'a', lanes: preset }
								: { id: 'street', from: 'a', to: 'b', lanes: preset },
							{ id: 'path', from: 'p', to: 'q', lanes: 'path' }
						]);
						const s = reversed ? -shift : shift;
						Object.assign(city.segments[0], { offsetStart: s, offsetEnd: s });
						const ui = openEditor(city, perPixel);
						const ring = ui.editor.nodeRingRadius() + 0.5;
						// Clicked along the footpath's line every half metre, off the
						// street's middle (where both lines pass, either may win),
						// the curb and the end's ring.
						for (let y = shift - 19.75; y <= Math.min(endY, shift + 20); y += 0.5) {
							const pt = at(y);
							const off = Math.abs(y - shift);
							if (Math.abs(off - half) < 0.3) continue;
							if (Math.hypot(pt.x - q.x, pt.y - q.y) < ring) continue;
							ui.editor.clearSelection();
							ui.click(pt.x, pt.y);
							const onCars = off < half;
							const want = onCars && depth !== 'across' ? 'street' : 'path';
							expect({
								preset,
								shift,
								reversed,
								angle,
								depth,
								perPixel,
								y,
								picked: [...ui.editor.selectedSegments],
								// Draw mode's snap with the Path brush reads the same.
								snapped: snappedTo(ui, pt)
							}).toEqual({
								preset,
								shift,
								reversed,
								angle,
								depth,
								perPixel,
								y,
								picked: [want],
								snapped: want
							});
						}
					}
});

// What draw mode's snap with the Path brush finds at a point: the footpath
// (a cut on it or a node of it), a street's side, or anything else.
function snappedTo(ui: ReturnType<typeof openEditor>, p: { x: number; y: number }) {
	const lanes = createLanesFrom('path');
	const snap = createSnapping(
		ui.editor,
		() => lanes,
		() => null,
		() => false
	);
	const t = snap.resolveSnap(p.x, p.y);
	if (t.kind === 'segment') return t.snap.segment.id;
	if (t.kind === 'node')
		return ui.editor.graph.nodes.get(t.nodeId)!.connectedSegments.includes('path')
			? 'path'
			: t.kind;
	return t.kind === 'side' ? 'street' : t.kind;
}

// A footpath's crossing is carried straight from curb to curb (bandOf), so
// on a curved or slanting footpath its zebra reaches past the footpath's
// strip: wherever the zebra is drawn, a click picks the footpath and draw
// mode's Path brush snaps to it; elsewhere on the lanes, the street and its
// side.
test('a footpath is picked and snapped to all over its zebra, and nowhere else on the lanes', () => {
	const wide = createLanesFrom('street').map((l) =>
		l.role === 'vehicle' ? { ...l, width: 30 } : l
	);
	for (const bow of [70, 30, -45])
		for (const reversed of [false, true])
			for (const lean of [0, 12]) {
				const city = cityOf({ a: [-150, 0], b: [150, 0], p: [-lean, -35], q: [lean, 35] }, [
					reversed
						? { id: 'street', from: 'b', to: 'a', lanes: 'street' }
						: { id: 'street', from: 'a', to: 'b', lanes: 'street' },
					{ id: 'path', from: 'p', to: 'q', lanes: 'path', control: { x: bow, y: 0 } }
				]);
				city.segments[0].lanes = wide;
				const ui = openEditor(city, 0.1);
				let onZebra = 0;
				for (let x = -40; x <= 60; x += 1.5)
					for (let y = -28.5; y <= 28.5; y += 1.5) {
						const p = { x, y };
						const zebra = ui.editor.roadRenderer.crossingAt(p) !== null;
						if (zebra) onZebra++;
						ui.editor.clearSelection();
						ui.editor.mode = 'select';
						ui.click(x, y);
						const picked = [...ui.editor.selectedSegments];
						const want = zebra ? 'path' : 'street';
						expect({ bow, reversed, lean, x, y, picked, snapped: snappedTo(ui, p) }).toEqual({
							bow,
							reversed,
							lean,
							x,
							y,
							picked: [want],
							snapped: want
						});
					}
				expect(onZebra).toBeGreaterThan(20);
			}
}, 30_000);
