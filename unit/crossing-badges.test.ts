import { expect, test } from 'bun:test';
import { createLanesFrom } from '../src/lib/core/lane-template';
import { Networks } from '../src/lib/core/networks';
import type { GraphData, Lane } from '../src/lib/core/types';
import { inside, toPath } from '../src/lib/road-model/clip';
import { placeBadges } from '../src/lib/components/badge-layout';
import { cityOf, frame, openEditor } from './editor.svelte';
import { liveShape } from './model';

// A crossing's badge shows for every car road whose own ground its zebra
// lies on, whichever road's roadway holds it: a zebra over a street running
// on into the next street past their node shows on selecting either.

const drive = (direction: Lane['direction']): Lane => ({
	role: 'vehicle',
	material: 'asphalt',
	width: 3.5,
	direction
});

// A west street with sidewalks and an east street without them, joined at
// (0, 0), and a footpath from (-40, -20) to `to`.
const city = (to: { x: number; y: number }): GraphData => ({
	nodes: [
		{ id: 'w', x: -60, y: 0 },
		{ id: 'm', x: 0, y: 0 },
		{ id: 'e', x: 60, y: 0 },
		{ id: 'p', x: -40, y: -20 },
		{ id: 'q', ...to }
	],
	segments: [
		{ id: 'west', startNodeId: 'w', endNodeId: 'm', lanes: createLanesFrom('street') },
		{ id: 'east', startNodeId: 'm', endNodeId: 'e', lanes: [drive('backward'), drive('forward')] },
		{ id: 'path', startNodeId: 'p', endNodeId: 'q', lanes: createLanesFrom('path') }
	]
});

const badges = (data: GraphData) => {
	const networks = new Networks();
	networks.build(liveShape(data) as never);
	return (id: string) => networks.crossingsOn([id]).length;
};

test("a zebra reaching onto the next street's lanes shows its badge on selecting either street", () => {
	const on = badges(city({ x: 28, y: 20 }));
	expect(on('path')).toBe(1);
	expect(on('west')).toBe(1);
	expect(on('east')).toBe(1);
});

test('a zebra clear of the next street shows no badge on selecting it', () => {
	const on = badges(city({ x: -40, y: 20 }));
	expect(on('west')).toBe(1);
	expect(on('east')).toBe(0);
});

// Swept: two streets joined at (0, 0), each set back 6 m there, the east
// one straight on or turning either way, each stored either way, and a
// footpath across them sliding from the west street through the junction
// onto the east one. At every step, selecting a street shows a badge of
// the footpath's crossing exactly where its zebra is drawn on that street's
// ground: the street's own, or the junction at its node.
const joined = (turn: number, flip: [boolean, boolean], x: number): GraphData => {
	const far = { x: 50 * Math.cos(turn), y: 50 * Math.sin(turn) };
	const street = (id: string, a: string, b: string, back: boolean) => ({
		id,
		startNodeId: back ? b : a,
		endNodeId: back ? a : b,
		lanes: [drive('backward'), drive('forward')]
	});
	return {
		nodes: [
			{ id: 'w', x: -50, y: 0 },
			{ id: 'm', x: 0, y: 0, junction: { setbacks: { west: 6, east: 6 } } },
			{ id: 'e', ...far },
			{ id: 'p', x: x - 5, y: -20 },
			{ id: 'q', x: x + 5, y: 20 }
		],
		segments: [
			street('west', 'w', 'm', flip[0]),
			street('east', 'm', 'e', flip[1]),
			{ id: 'path', startNodeId: 'p', endNodeId: 'q', lanes: createLanesFrom('path') }
		]
	};
};
for (const turn of [0, 0.35, -0.6])
	test(`a zebra sliding through a junction turning ${turn} shows its badge on each street it is drawn on`, () => {
		const wrong: string[] = [];
		for (const flip of [
			[false, false],
			[true, false],
			[false, true]
		] as [boolean, boolean][])
			for (let x = -16; x <= 16; x += 2) {
				const networks = new Networks();
				const { scene } = networks.build(liveShape(joined(turn, flip, x)) as never);
				// Where the footpath's zebra is drawn: the car pieces drawing one.
				const zebraOn = (id: string) =>
					!!(scene.road(id) ?? scene.node(id))?.crossings.some((c) =>
						c.runs.some((r) => r.kind === 'zebra')
					);
				const junctions = scene.place.junctions.filter((j) => j.members.includes('m'));
				for (const street of ['west', 'east']) {
					const want = zebraOn(street) || junctions.some((j) => zebraOn(j.id)) ? 1 : 0;
					const got = networks.crossingsOn([street]).length ? 1 : 0;
					if (got !== want) wrong.push(`${flip} x ${x} ${street}: ${got}, drawn ${want}`);
				}
			}
		expect(wrong).toEqual([]);
	});

