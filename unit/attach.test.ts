import { expect, test } from 'bun:test';
import { sideToward } from '../src/lib/core/attach';
import { createLanesFrom } from '../src/lib/core/lane-template';
import type { GraphData, Lane } from '../src/lib/core/types';
import { inside, offset, toPath, union } from '../src/lib/road-model/clip';
import { check } from '../src/lib/road-model/checks';
import type { Description, Marking, Role } from '../src/lib/road-model/description';
import type { Drawing } from '../src/lib/road-model/drawing';
import type { Pt } from '../src/lib/road-model/model';
import { attachedEnd, buildModel, liveShape } from './model';

// A road attached at the edge of another that carries on (core/attach.ts):
// where its end is drawn, which lanes it joins, and what is drawn of it
// across the node.

const preset = (id: string): Lane[] => createLanesFrom(id).map((l, i) => ({ ...l, id: `l${i}` }));

// An Avenue drawn north to south (its roadway 8 m either side of its line,
// then 1 m of verge and 3 m of sidewalk; southbound on the west, a 2 m
// median, northbound on the east) and a side road from `m` on it east to
// `e`, stored as draw mode stores a road whose end was clicked on the
// avenue's east edge. `through`: the avenue carries on south of `m`; `into`:
// the side road is drawn toward `m`; `y`: how far north or south of due east
// its far end lies.
function sideRoad(lanes: Lane[], { through = true, into = false, y = 0 } = {}): GraphData {
	const data: GraphData = {
		nodes: [
			{ id: 'n', x: 0, y: -100 },
			{ id: 'm', x: 0, y: 0 },
			{ id: 's', x: 0, y: 100 },
			{ id: 'e', x: 100, y }
		],
		segments: [
			{ id: 'north', startNodeId: 'n', endNodeId: 'm', lanes: preset('avenue') },
			...(through
				? [{ id: 'south', startNodeId: 'm', endNodeId: 's', lanes: preset('avenue') }]
				: []),
			{ id: 'side', startNodeId: into ? 'e' : 'm', endNodeId: into ? 'm' : 'e', lanes }
		]
	};
	const graph = liveShape(data);
	const side = sideToward(graph as never, graph.segments.get('side')!, 'm', { x: 1, y: 0 })!;
	data.nodes[1].junction = { sides: { side } };
	return data;
}

const shapesOf = (d: Description, role: (r: Role) => boolean) =>
	d.surfaces
		.filter((s) => role(s.role))
		.flatMap((s) =>
			'left' in s.shape
				? [toPath([...s.shape.left, ...[...s.shape.right].reverse()])]
				: s.shape.map(toPath)
		);
// Everything drawn of the given roles, roads and nodes alike.
const drawn = (scene: Drawing, role: (r: Role) => boolean) =>
	union([
		...scene.place.roads.flatMap((r) => shapesOf(scene.road(r.id)!, role)),
		...scene.place.junctions.flatMap((j) => shapesOf(scene.node(j.id)!, role))
	]);
const asphaltOf = (scene: Drawing) => drawn(scene, (r) => r === 'lane' || r === 'paving');

// A node's connections with the side road, as text.
const sideMoves = (data: GraphData) =>
	buildModel(data)
		.derived.junctions.get('m')!
		.connections.filter((c) => c.from.road === 'side' || c.to.road === 'side')
		.map((c) => `${c.from.road}/${c.from.lane} > ${c.to.road}/${c.to.lane}`)
		.sort();

const distance = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y);
const lengthOf = (m: Marking) => m.along[m.along.length - 1] - m.along[0];

