import { expect, test } from 'bun:test';
import { cityOf, openEditor } from './editor.svelte';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { endAt } from '../src/lib/core/attach';

// A dead end dragged alone and let go over its drop marker joins there
// (modes/select.ts) with all the join carries: the footpath nodes riding its
// road go where they lie on the road as joined, and the footpath ends on a
// walkway the join draws anew keep to it (Editor.followWalkways). What that
// lays is checked as any move is, and a new crossing of one kind takes the
// whole move back.

test('a footpath riding a street ends where it lies on the street as joined', () => {
	// The first street's dead end at (100, 0) held at (100, 11), inside the
	// ring of the second street's dead end at (100, 20), so it joins there.
	const ui = openEditor(
		cityOf({ a: [0, 0], b: [100, 0], c: [100, 20], d: [180, 20], p: [50, 0], q: [50, -40] }, [
			{ id: 'first', from: 'a', to: 'b', lanes: 'street' },
			{ id: 'second', from: 'c', to: 'd', lanes: 'street' },
			{ id: 'path', from: 'p', to: 'q', lanes: 'path' }
		]),
		0.5
	);
	ui.click(100, 0);
	ui.drag({ x: 100, y: 0 }, { x: 100, y: 11 });

	const first = ui.editor.graph.segments.get('first')!;
	expect(first.endNodeId).toBe('c');
	expect(ui.editor.graph.nodes.has('b')).toBe(false);
	// Halfway along the street from (0, 0) to (100, 20).
	expect(ui.node('p').x).toBeCloseTo(50, 6);
	expect(ui.node('p').y).toBeCloseTo(10, 6);
	expect(ui.saved().nodes.find((n) => n.id === 'p')).toMatchObject({ y: ui.node('p').y });
});

test('a drop whose join moves a footpath end across another footpath is taken back', () => {
	// A T of streets at (0, 0) and a path from its east arm's sidewalk; a
	// street's dead end dropped on the T grows the junction, and the path's
	// end, kept on its walkway, swings its path across the short one.
	const city = cityOf(
		{
			o: [0, 0],
			w: [-90, 0],
			e: [90, 0],
			n: [0, -80],
			s1: [90, 50],
			s2: [30, 17],
			p1: [7.25, -4.7],
			p2: [47, -40],
			q1: [33, -22],
			q2: [36, -22]
		},
		[
			{ id: 'W', from: 'o', to: 'w', lanes: 'street' },
			{ id: 'E', from: 'o', to: 'e', lanes: 'street' },
			{ id: 'N', from: 'o', to: 'n', lanes: 'street' },
			{ id: 'S', from: 's1', to: 's2', lanes: 'street' },
			{ id: 'long', from: 'p1', to: 'p2', lanes: 'path' },
			{ id: 'short', from: 'q1', to: 'q2', lanes: 'path' }
		]
	);
	const ui = openEditor(city);
	const opened = ui.saved();
	expect(ui.editor.roadRenderer.derived!.sidewalks.get('p1')).toBeDefined();
	ui.click(30, 17);
	ui.fire('mousedown', 30, 17);
	for (let k = 1; k <= 8; k++) ui.fire('mousemove', 30 - (30 * k) / 8, 17 - (17 * k) / 8);
	expect(ui.editor.dropShown).not.toBeNull();
	ui.fire('mouseup', 0, 0);

	expect(ui.editor.canUndo).toBe(false);
	expect(ui.saved()).toEqual(opened);
	for (const n of city.nodes) expect([ui.node(n.id).x, ui.node(n.id).y]).toEqual([n.x, n.y]);
	expect(ui.editor.graph.segments.get('S')!.endNodeId).toBe('s2');
	expect([...ui.editor.selectedNodes]).toEqual(['s2']);
});

// A drop is judged once, at release, on the graph the join makes, against the
// roads as the press found them, and the end held over the marker already
// lies where the drop puts it (riders and curve handle carried there), so
// where in the snap ring the pointer stops changes nothing: not what the
// marker shows refused, not whether it joins, not what is saved.

