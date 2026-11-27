import { expect, test } from 'bun:test';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { closestOnRoad } from '../src/lib/core/road-line';
import type { GraphData } from '../src/lib/core/types';
import { openEditor } from './editor.svelte';

// The footpath nodes a press carries are those on the ground of the car
// roads it moves as the press began: the riders (ridersOf in core/drag.ts)
// and the ends joined to a walkway it draws anew (Editor.followWalkways). A
// footpath end the road reaches during the press is passed over: it stays
// where it lay, on every frame, on release and through undo and redo,
// whether the road is let go clear of it or lying over it. The presets
// without sidewalks reach no loose end, so the sweeps leave them out.

type Pt = { x: number; y: number };
type Ui = ReturnType<typeof openEditor>;

const PRESETS = ['street', 'avenue'];

// A street of a block running from (-60, 0) to its corner at the origin, a
// spur leaving that corner up to (0, 40) in `preset`, stored from the corner
// or toward it, straight or curved, and a footpath ending loose on the
// ground at (14, 24) beside the spur (`side` 1; -1 mirrors the scene), its
// far node beyond the spur's reach, its end shifted by `shift`. With
// `rider`, a second footpath ends on the spur's own ground at its middle.
function scene(o: {
	preset: string;
	reversed: boolean;
	curved: boolean;
	shift: number;
	side: 1 | -1;
	rider?: boolean;
}) {
	const s = o.side;
	const spur = o.reversed
		? { startNodeId: 'b', endNodeId: 'a' }
		: { startNodeId: 'a', endNodeId: 'b' };
	return {
		nodes: [
			{ id: 'c', x: -60 * s, y: 0 },
			{ id: 'a', x: 0, y: 0 },
			{ id: 'b', x: 0, y: 40 },
			{ id: 'p', x: 50 * s, y: 70 },
			{ id: 'q', x: 14 * s, y: 24 },
			...(o.rider
				? [
						{ id: 'r', x: -1.5 * s, y: 20 },
						{ id: 'r2', x: -40 * s, y: 30 }
					]
				: [])
		],
		segments: [
			{ id: 'block', startNodeId: 'c', endNodeId: 'a', lanes: createLanesFrom('street') },
			{
				id: 'spur',
				...spur,
				lanes: createLanesFrom(o.preset),
				...(o.curved ? { controlX: -6 * s, controlY: 20 } : {})
			},
			{
				id: 'path',
				startNodeId: 'p',
				endNodeId: 'q',
				lanes: createLanesFrom('path'),
				...(o.shift ? { offsetEnd: o.shift } : {})
			},
			...(o.rider
				? [{ id: 'walk', startNodeId: 'r2', endNodeId: 'r', lanes: createLanesFrom('path') }]
				: [])
		]
	} as GraphData;
}

const at = (ui: Ui, id: string): Pt => ({ x: ui.node(id).x, y: ui.node(id).y });
// Whether a footpath node lies on the spur's ground as last drawn: its
// roadway, its sidewalks or the junctions at its ends (Networks.onGround).
const onSpur = (ui: Ui, id: string) =>
	ui.editor.roadRenderer.onGround(['spur'], ['a', 'b']).has(id);

// Presses at `from` and moves through `path` (one pointer update each),
// checking `each` after every update, and lets go at the last point. Whether
// the loose end lay on the spur's ground at any update: the sweep reached it.
function press(ui: Ui, from: Pt, path: Pt[], each: () => void) {
	let reached = false;
	ui.fire('mousedown', from.x, from.y);
	for (const q of path) {
		ui.fire('mousemove', q.x, q.y);
		reached ||= onSpur(ui, 'q');
		each();
	}
	const last = path.at(-1)!;
	ui.fire('mouseup', last.x, last.y);
	return reached;
}

// The press kept as one undo step: undone, the graph is as before; redone,
// as after; the loose end where it lay in each, the editor drawing what a
// fresh build draws.
function throughHistory(ui: Ui, before: string, q: Pt) {
	const after = JSON.stringify(ui.graph());
	expect(after).not.toBe(before);
	expect(ui.stale()).toEqual([]);
	ui.editor.undo();
	expect(JSON.stringify(ui.graph())).toBe(before);
	expect(ui.stale()).toEqual([]);
	ui.editor.redo();
	expect(JSON.stringify(ui.graph())).toBe(after);
	expect(at(ui, 'q')).toEqual(q);
	expect(ui.stale()).toEqual([]);
}

