import { cityOf, openEditor } from './editor.svelte';

// Every gesture that places a footpath's node by where its end shows, done
// where the editor places it as it did before footpaths took a shift: on
// footpaths with no shift, a node riding a street that moves, sliding along
// a walkway, kept on a walkway its street draws anew, dropped on a
// sidewalk, and joined to a dead end (placedBy in src/lib/core/drag.ts: a
// node with no shift moves by where it lies). Each step is read as the editor stores it
// (the graph of its undo step) and draws it (every piece's description),
// each by a hash of its JSON. `unit/footpaths-as-before.json` holds the
// graph the editor stored for each before footpaths took a shift, and the
// drawing the current code makes for it with the shift work reversed (the
// crossings having changed since), and the editor still does exactly that
// (unit/footpaths-as-before.test.ts). To record again, run
// `bun --preload ./unit/runes.ts unit/footpaths-as-before.ts` twice, each
// into a file of its own: in that older editor for the graph hashes, and in
// the current code with the shift work reversed for the drawing hashes. A
// run prints both hashes of every step, so the record is the two joined by
// step name, never one run's output whole.
//
// The points are worked out here, not by the editor's own geometry, so the
// gestures are the same whichever editor runs them.

type P = { x: number; y: number };
const p = (x: number, y: number) => ({ x, y });
type Kind = 'street' | 'avenue';
// How far right of its line the middle of each preset's sidewalk lies.
const WALK: Record<Kind, number> = { street: 4.5, avenue: 10.5 };

// A quadratic from a through handle c to b at t, with its right normal.
function curveAt(a: P, c: P, b: P, t: number) {
	const u = 1 - t;
	const point = p(
		u * u * a.x + 2 * u * t * c.x + t * t * b.x,
		u * u * a.y + 2 * u * t * c.y + t * t * b.y
	);
	const d = p(2 * u * (c.x - a.x) + 2 * t * (b.x - c.x), 2 * u * (c.y - a.y) + 2 * t * (b.y - c.y));
	const l = Math.hypot(d.x, d.y);
	return { point, normal: p(-d.y / l, d.x / l) };
}
const across = (a: P, c: P, b: P, t: number, by: number) => {
	const { point, normal } = curveAt(a, c, b, t);
	return p(point.x + normal.x * by, point.y + normal.y * by);
};

export type Step = { name: string; graph: string; drawing: string };

// The sweep by kind of gesture, each giving its steps.
export const sweeps = {
	'ride a street': () => ride('street'),
	'ride an avenue': () => ride('avenue'),
	curved,
	slide,
	follow,
	drop,
	deadEnds,
	corners
};

type Take = (name: string, ui: ReturnType<typeof openEditor>) => void;
function run(gestures: (take: Take) => void) {
	const steps: Step[] = [];
	gestures((name, ui) => {
		const scene = ui.editor.roadRenderer.scene!;
		const drawing = JSON.stringify(
			[
				...scene.place.roads.map((r) => [r.id, scene.road(r.id)]),
				...scene.place.junctions.map((j) => [j.id, scene.node(j.id)])
			],
			(k, v) => (k === 'key' ? undefined : v)
		);
		steps.push({
			name,
			graph: Bun.hash(JSON.stringify(ui.saved())).toString(16),
			drawing: Bun.hash(drawing).toString(16)
		});
	});
	return steps;
}

// A path from `q` to `f`, stored from q or toward it (`down`), curved
// through `c` where given.
const path = (id: string, q: string, f: string, down = false, c?: P) => ({
	id,
	from: down ? f : q,
	to: down ? q : f,
	lanes: 'path' as const,
	...(c && { control: c })
});

// Riding: a path's end on the east arm's sidewalk of a T, the arm swung,
// its body dragged, or the T dragged; straight or curved, stored either
// way, on either side.
function ride(kind: Kind) {
	return run((take) => {
		for (const side of [1, -1])
			for (const down of [false, true])
				for (const bent of [false, true])
					for (const [move, from, to] of [
						['swung', p(60, 0), p(60, 15)],
						['body', p(40, 0), p(40, -6)],
						['T', p(0, 0), p(-5, 4)]
					] as const) {
						const q = p(4 * WALK[kind] + 3, side * WALK[kind]);
						const ui = openEditor(
							cityOf(
								{
									o: [0, 0],
									w: [-60, 0],
									e: [60, 0],
									s: [0, -80 * side],
									q: [q.x, q.y],
									f: [q.x + 7, side * 40]
								},
								[
									{ id: 'west', from: 'w', to: 'o', lanes: kind },
									{ id: 'east', from: 'o', to: 'e', lanes: kind },
									{ id: 'stem', from: 'o', to: 's', lanes: kind },
									path('path', 'q', 'f', down, bent ? p(q.x, side * 25) : undefined)
								]
							)
						);
						ui.click(from.x, from.y);
						ui.drag(from, to, {}, 6);
						take(`ride ${kind} ${side} ${down ? 'down' : 'up'}${bent ? ' bent' : ''} ${move}`, ui);
					}
	});
}