// Holds the dead end at `end` over `to`, reads what the hold shows, and lets
// go there.
function dropHeld(
	ui: ReturnType<typeof openEditor>,
	end: { x: number; y: number },
	to: { x: number; y: number }
) {
	ui.click(end.x, end.y);
	ui.fire('mousedown', end.x, end.y);
	for (let k = 1; k <= 8; k++)
		ui.fire('mousemove', end.x + ((to.x - end.x) * k) / 8, end.y + ((to.y - end.y) * k) / 8);
	const shown = { drop: ui.editor.dropShown, refused: [...ui.editor.refused] };
	ui.fire('mouseup', to.x, to.y);
	return shown;
}

test('where in the snap ring a dead end is let go changes nothing the drop does', () => {
	// The first street's dead end at (100, 0) dropped on the second's at
	// (100, 20), a path riding the first street halfway along. Held short of
	// the target the path would cross the short one; joined it does not.
	const curves = [undefined, { x: 50, y: 40 }, { x: 50, y: -40 }];
	const ring = [
		{ x: 0, y: 0 },
		...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((k) =>
			[4, 9].map((r) => ({
				x: r * Math.cos((k * Math.PI) / 4),
				y: r * Math.sin((k * Math.PI) / 4)
			}))
		)
	];
	for (const control of curves)
		for (const reversed of [false, true]) {
			const results = new Set<string>();
			for (const off of ring) {
				const ui = openEditor(
					cityOf(
						{
							a: [0, 0],
							b: [100, 0],
							c: [100, 20],
							d: [180, 20],
							p: [50, control ? control.y / 2 : 0],
							q: [0, -50],
							s1: [29.7, -16.7],
							s2: [30.3, -16.7]
						},
						[
							reversed
								? { id: 'first', from: 'b', to: 'a', lanes: 'street', control }
								: { id: 'first', from: 'a', to: 'b', lanes: 'street', control },
							{ id: 'second', from: 'c', to: 'd', lanes: 'street' },
							{ id: 'path', from: 'p', to: 'q', lanes: 'path' },
							{ id: 'short', from: 's1', to: 's2', lanes: 'path' }
						]
					),
					0.5
				);
				const shown = dropHeld(ui, { x: 100, y: 0 }, { x: 100 + off.x, y: 20 + off.y });
				expect(shown.drop).toEqual({ x: 100, y: 20 });
				const first = ui.editor.graph.segments.get('first')!;
				const joinedAt = reversed ? first.startNodeId : first.endNodeId;
				// The preview and the release agree, and here both let it join.
				expect(shown.refused).toEqual([]);
				expect(joinedAt).toBe('c');
				results.add(JSON.stringify(ui.saved()));
			}
			expect(results.size).toBe(1);
		}
}, 30_000);