test('a two-way street ended on an avenue edge attaches to the near carriageway only, the median whole', () => {
	const data = sideRoad(preset('street'));
	// Its 7 m roadway just outside the avenue's on the east: its middle
	// 11.5 m off the avenue's line.
	const end = attachedEnd(data, 'side', 'm');
	expect(end.x).toBeCloseTo(11.5, 6);
	expect(end.y).toBeCloseTo(0, 6);

	const { scene } = buildModel(data);
	const node = scene.node('m')!;
	// No junction: nobody stops or yields, and nothing is signed.
	expect(node.approaches).toEqual([]);
	expect(node.signs).toEqual([]);
	// Every car path with the street runs to or from the northbound
	// carriageway, east of the median (which lies 1 m either side of x = 0).
	const turning = node.paths.filter(
		(p) => p.kind === 'drive' && (p.from.road === 'side' || p.to.road === 'side')
	);
	expect(turning).toHaveLength(2);
	for (const p of turning) for (const q of p.line) expect(q.x).toBeGreaterThan(4.5);
	// The median runs whole through the node, and no asphalt lies on it.
	const median = drawn(scene, (r) => r === 'median');
	const asphalt = asphaltOf(scene);
	for (let y = -60; y <= 60; y += 0.5)
		for (const x of [-0.8, 0, 0.8]) {
			expect(inside(median, { x, y }), `median at ${x}, ${y}`).toBe(true);
			expect(inside(asphalt, { x, y }), `asphalt at ${x}, ${y}`).toBe(false);
		}
	expect(check(scene)).toEqual([]);
});

test('a two-way street attached at an avenue edge has both movements with the near carriageway by default, whichever way it leans', () => {
	// Traffic turns off the northbound kerb lane into the street, and out of
	// the street into that same lane; nothing crosses the median. The street
	// leaning a hair north or south of square changes the side of the node it
	// heads off on, and nothing else.
	for (const y of [0, -0.5, 0.5, -20, 20])
		expect(sideMoves(sideRoad(preset('street'), { y })), `far end at y ${y}`).toEqual([
			'side/l1 > north/l2',
			'south/l2 > side/l2'
		]);
	// A one-way lane has its one movement, drawn toward the avenue or away
	// from it, leaning either way.
	for (const y of [-0.5, 0.5]) {
		expect(sideMoves(sideRoad(preset('lane'), { y, into: true }))).toEqual(['side/l0 > north/l2']);
		expect(sideMoves(sideRoad(preset('lane'), { y }))).toEqual(['south/l2 > side/l0']);
	}
	// A wider road's lanes all join the lane at the edge.
	expect(sideMoves(sideRoad(preset('avenue')))).toEqual([
		'side/l2 > north/l2',
		'side/l3 > north/l2',
		'south/l2 > side/l5',
		'south/l2 > side/l6'
	]);
});

test('between the two lanes of a street attached at an avenue edge the ground is ground: only the lanes are paved', () => {
	const { scene } = buildModel(sideRoad(preset('street')));
	const asphalt = asphaltOf(scene);
	const walk = drawn(scene, (r) => r === 'walk');
	const verge = drawn(scene, (r) => r === 'verge');
	// Along the street's line, between its lane turning north and its lane
	// arriving from the south: the avenue's verge and sidewalk run on through,
	// and from their outer edge (12 m) to where the two lanes come within
	// 0.6 m of each other near the street's mouth (27.25 m) nothing is drawn.
	expect(inside(verge, { x: 8.5, y: 0 })).toBe(true);
	expect(inside(walk, { x: 10.5, y: 0 })).toBe(true);
	for (let x = 12.5; x <= 22; x += 0.5)
		for (const role of [asphalt, walk, verge])
			expect(inside(role, { x, y: 0 }), `drawn at ${x}, 0`).toBe(false);
	// Both lanes are there, either side of it, and the seam between them at
	// the mouth is road.
	expect(inside(asphalt, { x: 20, y: -3 })).toBe(true);
	expect(inside(asphalt, { x: 20, y: 3 })).toBe(true);
	expect(inside(asphalt, { x: 26.5, y: 0 })).toBe(true);
});