// The spur's free end swung from (0, 40) about the corner through `turn` of a
// right angle toward the loose end, in `steps` updates.
const swing = (side: number, turn: number, steps: number) =>
	Array.from({ length: steps }, (_, k) => {
		const angle = (Math.PI / 2) * (1 - (turn * (k + 1)) / steps);
		return { x: 40 * Math.cos(angle) * side, y: 40 * Math.sin(angle) };
	});

for (const preset of PRESETS)
	for (const reversed of [false, true])
		for (const curved of [false, true])
			for (const shift of [0, 1.5])
				for (const side of [1, -1] as const) {
					const o = { preset, reversed, curved, shift, side };
					const name = `${preset}, stored ${reversed ? 'toward' : 'from'} the corner, ${curved ? 'curved' : 'straight'}, end shifted ${shift} m, ${side > 0 ? 'right' : 'left'}`;

					test(`a spur's end swung across a loose footpath end and past it leaves the footpath end where it lay: ${name}`, () => {
						const ui = openEditor(scene(o));
						const q = at(ui, 'q');
						const before = JSON.stringify(ui.graph());
						ui.click(0, 40);
						const reached = press(ui, { x: 0, y: 40 }, swing(side, 1, 24), () =>
							expect(at(ui, 'q')).toEqual(q)
						);
						expect(reached).toBe(true);
						expect(at(ui, 'q')).toEqual(q);
						throughHistory(ui, before, q);
					});
				}

for (const preset of PRESETS)
	for (const shift of [0, 1.5])
		for (const side of [1, -1] as const) {
			const o = { preset, reversed: false, curved: false, shift, side };
			const name = `${preset}, end shifted ${shift} m, ${side > 0 ? 'right' : 'left'}`;

			test(`a spur dragged by its body across a loose footpath end and past it leaves the footpath end where it lay: ${name}`, () => {
				const ui = openEditor(scene(o));
				const q = at(ui, 'q');
				const before = JSON.stringify(ui.graph());
				ui.click(0, 32);
				expect([...ui.editor.selectedSegments]).toEqual(['spur']);
				const path = Array.from({ length: 24 }, (_, k) => ({
					x: (side * 30 * (k + 1)) / 24,
					y: 32
				}));
				const reached = press(ui, { x: 0, y: 32 }, path, () => expect(at(ui, 'q')).toEqual(q));
				expect(reached).toBe(true);
				expect(at(ui, 'q')).toEqual(q);
				throughHistory(ui, before, q);
			});

			test(`a spur's end let go with the spur lying over a loose footpath end leaves the footpath end where it lay: ${name}`, () => {
				const ui = openEditor(scene(o));
				const q = at(ui, 'q');
				const before = JSON.stringify(ui.graph());
				ui.click(0, 40);
				// Swung until the spur's line runs through the loose end.
				const turn = 1 - Math.atan2(24, 14) / (Math.PI / 2);
				const reached = press(ui, { x: 0, y: 40 }, swing(side, turn, 16), () =>
					expect(at(ui, 'q')).toEqual(q)
				);
				expect(reached).toBe(true);
				expect(onSpur(ui, 'q')).toBe(true);
				expect(at(ui, 'q')).toEqual(q);
				throughHistory(ui, before, q);
			});
		}

for (const side of [1, -1] as const)
	test(`a footpath end on the spur's ground as the press began rides it all the way, past a loose end the spur leaves: ${side > 0 ? 'right' : 'left'}`, () => {
		const o = { preset: 'street', reversed: false, curved: false, shift: 0, side, rider: true };
		const ui = openEditor(scene(o));
		const q = at(ui, 'q');
		const spur = ui.editor.graph.segments.get('spur')!;
		const place = () => {
			const r = at(ui, 'r');
			const { t, distance } = closestOnRoad(ui.editor.graph, spur, r.x, r.y);
			return { t, distance };
		};
		const start = place();
		expect(start.distance).toBeGreaterThan(1);
		ui.click(0, 40);
		const reached = press(ui, { x: 0, y: 40 }, swing(side, 1, 24), () => {
			expect(at(ui, 'q')).toEqual(q);
			expect(place().t).toBeCloseTo(start.t, 6);
			expect(place().distance).toBeCloseTo(start.distance, 6);
		});
		expect(reached).toBe(true);
		// Carried round with the spur, now lying along the x axis.
		expect(Math.abs(ui.node('r').y)).toBeLessThan(5);
		expect(ui.stale()).toEqual([]);
	});

