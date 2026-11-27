import { expect, test } from 'bun:test';
import { cityOf, openEditor } from './editor.svelte';

// A footpath's end joined to a street's sidewalk keeps to that sidewalk
// whatever draws it anew (Editor.followWalkways, followWalkway in
// modes/picking.ts), a cut of the street included: the pieces it is cut
// into keep its lanes, and the sidewalk is theirs.

test('a side street drawn onto a street keeps a footpath joined to the sidewalk it cut', () => {
	const ui = openEditor(
		cityOf({ a: [-100, 0], b: [100, 0], p: [1, 4.5], q: [1, 45] }, [
			{ id: 'street', from: 'a', to: 'b', lanes: 'street' },
			{ id: 'path', from: 'p', to: 'q', lanes: 'path' }
		])
	);
	const sidewalk = ui.editor.roadRenderer.derived!.sidewalks.get('p')![0];
	expect(sidewalk.road).toBe('street');
	ui.editor.activateSlot(0);
	ui.editor.setDrawStyle('straight');
	ui.click(0, 75);
	ui.click(0, 0);

	expect(ui.editor.graph.segments.has('street')).toBe(false);
	// The street's east half, from the cut to (100, 0), now runs past the
	// path's end into the junction's corner it shares with the side street.
	const east = [...ui.editor.graph.segments.values()].find((s) => s.endNodeId === 'b')!;
	const on = ui.editor.roadRenderer.derived!.sidewalks.get('p')?.[0];
	expect(on).toBeDefined();
	const lanes = on!.corner ? [on!.corner.a, on!.corner.b] : [{ road: on!.road, lane: on!.lane }];
	expect(lanes).toContainEqual(expect.objectContaining({ road: east.id, lane: sidewalk.lane }));
	// Saved there, in the draw's own step.
	const saved = ui.saved().nodes.find((n) => n.id === 'p')!;
	expect([saved.x, saved.y]).toEqual([ui.node('p').x, ui.node('p').y]);
	expect([saved.x, saved.y]).not.toEqual([1, 4.5]);
});

// The sidewalk an end joined is found again by where it lies, never by the
// ids of the roads it is drawn on: a side street drawn onto a street leaves
// each footpath end joined to its sidewalk where it leaves it on the same
// street uncut, whichever segment of the street is cut, whatever the
// street's shift, whichever way it is stored and on either sidewalk.
test('a side street drawn onto a street moves a joined end the same, however the street is cut, shifted or stored', () => {
	// A street from (-100, 0) to (100, 0), its shift (m right of its line,
	// heading east) at the west and east ends; a side street drawn from
	// (0, 75) onto it.
	const shifts: [number, number][] = [
		[0, 0],
		[1.5, 1.5],
		[-3.5, 3.5]
	];
	const shiftAt = ([w, e]: [number, number], x: number) => w + ((e - w) * (x + 100)) / 200;
	const city = (
		shift: [number, number],
		reversed: boolean,
		cutAt: number | null,
		end: { x: number; y: number }
	) => {
		const nodes: Record<string, [number, number]> = {
			a: [-100, 0],
			b: [100, 0],
			p: [end.x, end.y],
			q: [end.x + (end.x >= 0 ? 25 : -25), end.y * 10]
		};
		if (cutAt !== null) nodes.m = [cutAt, 0];
		const along =
			cutAt === null
				? [['a', 'b']]
				: [
						['a', 'm'],
						['m', 'b']
					];
		const roads = along.map(([from, to], k) => {
			const [x0, x1] = [nodes[from][0], nodes[to][0]];
			const [s0, s1] = [shiftAt(shift, x0), shiftAt(shift, x1)];
			// Stored west to east, or east to west with the shift's sign
			// turned with it.
			return reversed
				? { id: `s${k}`, from: to, to: from, offsetStart: -s1, offsetEnd: -s0 }
				: { id: `s${k}`, from, to, offsetStart: s0, offsetEnd: s1 };
		});
		const graph = cityOf(nodes, [
			...roads.map((r) => ({ id: r.id, from: r.from, to: r.to, lanes: 'street' as const })),
			{ id: 'path', from: 'p', to: 'q', lanes: 'path' }
		]);
		for (const [k, r] of roads.entries())
			Object.assign(graph.segments[k], { offsetStart: r.offsetStart, offsetEnd: r.offsetEnd });
		return graph;
	};
	const sideStreet = (graph: ReturnType<typeof city>) => {
		const ui = openEditor(graph);
		expect(ui.editor.roadRenderer.derived!.sidewalks.get('p')).toBeDefined();
		ui.editor.activateSlot(0);
		ui.editor.setDrawStyle('straight');
		ui.click(0, 75);
		ui.click(0, 0);
		expect(ui.editor.roadRenderer.derived!.sidewalks.get('p')).toBeDefined();
		return [ui.node('p').x, ui.node('p').y].map((v) => Math.round(v * 1000) / 1000);
	};
	for (const shift of shifts)
		for (const reversed of [false, true])
			for (const x of [-6, 3, 30])
				for (const side of [1, -1]) {
					const end = { x, y: side * 4.5 + shiftAt(shift, x) };
					const uncut = sideStreet(city(shift, reversed, null, end));
					expect(uncut[1] * side).toBeGreaterThan(0);
					for (const cutAt of [-20, 20])
						expect({
							shift,
							reversed,
							x,
							side,
							cutAt,
							at: sideStreet(city(shift, reversed, cutAt, end))
						}).toEqual({
							shift,
							reversed,
							x,
							side,
							cutAt,
							at: uncut
						});
				}
});