test('the lines of a street attached at an avenue edge stay on its lanes, meet the lines either side, and its centre line runs unbroken to where the lanes part', () => {
	const { scene } = buildModel(sideRoad(preset('street')));
	const node = scene.node('m')!;
	const asphalt = asphaltOf(scene);
	const raised = drawn(scene, (r) => r !== 'lane' && r !== 'paving');
	// Every line of the node lies on asphalt, clear of verge, sidewalk and
	// median, at every point and midway between its points.
	for (const m of node.markings)
		for (const [k, q] of m.line.entries()) {
			const pts = k ? [{ x: (q.x + m.line[k - 1].x) / 2, y: (q.y + m.line[k - 1].y) / 2 }, q] : [q];
			for (const p of pts) {
				expect(inside(asphalt, p), `on asphalt at ${p.x}, ${p.y}`).toBe(true);
				expect(inside(raised, p), `off the raised ground at ${p.x}, ${p.y}`).toBe(false);
			}
		}
	// The node's line that starts or ends where a road's line ends.
	const meeting = (road: string, colour: Marking['colour'], at: Pt) => {
		const end = scene
			.road(road)!
			.markings.filter((m) => m.colour === colour && !m.dashed)
			.flatMap((m) => [m.line[0], m.line[m.line.length - 1]])
			.reduce((a, b) => (distance(b, at) < distance(a, at) ? b : a));
		expect(distance(end, at), `${road}'s line near ${at.x}, ${at.y}`).toBeLessThan(0.3);
		const found = node.markings.filter(
			(m) =>
				m.colour === colour &&
				!m.dashed &&
				Math.min(distance(m.line[0], end), distance(m.line[m.line.length - 1], end)) < 0.02
		);
		expect(found, `a ${colour} line from ${road}'s at ${at.x}, ${at.y}`).toHaveLength(1);
		return found[0];
	};
	// The street's double yellow carries on from its mouth (x = 27.25) as two
	// lines, one along each lane, each one line for as long as the lanes
	// curve apart: well past where they part.
	for (const y of [-0.2, 0.2])
		expect(lengthOf(meeting('side', 'yellow', { x: 27.25, y }))).toBeGreaterThan(8);
	// Its two white edge lines carry on along the outside of each lane to
	// the avenue's own edge line north and south (0.2 m inside its roadway's
	// edge, where the roads end 15.75 m from the node): one line from the
	// street and one from the avenue, which stop only at the crossing between
	// them, each within a stroke of it.
	const crossing = offset(union(node.crossings.flatMap((c) => c.body.map(toPath))), 0.3);
	for (const [y, road, end] of [
		[-3.3, 'north', -15.75],
		[3.3, 'south', 15.75]
	] as const) {
		const ends = [
			{ line: meeting('side', 'white', { x: 27.25, y }), at: { x: 27.25, y } },
			{ line: meeting(road, 'white', { x: 7.8, y: end }), at: { x: 7.8, y: end } }
		];
		for (const { line, at } of ends) {
			const [a, b] = [line.line[0], line.line[line.line.length - 1]];
			const far = distance(a, at) > distance(b, at) ? a : b;
			expect(inside(crossing, far), `${road}: stops at the crossing`).toBe(true);
		}
		expect(ends.reduce((sum, e) => sum + lengthOf(e.line), 0)).toBeGreaterThan(18);
	}
	// The mouth is square to the street: its two lanes end level.
	const mouth = node.outline.mouths.filter((m) => m.end === 'side:start').flatMap((m) => m.line);
	expect(mouth.length).toBeGreaterThan(1);
	for (const p of mouth) expect(p.x).toBeCloseTo(27.25, 6);
});