test('a drop cutting a road keeps the crossings that road already made, wherever along it', () => {
	// A street's dead end at (x, 25) dropped onto a host street along y = 0,
	// which another street crosses unjoined at x = 150 or x = 20; the host
	// stored either way, the drop anywhere along it.
	for (const reversed of [false, true])
		for (const across of [150, 20])
			for (const x of [40, 60, 100, 130, 170, 185]) {
				if (Math.abs(x - across) < 15) continue;
				const ui = openEditor(
					cityOf(
						{
							a: [0, 0],
							b: [200, 0],
							x1: [across, -40],
							x2: [across, 40],
							s: [x, 60],
							e: [x, 25]
						},
						[
							reversed
								? { id: 'T', from: 'b', to: 'a', lanes: 'street' }
								: { id: 'T', from: 'a', to: 'b', lanes: 'street' },
							{ id: 'X', from: 'x1', to: 'x2', lanes: 'street' },
							{ id: 'S', from: 's', to: 'e', lanes: 'street' }
						]
					),
					0.5
				);
				const shown = dropHeld(ui, { x, y: 25 }, { x, y: 0.5 });
				expect(shown.drop!.x).toBeCloseTo(x, 6);
				expect(shown.drop!.y).toBeCloseTo(0, 6);
				expect(shown.refused).toEqual([]);
				expect(ui.editor.graph.segments.has('T')).toBe(false);
				const end = ui.node(ui.editor.graph.segments.get('S')!.endNodeId);
				expect([end.x, end.y].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([x, 0]);
				expect(ui.editor.canUndo).toBe(true);
			}
});

// Dropped at a road's edge, the end held over the marker is already drawn
// where the join draws it, moved to the edge with its curve's handle, and
// the drop's verdict (head-on for one-way traffic included) is read off that
// same state, so across the ring every point aimed at one edge joins or
// refuses alike, saves one city, and holds the end where it is let go. Which
// edge a point aims at is the marker any of the three cross-sections shows
// there: the snap does not read the dropped road's lanes.
test('a dead end held over an edge lies as joined there, and joins or not alike across the ring', () => {
	const forward = createLanesFrom('lane');
	const backward = forward.map((l) => ({ ...l, direction: 'backward' as const }));
	const sections = [forward, backward, createLanesFrom('street')];
	for (const reversed of [false, true])
		for (const side of [1, -1])
			for (const bow of [-14, -1.6, 0, 1.6, 14])
				for (const from of ['far', 'end'] as const) {
					const g = cityOf({ a: [-100, 0], b: [100, 0], f: [-15, 45 * side], e: [0, 20 * side] }, [
						reversed
							? { id: 'host', from: 'b', to: 'a', lanes: 'street' }
							: { id: 'host', from: 'a', to: 'b', lanes: 'street' },
						from === 'far'
							? {
									id: 'own',
									from: 'f',
									to: 'e',
									lanes: 'street',
									control: { x: bow, y: 28 * side }
								}
							: {
									id: 'own',
									from: 'e',
									to: 'f',
									lanes: 'street',
									control: { x: bow, y: 28 * side }
								}
					]);
					const results = sections.map(() => new Map<string, Set<string>>());
					for (let y = 0.5; y <= 8.5; y += 1) {
						const outcomes = sections.map((lanes) => {
							g.segments[1].lanes = lanes;
							const ui = openEditor(g, 0.1);
							ui.click(0, 20 * side);
							ui.fire('mousedown', 0, 20 * side);
							for (let k = 1; k <= 8; k++)
								ui.fire('mousemove', 0, 20 * side + ((y - 20) * side * k) / 8);
							const shown = ui.editor.dropShown;
							const own = ui.editor.graph.segments.get('own')!;
							const endId = from === 'far' ? own.endNodeId : own.startNodeId;
							const held = {
								end: endAt(ui.editor.graph, own, endId)!,
								cx: own.controlX,
								cy: own.controlY
							};
							ui.fire('mouseup', 0, y * side);
							const joined = !ui.editor.graph.segments.has('host');
							expect(joined).toBe(shown !== null);
							if (joined) {
								const after = ui.editor.graph.segments.get('own')!;
								const at = from === 'far' ? after.endNodeId : after.startNodeId;
								const end = endAt(ui.editor.graph, after, at)!;
								expect(end.x).toBeCloseTo(held.end.x, 6);
								expect(end.y).toBeCloseTo(held.end.y, 6);
								expect(after.controlX).toBeCloseTo(held.cx!, 6);
								expect(after.controlY).toBeCloseTo(held.cy!, 6);
							}
							return { shown, saved: joined ? JSON.stringify(ui.saved()) : 'kept' };
						});
						const aimed = outcomes.find((o) => o.shown)?.shown;
						if (!aimed) continue;
						outcomes.forEach((o, k) => {
							const key = JSON.stringify(aimed);
							if (!results[k].has(key)) results[k].set(key, new Set());
							results[k].get(key)!.add(o.saved);
						});
					}
					results.forEach((byMarker, k) => {
						for (const [marker, saved] of byMarker)
							expect({ k, reversed, side, bow, from, marker, n: saved.size }).toEqual({
								k,
								reversed,
								side,
								bow,
								from,
								marker,
								n: 1
							});
					});
				}
}, 30_000);