// Riding a curved street: one path end on its sidewalk, or a path along
// the sidewalk with both ends on it; the street's end or handle dragged.
function curved() {
	return run((take) => {
		for (const kind of ['street', 'avenue'] as Kind[])
			for (const side of [1, -1])
				for (const both of [false, true]) {
					const [a, c, b] = [p(-60, 0), p(0, 24), p(60, 0)];
					const q = across(a, c, b, 0.4, side * WALK[kind]);
					const f = both ? across(a, c, b, 0.6, side * WALK[kind]) : p(q.x - 4, q.y + side * 30);
					for (const [move, from, to] of [
						['end', p(60, 0), p(64, 12)],
						['handle', null, p(0, 4)]
					] as const) {
						const ui = openEditor(
							cityOf({ a: [a.x, a.y], b: [b.x, b.y], q: [q.x, q.y], f: [f.x, f.y] }, [
								{ id: 'street', from: 'a', to: 'b', lanes: kind, control: c },
								path('path', 'q', 'f')
							])
						);
						if (from) {
							ui.click(from.x, from.y);
							ui.drag(from, to, {}, 4);
						} else {
							ui.click(a.x + 8, curveAt(a, c, b, 8 / 120).point.y);
							ui.drag(c, to, {}, 4);
						}
						take(`curved ${kind} ${side}${both ? ' both' : ''} ${move}`, ui);
					}
				}
	});
}

// Sliding: a path's end on a street's sidewalk dragged along it and
// across it, straight or curved.
function slide() {
	return run((take) => {
		for (const kind of ['street', 'avenue'] as Kind[])
			for (const bent of [false, true])
				for (const to of [p(-6, 1), p(9, -3), p(14, 12)]) {
					const q = p(-20, WALK[kind]);
					const ui = openEditor(
						cityOf({ a: [-80, 0], b: [80, 0], q: [q.x, q.y], f: [-15, 30] }, [
							{ id: 'street', from: 'a', to: 'b', lanes: kind },
							path('path', 'q', 'f', false, bent ? p(-8, 10) : undefined)
						])
					);
					ui.drag(q, p(q.x + to.x, q.y + to.y));
					take(`slide ${kind}${bent ? ' bent' : ''} ${to.x},${to.y}`, ui);
				}
	});
}

// Following: the street a path's end lies on bent by its handle, then
// widened, the end kept on its sidewalk; straight or curved, stored
// either way.
function follow() {
	return run((take) => {
		for (const kind of ['street', 'avenue'] as Kind[])
			for (const down of [false, true])
				for (const bent of [false, true]) {
					const q = p(-20, WALK[kind]);
					const ui = openEditor(
						cityOf({ a: [-80, 0], b: [80, 0], q: [q.x, q.y], f: [-17, 40] }, [
							{ id: 'street', from: 'a', to: 'b', lanes: kind },
							path('path', 'q', 'f', down, bent ? p(-12, 32) : undefined)
						])
					);
					const name = `${kind} ${down ? 'down' : 'up'}${bent ? ' bent' : ''}`;
					ui.click(-40, 0);
					ui.drag(p(0, 0), p(0, 20));
					take(`follow bent ${name}`, ui);
					ui.editor.editLanes((lanes) => {
						for (const lane of lanes) if (lane.role === 'vehicle') lane.width += 2;
					});
					take(`follow widened ${name}`, ui);
				}
	});
}