test('where the lanes of a road attached at an edge cut through a sidewalk it carries on as a crossing, never as paving, and never just stops', () => {
	for (const lanes of [preset('street'), preset('lane')]) {
		const { scene } = buildModel(sideRoad(lanes));
		const node = scene.node('m')!;
		const zebra = union(node.crossings.flatMap((c) => c.body.map(toPath)));
		const walk = drawn(scene, (r) => r === 'walk');
		const cars = node.paths.filter(
			(p) => p.kind === 'drive' && (p.from.road === 'side' || p.to.road === 'side')
		);
		// Each of its lanes crosses the middle of the avenue's east sidewalk,
		// 10.5 m off the avenue's line: there a crossing covers the lane and no
		// sidewalk does, and the sidewalk lies either side of it.
		for (const car of cars) {
			const k = car.line.findIndex(
				(p, i) => i > 0 && (p.x - 10.5) * (car.line[i - 1].x - 10.5) <= 0
			);
			expect(k, 'the lane crosses the sidewalk').toBeGreaterThan(0);
			const [a, b] = [car.line[k - 1], car.line[k]];
			const f = (10.5 - a.x) / (b.x - a.x || 1);
			const at = { x: 10.5, y: a.y + (b.y - a.y) * f };
			expect(inside(zebra, at), `a crossing at ${at.x}, ${at.y}`).toBe(true);
			expect(inside(walk, at), `no sidewalk at ${at.x}, ${at.y}`).toBe(false);
			for (const d of [-4.5, 4.5])
				expect(inside(walk, { x: 10.5, y: at.y + d }), `sidewalk beside it at ${d}`).toBe(true);
		}
		// Only zebra stripes: nothing of a crossing here is paved.
		expect(node.crossings.flatMap((c) => c.runs.map((r) => r.kind))).toEqual(
			node.crossings.map(() => 'zebra')
		);
		expect(node.crossings.length).toBeGreaterThan(0);
		expect(check(scene)).toEqual([]);
	}
});

test('a lane merging at a shallow angle cuts through the sidewalk inside its node, which reaches along it until it is clear of the avenue', () => {
	// Drawn toward the avenue from the south-east on a curve that comes in
	// almost alongside it: for its first 30 m or so from the node its lane
	// lies over the avenue's verge and sidewalk (8 to 12 m off its line).
	const data = sideRoad(preset('lane'), { into: true });
	Object.assign(data.nodes[3], { x: 42, y: 90 });
	Object.assign(data.segments[2], { controlX: 12, controlY: 45 });
	const { scene } = buildModel(data);
	// The lane's own road starts where all of it is past the sidewalk's outer
	// edge (within 5 cm), so no two roads' surfaces lie over each other.
	const road = scene.road('side')!;
	const mouth = road.edges.map((edge) => edge[edge.length - 1]);
	for (const p of mouth) expect(p.x).toBeGreaterThan(11.94);
	// Across the node its lane cuts the sidewalk once, under a crossing.
	const node = scene.node('m')!;
	expect(node.crossings).toHaveLength(1);
	expect(node.crossings[0].runs.map((r) => r.kind)).toEqual(['zebra']);
	expect(check(scene)).toEqual([]);
});

test('a one-way lane ended square on an avenue edge is attached at that edge, its lane carried into the avenue lane beside it', () => {
	// Drawn toward the avenue: its traffic arrives.
	const data = sideRoad(preset('lane'), { into: true });
	// Just outside the avenue's roadway on the east: its 3.5 m lane's middle
	// 1.75 m past the edge, 8 m off the avenue's line.
	const end = attachedEnd(data, 'side', 'm');
	expect(end.x).toBeCloseTo(9.75, 6);
	expect(end.y).toBeCloseTo(0, 6);

	const { scene } = buildModel(data);
	expect(sideMoves(data)).toEqual(['side/l0 > north/l2']);
	// No approach is controlled where lanes run side by side.
	expect(scene.node('m')!.approaches).toEqual([]);
	expect(check(scene)).toEqual([]);
});

test('where the road it joins ends, a two-way street takes over the edge it was ended on', () => {
	const data = sideRoad(preset('street'), { through: false });
	// Its 7 m roadway inside the avenue's east edge: its middle 4.5 m off the
	// avenue's line.
	expect(attachedEnd(data, 'side', 'm').x).toBeCloseTo(4.5, 6);
});