// Every lookup of a footpath's crossing reads where the street paints it:
// a crossing whose ground another already has is painted nowhere, and so
// has no badge, is under no point and shows its footpath nowhere on the
// lanes. Swept: a wide and a narrow footpath across a street cut at a node
// with a side street, each id first in turn (the first takes ground they
// share), the narrow sliding along the street from clear of the wide,
// through it, out the other side, and on into the junction.
const walk = (width: number): Lane[] => [{ ...createLanesFrom('path')[0], width }];
const pair = (first: string, widths: [number, number], x: number): GraphData => ({
	nodes: [
		{ id: 'w', x: -50, y: 0 },
		{ id: 'm', x: 20, y: 0 },
		{ id: 'e', x: 60, y: 0 },
		{ id: 'n', x: 20, y: 40 },
		{ id: 'a', x: 0, y: -20 },
		{ id: 'b', x: 0, y: 20 },
		{ id: 'c', x, y: -20 },
		{ id: 'd', x, y: 20 }
	],
	segments: [
		{ id: 'west', startNodeId: 'w', endNodeId: 'm', lanes: createLanesFrom('street') },
		{ id: 'east', startNodeId: 'm', endNodeId: 'e', lanes: createLanesFrom('street') },
		{ id: 'north', startNodeId: 'm', endNodeId: 'n', lanes: createLanesFrom('street') },
		{ id: `${first}wide`, startNodeId: 'a', endNodeId: 'b', lanes: walk(widths[0]) },
		{
			id: `${first === 'a' ? 'b' : 'a'}narrow`,
			startNodeId: 'c',
			endNodeId: 'd',
			lanes: walk(widths[1])
		}
	]
});
for (const widths of [
	[4, 2],
	[3, 3]
] as [number, number][])
	test(`crossings of footpaths ${widths[0]} m and ${widths[1]} m wide are found where they are painted`, () => {
		const wrong: string[] = [];
		for (const first of ['a', 'b'])
			for (let x = -6; x <= 24; x += 0.5) {
				const networks = new Networks();
				const { scene } = networks.build(liveShape(pair(first, widths, x)) as never);
				const painted = [
					...scene.place.roads.flatMap((r) => scene.road(r.id)?.crossings ?? []),
					...scene.place.junctions.flatMap((j) => scene.node(j.id)?.crossings ?? [])
				].filter((c) => c.of && c.body.length);
				for (const path of [`${first}wide`, `${first === 'a' ? 'b' : 'a'}narrow`]) {
					const want = [...new Set(painted.flatMap((c) => (c.of?.startsWith(path) ? [c.of] : [])))];
					const got = networks.crossingsOn([path]);
					if (got.sort().join() !== want.sort().join())
						wrong.push(`${first} x ${x} ${path} badges ${got}, painted ${want}`);
				}
				// Each point of the car lanes round the narrow footpath: the
				// crossing under it, and whether each footpath shows there (off the
				// edges between crossings, which touch both).
				for (let px = x - 2.875; px < x + 3; px += 0.25)
					for (const py of [-2.5, -0.5, 1.5]) {
						const p = { x: px, y: py };
						const under = painted.find((c) => inside(c.body.map(toPath), p))?.of ?? null;
						if (networks.crossingAt(p) !== under)
							wrong.push(
								`${first} x ${x} at ${px},${py}: ${networks.crossingAt(p)}, painted ${under}`
							);
						for (const path of [`${first}wide`, `${first === 'a' ? 'b' : 'a'}narrow`]) {
							const own = painted.some(
								(c) => c.of?.startsWith(path) && inside(c.body.map(toPath), p)
							);
							// Every point read lies on the street's car lanes or the
							// junction's.
							if (!own && networks.onOwnCrossing(path, p))
								wrong.push(`${first} x ${x} ${path} shows at ${px},${py}`);
						}
					}
			}
		expect(wrong).toEqual([]);
	});