// Dropping: a path's free end dragged onto a street's sidewalk or the
// roadway beside it, the path long, curved, or ending half a metre short
// of the sidewalk, on a straight or a curved street.
function drop() {
	return run((take) => {
		for (const kind of ['street', 'avenue'] as Kind[])
			for (const [shape, far, c] of [
				['long', p(25, -42), undefined],
				['long bent', p(25, -42), p(13, -31)],
				['short', p(17, -WALK[kind] - 0.5), undefined]
			] as const)
				for (const curved of [false, true])
					for (const [aim, by] of [
						['sidewalk', 0.4],
						['roadway', 3.5]
					] as const) {
						const [a, h, b] = [p(-80, 0), p(0, curved ? -16 : 0), p(80, 0)];
						const ui = openEditor(
							cityOf({ a: [a.x, a.y], b: [b.x, b.y], j: [17, -20], f: [far.x, far.y] }, [
								{ id: 'street', from: 'a', to: 'b', lanes: kind, ...(curved && { control: h }) },
								path('path', 'j', 'f', false, c)
							])
						);
						ui.click(17, -20);
						ui.drag(p(17, -20), across(a, h, b, 97 / 160, -WALK[kind] + by));
						take(`drop ${kind} ${shape}${curved ? ' curved street' : ''} on ${aim}`, ui);
					}
	});
}

// Dead ends: a path ending on a street's dead end, as opened; a street's
// dead end dragged off and onto another path's end; a path's end dragged
// onto a street's dead end; and a dead end of either kind dragged onto a
// road of its own kind.
function deadEnds() {
	return run((take) => {
		for (const kind of ['street', 'avenue'] as Kind[])
			for (const down of [false, true]) {
				const name = `${kind} ${down ? 'down' : 'up'}`;
				const open = () =>
					openEditor(
						cityOf(
							{ a: [-60, 0], b: [0, 0], q: [0, 0], f: [30, 25], g: [40, -30], h: [-30, -30] },
							[
								{ id: 'street', from: 'a', to: 'b', lanes: kind },
								path('path', 'q', 'f', down),
								path('free', 'g', 'h', down)
							]
						)
					);
				take(`dead end ${name} as opened`, open());
				let ui = open();
				ui.click(0, 0);
				ui.drag(p(0, 0), p(-12, 6));
				ui.drag(p(-12, 6), p(-30, -30));
				take(`dead end ${name} street end onto path end`, ui);
				ui = open();
				ui.click(40, -30);
				ui.drag(p(40, -30), p(0, 0));
				take(`dead end ${name} path end onto street end`, ui);
			}
		for (const kind of ['street', 'path'] as const) {
			const ui = openEditor(
				cityOf({ a: [-70, 0], b: [70, 0], j: [10, -14], f: [10, -45] }, [
					{ id: 'through', from: 'a', to: 'b', lanes: kind },
					{ id: 'branch', from: 'f', to: 'j', lanes: kind }
				])
			);
			ui.drag(p(10, -14), p(10, 0));
			take(`same kind dead end ${kind}`, ui);
		}
		// A path's end where two unjoined streets end, 0, 5 mm or 2 cm apart.
		for (const dx of [0, 0.005, 0.02]) {
			const ui = openEditor(
				cityOf({ a: [-50, 0], j: [0, 0], f: [0, -55], c: [dx, 0], d: [dx + 45, 0] }, [
					{ id: 'street', from: 'a', to: 'j', lanes: 'street' },
					{ id: 'path', from: 'f', to: 'j', lanes: 'path' },
					{ id: 'second', from: 'c', to: 'd', lanes: 'street' }
				])
			);
			take(`two dead ends ${dx}`, ui);
		}
		// A path's end on a street's dead end with a car node three roads end
		// at, or a node a street only carries on through, 0, 5 mm or 2 cm off;
		// and a path's free end dragged onto where two streets end.
		for (const [other, outs] of [
			['junction', [p(40, 0), p(30, 40), p(30, -40)]],
			['carried on', [p(-3, 45), p(3, 45)]]
		] as const)
			for (const dx of [0, 0.005, 0.02]) {
				const ui = openEditor(
					cityOf(
						{
							a: [-50, 0],
							j: [0, 0],
							f: [0, -55],
							c: [dx, 0],
							...Object.fromEntries(outs.map((q, k) => [`o${k}`, [q.x + dx, q.y]]))
						},
						[
							{ id: 'street', from: 'a', to: 'j', lanes: 'street' },
							{ id: 'path', from: 'f', to: 'j', lanes: 'path' },
							...outs.map((_, k) => ({
								id: `out${k}`,
								from: `o${k}`,
								to: 'c',
								lanes: 'street' as const
							}))
						]
					)
				);
				take(`dead end with ${other} ${dx}`, ui);
			}
		for (const dx of [0, 0.005]) {
			const ui = openEditor(
				cityOf(
					{ a: [-50, 0], j: [0, 0], c: [dx, 0], d: [dx + 45, 0], g: [10, -40], h: [-20, -50] },
					[
						{ id: 'street', from: 'a', to: 'j', lanes: 'street' },
						{ id: 'second', from: 'c', to: 'd', lanes: 'street' },
						path('path', 'g', 'h')
					]
				)
			);
			ui.click(10, -40);
			ui.drag(p(10, -40), p(0, 0));
			take(`path end onto two dead ends ${dx}`, ui);
		}
		// Two streets at an angle dragged by their body till the node they
		// share lies 5 mm or 2 cm from a third street's dead end where a
		// path ends.
		for (const dx of [0.005, 0.02]) {
			const ui = openEditor(
				cityOf(
					{
						w: [-74, 0],
						z: [0, 0],
						j: [20, 0],
						a: [58, 27],
						b: [55, -29],
						q: [0, 0],
						f: [-8, -35]
					},
					[
						{ id: 'dead', from: 'w', to: 'z', lanes: 'street' },
						{ id: 'ne', from: 'j', to: 'a', lanes: 'street' },
						{ id: 'se', from: 'b', to: 'j', lanes: 'street' },
						path('path', 'f', 'q')
					]
				)
			);
			ui.click(45, 17.763157894736842);
			ui.click(37.5, -14.5, { shift: true });
			ui.drag(p(45, 17.763157894736842), p(25 + dx, 17.763157894736842), {}, 1);
			take(`junction dragged ${dx} from a dead end`, ui);
		}
	});
}