// Streets meeting at the origin, `j`, from `w` and `e` on the x axis and
// from `s` north of it if given, with `edits` at the junction, the east
// street in `east`, and the footpaths of `more`.
const meeting = (
	at: { w: number; e: number; s?: number },
	east: string,
	edits: Partial<GraphData['nodes'][number]>,
	more: Pick<GraphData, 'nodes' | 'segments'>
) =>
	({
		nodes: [
			{ id: 'j', x: 0, y: 0, ...edits },
			{ id: 'w', x: at.w, y: 0 },
			{ id: 'e', x: at.e, y: 0 },
			...(at.s ? [{ id: 's', x: 0, y: at.s }] : []),
			...more.nodes
		],
		segments: [
			{ id: 'west', startNodeId: 'w', endNodeId: 'j', lanes: createLanesFrom('street') },
			{ id: 'east', startNodeId: 'j', endNodeId: 'e', lanes: createLanesFrom(east) },
			...(at.s
				? [{ id: 'south', startNodeId: 'j', endNodeId: 's', lanes: createLanesFrom('street') }]
				: []),
			...more.segments
		]
	}) as GraphData;

test('a loose end the second build of a frame first finds on a walkway stays where it lay', () => {
	// A footpath from the T's east-south corner, its far end shifted 1.5 m and
	// loose beside the south street. The east street's node dragged north
	// turns the corner and the follower carries the joined end with it, which
	// swings the far end onto the south street's sidewalk in the frame's
	// second build.
	const ui = openEditor(
		meeting(
			{ w: -27, e: 27, s: 26 },
			'street',
			{},
			{
				nodes: [
					{ id: 'r', x: 6.68, y: 4.94 },
					{ id: 'q', x: 6.75, y: 26 }
				],
				segments: [
					{
						id: 'path',
						startNodeId: 'r',
						endNodeId: 'q',
						lanes: createLanesFrom('path'),
						offsetEnd: 1.5
					}
				]
			}
		)
	);
	const before = JSON.stringify(ui.graph());
	const q = at(ui, 'q');
	const r = at(ui, 'r');
	ui.click(27, 0);
	const path = [
		{ x: 27, y: 12 },
		{ x: 27, y: 14 },
		{ x: 27, y: 17 }
	];
	press(ui, { x: 27, y: 0 }, path, () => expect(at(ui, 'q')).toEqual(q));
	expect(at(ui, 'r')).not.toEqual(r);
	throughHistory(ui, before, q);
});

// A setback handle dragged from 10 m to 40 m along the east street draws
// the junction's walkways anew across a loose footpath end: a T's corner,
// and the sidewalk of a street tapering into an avenue.
for (const [east, s, setbacks, q] of [
	['street', 85, { west: 10, east: 10, south: 10 }, { x: 8, y: 6 }],
	['avenue', undefined, { west: 10, east: 10 }, { x: 2, y: 7 }]
] as const)
	test(`a setback handle drawing a walkway over a loose end leaves it where it lay: ${east}`, () => {
		const ui = openEditor(
			meeting(
				{ w: -90, e: 90, s },
				east,
				{ junction: { setbacks } },
				{
					nodes: [
						{ id: 'q', ...q },
						{ id: 'f', x: q.x, y: q.y + 45 }
					],
					segments: [
						{ id: 'path', startNodeId: 'q', endNodeId: 'f', lanes: createLanesFrom('path') }
					]
				}
			)
		);
		const before = JSON.stringify(ui.graph());
		ui.click(0, 0);
		const handle = ui.editor.currentTaperHandles.find((h) => h.segmentId === 'east')?.handle;
		expect(handle).toEqual({ x: 10, y: 0 });
		const path = Array.from({ length: 60 }, (_, k) => ({ x: 10.5 + k * 0.5, y: 0 }));
		press(ui, { x: 10, y: 0 }, path, () => expect(at(ui, 'q')).toEqual(q));
		throughHistory(ui, before, q);
	});