// A button stays within the map's view where there is room for it there:
// two crossings 8 m apart on a Street (two Paths straight across it), the
// Street selected, at zoom 1 on the top-down camera, panned until their
// middles lie 12 px inside one edge of a 1280 by 720 view, then each other
// edge, the Street running along that edge or across it. Both buttons
// stand wholly within the view, clear of each other; a button that would
// stand partly out of the view at its middle stands on the nearest point
// inside. With no room in the view for two, the second stands as near its
// crossing as the view allows. A crossing well out of the view keeps its
// button off it.
test('crossing buttons stay within the view, as near their crossings as it allows', () => {
	const W = 48;
	const H = 20;
	const view = { x0: 0, y0: 0, x1: 1280, y1: 720 };
	const inView = (p: { x: number; y: number }) =>
		p.x - W / 2 >= view.x0 &&
		p.x + W / 2 <= view.x1 &&
		p.y - H / 2 >= view.y0 &&
		p.y + H / 2 <= view.y1;
	const apart = (p: { x: number; y: number }, q: { x: number; y: number }) =>
		Math.abs(p.x - q.x) >= W || Math.abs(p.y - q.y) >= H;
	const px = 720 / 500;
	const wrong: string[] = [];
	for (const along of [false, true]) {
		// The Street along x (or y), the Paths across it 8 m apart.
		const at = (u: number, v: number): [number, number] => (along ? [u, v] : [v, u]);
		const ui = openEditor(
			cityOf(
				{ a: at(-60, 0), b: at(60, 0), p: at(-4, -25), q: at(-4, 25), r: at(4, -25), s: at(4, 25) },
				[
					{ id: 'street', from: 'a', to: 'b', lanes: 'street' },
					{ id: 'first', from: 'p', to: 'q', lanes: 'path' },
					{ id: 'second', from: 'r', to: 's', lanes: 'path' }
				]
			)
		);
		ui.editor.selectSegment('street');
		frame();
		const badges = ui.editor.crossingBadges;
		if (badges.length !== 2) wrong.push(`${along}: ${badges.length} badges`);
		const mid = {
			x: (badges[0].x + badges[1].x) / 2,
			y: (badges[0].y + badges[1].y) / 2
		};
		// The camera panned so the crossings' middle stands at `to` on screen.
		const lay = (to: { x: number; y: number }, v = view) =>
			placeBadges(
				badges.map((b) => ({
					at: { x: to.x + (b.x - mid.x) * px, y: to.y + (b.y - mid.y) * px },
					width: W,
					height: H
				})),
				[],
				v
			);
		const edges = {
			top: { x: 640, y: 12 },
			bottom: { x: 640, y: 708 },
			left: { x: 12, y: 360 },
			right: { x: 1268, y: 360 }
		};
		for (const [edge, to] of Object.entries(edges)) {
			const placed = lay(to);
			const where = `${along ? 'along' : 'across'} the ${edge} edge`;
			if (!placed.every(inView)) wrong.push(`${where}: a button out of view`);
			if (!apart(placed[0], placed[1])) wrong.push(`${where}: buttons overlap`);
		}
		// A middle on the edge: its button on the nearest point inside.
		const [onEdge] = lay({ x: 640, y: 0 });
		if (Math.abs(onEdge.y - H / 2) > 1e-9 && Math.abs(onEdge.y - (H / 2 + H + 4)) > 1e-9)
			wrong.push(`${along}: a button on the edge stands at ${onEdge.y}`);
		// Well out of the view, off it.
		if (lay({ x: 640, y: -60 }).some(inView)) wrong.push(`${along}: a button far off shown`);
		// No room for two: a view as small as one button. Both stay in it.
		const tight = { x0: 600, y0: 0, x1: 600 + W, y1: H };
		const squeezed = lay({ x: 624, y: 10 }, tight);
		if (!squeezed.every((p) => p.x === 624 && p.y === 10))
			wrong.push(`${along}: squeezed to ${JSON.stringify(squeezed)}`);
	}
	expect(wrong).toEqual([]);
});

// Crossing buttons keep one size on screen whatever the zoom
// (components/badge-layout.ts): two Paths across a Street 3 m apart, and a
// third 40 m along, at the zooms the map is used at, the camera anywhere
// over them. No two buttons overlap, the first stays on its crossing's
// middle, and one with room stays there too.
test('the buttons of crossings close together stand apart on screen at any zoom', () => {
	const W = 48;
	const H = 20;
	const ui = openEditor(
		cityOf(
			{
				a: [-60, 0],
				b: [60, 0],
				p: [-1.5, -25],
				q: [-1.5, 25],
				r: [1.5, -25],
				s: [1.5, 25],
				t: [40, -25],
				u: [40, 25]
			},
			[
				{ id: 'street', from: 'a', to: 'b', lanes: 'street' },
				{ id: 'first', from: 'p', to: 'q', lanes: 'path' },
				{ id: 'second', from: 'r', to: 's', lanes: 'path' },
				{ id: 'third', from: 't', to: 'u', lanes: 'path' }
			]
		)
	);
	ui.editor.selectSegment('street');
	frame();
	const badges = ui.editor.crossingBadges;
	expect(badges).toHaveLength(3);
	const wrong: string[] = [];
	for (const zoom of [0.25, 0.5, 1, 2, 6])
		for (const pan of [-20, 0, 35]) {
			const px = (720 / 500) * zoom;
			const at = badges.map((b) => ({ x: 640 + (b.x - pan) * px, y: 360 + b.y * px }));
			const placed = placeBadges(
				at.map((p) => ({ at: p, width: W, height: H })),
				[],
				{ x0: 0, y0: 0, x1: 1280, y1: 720 }
			);
			const where = `zoom ${zoom}, at ${pan}`;
			for (const [i, p] of placed.entries())
				for (const q of placed.slice(i + 1))
					if (Math.abs(p.x - q.x) < W && Math.abs(p.y - q.y) < H) wrong.push(`${where}: overlap`);
			const inView = (k: number) => at[k].x - W / 2 >= 0 && at[k].x + W / 2 <= 1280;
			if (inView(0) && (placed[0].x !== at[0].x || placed[0].y !== at[0].y))
				wrong.push(`${where}: the first moved`);
			if (inView(2) && Math.abs(at[2].x - at[1].x) > W + 4 && placed[2].x !== at[2].x)
				wrong.push(`${where}: the third moved`);
		}
	expect(wrong).toEqual([]);
});