// Corners: two or three paths with no shift meeting at a node on a T's
// sidewalk, on a corner or on the arm, all of one width or of several, the
// T's east arm dragged by its end or bodily (pressed clear of every path's
// crossing, so every editor takes hold of the street), or widened. Their
// ends show at one spot, so the node is held by the path whose id sorts
// first, as it was.
function corners() {
	return run((take) => {
		for (const [where, side, j] of [
			['west corner', -1, p(-5.8951662899618675, 11.107477531275311)],
			['east corner', 1, p(4.610520318409293, 7.56621854457638)],
			['arm', 1, p(8.9, -4.5)]
		] as const)
			for (const n of [2, 3])
				for (const mixed of [false, true])
					for (const act of ['arm', 'road', 'widen'] as const) {
						const [u, v, q] = [
							p(j.x - 16, j.y + 18 * side),
							p(j.x + 23, j.y + 8 * side),
							p(j.x - 8, j.y - 13 * side)
						];
						const city = cityOf(
							{
								l: [0, 0],
								r: [62, 0],
								w: [-62, 0],
								t: [0, 60],
								j: [j.x, j.y],
								u: [u.x, u.y],
								v: [v.x, v.y],
								q: [q.x, q.y]
							},
							[
								{ id: 'east', from: 'l', to: 'r', lanes: 'street' },
								{ id: 'west', from: 'w', to: 'l', lanes: 'avenue' },
								{ id: 'stem', from: 'l', to: 't', lanes: 'street' },
								path('a', 'u', 'j'),
								path('b', 'j', 'v', false, p((v.x + j.x) / 2 + 3, (v.y + j.y) / 2)),
								...(n === 3 ? [path('c', 'q', 'j')] : [])
							]
						);
						if (mixed) city.segments.slice(3).forEach((s, k) => (s.lanes[0].width = [2, 8, 4][k]));
						const ui = openEditor(city);
						if (act === 'arm') ui.drag(p(62, 0), p(66, 8 * side), {}, 5);
						if (act === 'road') ui.drag(p(44, 0), p(48, -7.2 * side), {}, 5);
						if (act === 'widen') {
							ui.click(35.34, 0);
							ui.editor.editLanes((lanes) => {
								for (const lane of lanes) if (lane.role === 'vehicle') lane.width += 2;
							});
						}
						take(`corner ${where} ${n} paths${mixed ? ' mixed' : ''} ${act}`, ui);
					}
	});
}

export type Recorded = Record<string, Omit<Step, 'name'>>;

if (import.meta.main)
	console.log(
		JSON.stringify(
			Object.fromEntries(
				Object.values(sweeps)
					.flatMap((sweep) => sweep())
					.map(({ name, ...rest }) => [name, rest])
			),
			null,
			'\t'
		)
	);
