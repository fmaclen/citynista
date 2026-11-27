import { expect, test } from 'bun:test';
import { cityOf, openEditor } from './editor.svelte';

// The circle tool joins a ring to the roads of its kind it crosses, as roads
// cross each other (resolveCrossings): where a road passes through the
// circle, from one side to the other. A road that only comes up to it and
// goes back, within a centimetre, touches it and is left as it was; one
// ending on it joins it there.

const PATH = 3;
const STREET = 0;

// A ring of `slot`'s preset centred at (0, 0) through (r, 0), laid beside a
// road of `lanes` at `d` from the centre, at `angle` to the x axis, stored
// either way, straight or bowed; returns whether the road was cut.
function ringBeside(
	slot: number,
	lanes: 'path' | 'street',
	d: number,
	angle: number,
	reversed: boolean,
	bow: number
) {
	const r = 25;
	const [ux, uy] = [Math.cos(angle), Math.sin(angle)];
	// The road's nearest point to the centre at distance d, its handle
	// bowing it away from the centre by `bow`.
	const near = { x: -uy * d, y: ux * d };
	const a: [number, number] = [near.x - ux * 60, near.y - uy * 60];
	const b: [number, number] = [near.x + ux * 60, near.y + uy * 60];
	const control = { x: near.x - uy * bow * 2, y: near.y + ux * bow * 2 };
	const ui = openEditor(
		cityOf({ a: reversed ? b : a, b: reversed ? a : b }, [
			{ id: 'road', from: 'a', to: 'b', lanes, control: bow ? control : undefined }
		]),
		0.1
	);
	ui.editor.setDrawStyle('circle');
	ui.editor.activateSlot(slot);
	ui.click(0, 0, { ctrl: true });
	ui.click(r, 0, { ctrl: true });
	return !ui.editor.graph.segments.has('road');
}

// How far a road's nearest point lies outside the circle, and whether the
// ring cuts it: exactly on it, a few millimetres either side, and further.
const NEAREST = [
	[0, false],
	[0.005, false],
	[-0.005, false],
	[0.5, false],
	[-0.5, true],
	[-5, true]
] as const;

test('a ring cuts a road of its kind it passes through, and none it only touches', () => {
	for (const [slot, lanes] of [
		[PATH, 'path'],
		[STREET, 'street']
	] as const)
		for (const angle of [0, 0.4, Math.PI / 2, 2.2])
			for (const reversed of [false, true])
				for (const bow of [0, 5])
					for (const [off, cuts] of NEAREST) {
						const d = 25 + off - (bow ? bow : 0);
						expect({
							lanes,
							angle,
							reversed,
							bow,
							off,
							cut: ringBeside(slot, lanes, d, angle, reversed, bow)
						}).toEqual({
							lanes,
							angle,
							reversed,
							bow,
							off,
							cut: cuts
						});
					}
}, 30_000);

test('a road of its kind ending on the circle joins the ring at its end', () => {
	for (const [slot, lanes] of [
		[PATH, 'path'],
		[STREET, 'street']
	] as const)
		for (const angle of [0.3, 1.9, 4])
			for (const outward of [false, true])
				for (const reversed of [false, true]) {
					const on: [number, number] = [25 * Math.cos(angle), 25 * Math.sin(angle)];
					const k = outward ? 50 : 15;
					const far: [number, number] = [k * Math.cos(angle + 0.2), k * Math.sin(angle + 0.2)];
					const ui = openEditor(
						cityOf({ e: on, f: far }, [
							reversed
								? { id: 'road', from: 'e', to: 'f', lanes }
								: { id: 'road', from: 'f', to: 'e', lanes }
						]),
						0.1
					);
					ui.editor.setDrawStyle('circle');
					ui.editor.activateSlot(slot);
					ui.click(0, 0, { ctrl: true });
					ui.click(0, 25, { ctrl: true });
					expect({
						lanes,
						angle,
						outward,
						reversed,
						at: ui.node('e').connectedSegments.length
					}).toEqual({
						lanes,
						angle,
						outward,
						reversed,
						at: 3
					});
				}
});
