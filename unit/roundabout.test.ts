import { expect, test } from 'bun:test';
import { sideToward } from '../src/lib/core/attach';
import { crossingPairs, linesOf, resolveCrossings, splitSegment } from '../src/lib/core/crossings';
import { Graph } from '../src/lib/core/graph.svelte';
import { roadAt } from '../src/lib/core/road-line';
import type { GraphData } from '../src/lib/core/types';
import {
	area,
	fromPath,
	inside,
	intersect,
	offset,
	subtract,
	toPath,
	union,
	type Paths
} from '../src/lib/road-model/clip';
import { check } from '../src/lib/road-model/checks';
import type { Surface } from '../src/lib/road-model/description';
import type { Scene as Drawing } from '../src/lib/core/networks';
import { INSET } from '../src/lib/road-model/lines';
import type { Pt } from '../src/lib/road-model/model';
import { attachedEnd, buildModel, editorDrawing, liveShape, readScene } from './model';

// A compact roundabout (e2e/scenes/roundabout.json): a ring of one 5 m
// one-way lane round a 15 m circle, traffic anticlockwise on screen, and four
// two-way approaches splitting 40 m out into an entry and an exit ramp
// attached side by side. Each ramp leaves its split along the approach and
// sweeps in to meet the ring at 25° at its own node, 36° either side of the
// approach, so an entry and the next approach's exit run as one long curve
// past the ring, and between each ramp and the ring a thin gore narrows to
// where they meet. North and east have a node on the ring facing the
// approach, between its exit and its entry; south and west have none. The
// north entry has a node of its own 9 m short of the ring; east and west
// have sidewalks.

const R = 15;
const HALF = 2.5;
const NAMES = ['n', 'e', 's', 'w'];

type Seg = GraphData['segments'][number];

// A point on a segment's quadratic as drawn, and the unit normal there
// pointing away from the ring's centre.
function along(data: GraphData, s: Seg, t: number) {
	const a = attachedEnd(data, s.id, s.startNodeId);
	const b = attachedEnd(data, s.id, s.endNodeId);
	const c =
		s.controlX === undefined
			? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
			: { x: s.controlX, y: s.controlY! };
	const u = 1 - t;
	const p = {
		x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
		y: u * u * a.y + 2 * u * t * c.y + t * t * b.y
	};
	const d = {
		x: 2 * u * (c.x - a.x) + 2 * t * (b.x - c.x),
		y: 2 * u * (c.y - a.y) + 2 * t * (b.y - c.y)
	};
	const l = Math.hypot(d.x, d.y);
	const n = { x: -d.y / l, y: d.x / l };
	const out = n.x * p.x + n.y * p.y < 0 ? { x: -n.x, y: -n.y } : n;
	return { p, out, at: (o: number) => ({ x: p.x + out.x * o, y: p.y + out.y * o }) };
}

// A segment's whole body, untrimmed, as wide as its lanes.
function body(data: GraphData, s: Seg) {
	const half = s.lanes.reduce((sum, l) => sum + l.width, 0) / 2;
	const left: Pt[] = [];
	const right: Pt[] = [];
	for (let i = 0; i <= 40; i++) {
		const q = along(data, s, i / 40);
		left.push(q.at(-half));
		right.push(q.at(half));
	}
	return toPath([...left, ...right.reverse()]);
}

const shapeOf = (s: Surface): Paths =>
	'left' in s.shape
		? [toPath([...s.shape.left, ...[...s.shape.right].reverse()])]
		: s.shape.map(toPath);

const descriptions = (scene: Drawing) => [
	...scene.place.roads.map((r) => scene.road(r.id)!),
	...scene.place.junctions.map((j) => scene.node(j.id)!)
];

// Everything drawn on the ground.
const drawn = (scene: Drawing) =>
	union(descriptions(scene).flatMap((d) => d.surfaces.flatMap(shapeOf)));

// Whether a line of `colour` passes within 15 cm of `p`.
function painted(scene: Drawing, colour: string, p: Pt) {
	return descriptions(scene).some((d) =>
		d.markings.some(
			(m) =>
				m.colour === colour &&
				m.line.some((q, i) => {
					if (i === 0) return false;
					const a = m.line[i - 1];
					const dx = q.x - a.x;
					const dy = q.y - a.y;
					const t = Math.max(
						0,
						Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))
					);
					return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y) < 0.15;
				})
		)
	);
}

// Where along the ring its edge lines are missing: on the inner edge
// anywhere (the island), on the outer edge anywhere but across a ramp's
// mouth, where just past the edge lies the ramp, or the curb rounding onto
// it (paving, where a ramp meets the ring at a shallow angle), or ground
// within half a metre of either.
function ringEdgeGaps(data: GraphData, scene: Drawing) {
	const mouths = offset(
		union([
			...data.segments.filter((s) => s.id.includes('ramp')).map((s) => body(data, s)),
			...subtract(
				drawn(scene),
				union(data.segments.filter((s) => s.id.startsWith('ring-')).map((s) => body(data, s)))
			)
		]),
		0.5
	);
	const gaps: string[] = [];
	for (const s of data.segments.filter((s) => s.id.startsWith('ring-')))
		for (let i = 0; i <= 60; i++) {
			const q = along(data, s, i / 60);
			const mouth = inside(mouths, q.at(HALF + 0.05));
			if (!mouth && !painted(scene, 'white', q.at(HALF - INSET)))
				gaps.push(`${s.id} outer at ${i}/60`);
			if (!painted(scene, 'yellow', q.at(-HALF + INSET))) gaps.push(`${s.id} inner at ${i}/60`);
		}
	return gaps;
}

// The roundabout with each ramp also attached at the ring's outer edge.
function attachedAtRing() {
	const data = readScene('roundabout');
	const live = liveShape(data);
	for (const node of data.nodes.filter((n) => /^(entry|exit)-[nesw]$/.test(n.id))) {
		const ramp = data.segments.find(
			(s) => (s.startNodeId === node.id || s.endNodeId === node.id) && s.id.includes('ramp')
		)!;
		const l = Math.hypot(node.x, node.y);
		const side = sideToward(live as never, live.segments.get(ramp.id)!, node.id, {
			x: node.x / l,
			y: node.y / l
		})!;
		node.junction = { sides: { [ramp.id]: side } };
	}
	return data;
}

test('the roundabout draws clean, with its ramps attached at the ring or not', () => {
	expect(check(buildModel(readScene('roundabout')).scene)).toEqual([]);
	expect(check(buildModel(attachedAtRing()).scene)).toEqual([]);
});

// What a junction paves beyond the ring and the ramps, as untrimmed bodies.
function beyondBodies(data: GraphData, scene: Drawing) {
	const shape = union(
		data.segments
			.filter((s) => s.id.startsWith('ring-') || s.id.includes('ramp'))
			.map((s) => body(data, s))
	);
	return scene.place.junctions
		.filter((j) => j.members.some((m) => /^(entry|exit)-[nesw]$/.test(m)))
		.flatMap((j) => subtract(union(scene.node(j.id)!.outline.rings.map(toPath)), shape));
}

test('the paving between an exit and the next entry stays within the ring and the two ramps', () => {
	const data = readScene('roundabout');
	const beyond = beyondBodies(data, buildModel(data).scene);
	for (const diagonal of [45, 135, 225, 315]) {
		// Beyond the ring and the ramps, between one approach's exit and the
		// next one's entry, lie only the curb returns where each ramp meets the
		// ring's edge, about 0.8 m² in all; a curb run straight from ramp to
		// ramp over the ring's edge paves 5 m² or more.
		const here = beyond.filter((p) => {
			const ring = fromPath(p);
			const c = ring.reduce(
				(m, q) => ({ x: m.x + q.x / ring.length, y: m.y + q.y / ring.length }),
				{
					x: 0,
					y: 0
				}
			);
			const off = (((Math.atan2(c.y, c.x) * 180) / Math.PI - diagonal + 540) % 360) - 180;
			return Math.abs(off) < 20;
		});
		const paved = here.reduce((sum, p) => sum + Math.abs(area(p)), 0);
		expect([diagonal, paved < 2]).toEqual([diagonal, true]);
	}
});

test('the gore between each approach’s ramps and the ring stays ground', () => {
	const data = readScene('roundabout');
	const { scene } = buildModel(data);
	// What the ring's junctions and the roads pave; a split's node paves the
	// narrowest of the gore between its ramps, as any node of two sides does.
	const paved = union(
		descriptions(scene)
			.filter(
				(d) =>
					!scene.place.junctions.some((j) => j.id.startsWith('split-') && scene.node(j.id) === d)
			)
			.flatMap((d) => d.surfaces.flatMap(shapeOf))
	);
	const bodies = union(
		data.segments
			.filter((s) => s.id.startsWith('ring-') || s.id.includes('ramp'))
			.map((s) => body(data, s))
	);
	const ground: string[] = [];
	// Along each approach's line out from the ring: wherever neither the ring
	// nor a ramp lies, ground.
	for (const [name, deg] of [
		['n', -90],
		['e', 0],
		['s', 90],
		['w', 180]
	] as const)
		for (let r = R + HALF + 0.1; r < 40; r += 0.25) {
			const p = { x: r * Math.cos((deg * Math.PI) / 180), y: r * Math.sin((deg * Math.PI) / 180) };
			if (!inside(bodies, p) && inside(paved, p)) ground.push(`${name} ${r.toFixed(2)} m out`);
		}
	expect(ground).toEqual([]);
});

test('each ramp is as wide as its lane up to the junction it meets', () => {
	const data = readScene('roundabout');
	const { scene } = buildModel(data);
	const off: string[] = [];
	for (const road of scene.place.roads.filter((r) => r.id.includes('ramp'))) {
		const [left, right] = scene.road(road.id)!.edges;
		left.forEach((p, k) => {
			const w = Math.hypot(right[k].x - p.x, right[k].y - p.y);
			if (Math.abs(w - 4) > 0.01) off.push(`${road.id} ${w.toFixed(2)} m at ${k}`);
		});
	}
	expect(off).toEqual([]);
});

// The roundabout with the ring's node facing the north approach taken out,
// the ring run straight on from the north exit to the north entry.
function withoutRingNode() {
	const data = readScene('roundabout');
	const a = data.nodes.find((n) => n.id === 'exit-n')!;
	const b = data.nodes.find((n) => n.id === 'entry-n')!;
	const lanes = data.segments.find((s) => s.id === 'ring-ring-n')!.lanes;
	data.nodes = data.nodes.filter((n) => n.id !== 'ring-n');
	data.segments = data.segments.filter((s) => s.id !== 'ring-ring-n' && s.id !== 'ring-exit-n');
	const span = (Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x) + 2 * Math.PI) % (2 * Math.PI);
	const mid = Math.atan2(b.y, b.x) + span / 2;
	const reach = R / Math.cos(span / 2);
	data.segments.push({
		id: 'ring-exit-n',
		startNodeId: 'exit-n',
		endNodeId: 'entry-n',
		controlX: reach * Math.cos(mid),
		controlY: reach * Math.sin(mid),
		lanes
	});
	return data;
}

test('taking a node off the ring between an exit and an entry changes nothing drawn elsewhere', () => {
	const before = buildModel(readScene('roundabout')).scene;
	const after = buildModel(withoutRingNode()).scene;
	expect(check(after)).toEqual([]);
	// Elsewhere: more than 20 m from where the node was, past the north
	// approach's own gore and ramps.
	const near = [
		toPath(
			Array.from({ length: 72 }, (_, i) => ({
				x: 20 * Math.cos((i * Math.PI) / 36),
				y: -R + 20 * Math.sin((i * Math.PI) / 36)
			}))
		)
	];
	const ground = (scene: Drawing) => subtract(drawn(scene), near);
	const moved = [
		...subtract(ground(before), ground(after)),
		...subtract(ground(after), ground(before))
	].reduce((sum, p) => sum + Math.abs(area(p)), 0);
	expect(moved).toBeLessThan(0.01);
	// Every line elsewhere is painted where it was, and nothing else is.
	const samples = (scene: Drawing) =>
		descriptions(scene).flatMap((d) =>
			d.markings.flatMap((m) =>
				m.line.filter((p) => !inside(near, p)).map((p) => ({ colour: m.colour, p }))
			)
		);
	const unmatched = (from: Drawing, to: Drawing) =>
		samples(from).filter(({ colour, p }) => !painted(to, colour, p));
	expect(unmatched(before, after)).toEqual([]);
	expect(unmatched(after, before)).toEqual([]);
});

test('a lane path through nodes merged into one follows the roads merged away between them', () => {
	// Half the ring merges into one junction; the ring's lane, chained round
	// it into each exit, keeps to the paving all the way, never cutting
	// across the island.
	const { scene } = buildModel(readScene('roundabout'));
	const paved = offset(drawn(scene), 0.05);
	const off: string[] = [];
	for (const j of scene.place.junctions.filter((j) => j.members.length > 2))
		for (const p of scene.node(j.id)!.paths)
			if (p.line.some((q) => !inside(paved, q)))
				off.push(`${p.from.road}:${p.from.end} to ${p.to.road}:${p.to.end}`);
	expect(off).toEqual([]);
});

// The roundabout with a node moved, as select mode drags one: each curved
// road it ends keeps its control point in the frame of its two nodes.
function moved(id: string, dx: number, dy: number, data = readScene('roundabout')) {
	const node = data.nodes.find((n) => n.id === id)!;
	const roads = data.segments.filter(
		(s) => s.controlX !== undefined && (s.startNodeId === id || s.endNodeId === id)
	);
	const frame = (s: Seg) => {
		const a = data.nodes.find((n) => n.id === s.startNodeId)!;
		const b = data.nodes.find((n) => n.id === s.endNodeId)!;
		return { a, d: { x: b.x - a.x, y: b.y - a.y } };
	};
	const held = roads.map((s) => {
		const { a, d } = frame(s);
		const r = { x: s.controlX! - a.x, y: s.controlY! - a.y };
		const l2 = d.x * d.x + d.y * d.y;
		return { s, u: (r.x * d.x + r.y * d.y) / l2, v: (d.x * r.y - d.y * r.x) / l2 };
	});
	node.x += dx;
	node.y += dy;
	for (const { s, u, v } of held) {
		const { a, d } = frame(s);
		s.controlX = a.x + u * d.x - v * d.y;
		s.controlY = a.y + u * d.y + v * d.x;
	}
	return data;
}

// The lane connections a junction merged from several nodes ought to have
// and lacks: every way from a kept road's lane, through the nodes' own
// connections and along the lanes of the roads merged away between them, to
// a kept road's lane, however many roads it takes.
function lostConnections(data: GraphData) {
	const { derived, scene } = buildModel(data);
	// The editor's junctions name each road end by the segment ending there;
	// the drawing names a road cut through nodes it only carries on through
	// by its first segment (Derived.units).
	const road = (id: string) => derived.units.get(id)?.[0] ?? id;
	const hidden = new Set(scene.place.hidden.map((r) => r.id));
	const key = (r: { road: string; end: string; lane: string }) =>
		`${road(r.road)}:${r.end}/${r.lane}`;
	const lost = new Set<string>();
	for (const j of scene.place.junctions.filter((j) => j.members.length > 1)) {
		const own = j.members.flatMap((m) => derived.junctions.get(m)!.connections);
		const has = new Set(j.connections.map((c) => `${key(c.from)} > ${key(c.to)}`));
		for (const c of own.filter((c) => !hidden.has(road(c.from.road)))) {
			const seen = new Set<string>();
			const todo = [c];
			for (let d = todo.pop(); d; d = todo.pop()) {
				if (!hidden.has(road(d.to.road))) {
					const k = `${key(c.from)} > ${key(d.to)}`;
					if (!has.has(k)) lost.add(k);
					continue;
				}
				const at = key({ ...d.to, end: d.to.end === 'start' ? 'end' : 'start' });
				if (seen.has(at)) continue;
				seen.add(at);
				todo.push(...own.filter((e) => key(e.from) === at));
			}
		}
	}
	return [...lost];
}

// The roundabout with every piece of its ring cut into pieces about `step`
// metres long, as the split tool cuts them.
function ringCut(step: number) {
	const graph = new Graph();
	graph.fromJSON(readScene('roundabout'));
	for (const ring of [...graph.segments.values()].filter((s) => s.id.startsWith('ring-'))) {
		let segment = ring;
		for (;;) {
			const at = (t: number) => roadAt(graph, segment, t)!.line;
			let length = 0;
			for (let i = 1; i <= 50; i++) {
				const [p, q] = [at((i - 1) / 50), at(i / 50)];
				length += Math.hypot(q.x - p.x, q.y - p.y);
			}
			if (length <= step * 1.5) break;
			const node = graph.createNode(at(step / length).x, at(step / length).y);
			segment = splitSegment(graph, segment, step / length, node.id)!.right;
		}
	}
	return graph.toJSON();
}

test('nodes merged into one keep every lane connection there is through the roads between them', () => {
	expect(lostConnections(readScene('roundabout'))).toEqual([]);
	// The ring in 2 m pieces: each piece of it carries on into the next, so
	// it is drawn as before, one road from node to node (core/place.ts).
	const cut = ringCut(2);
	expect(cut.nodes.length).toBeGreaterThan(50);
	expect(lostConnections(cut)).toEqual([]);
	// The same pieces as roads drawn on their own, their lanes named apart:
	// its merged junctions chain the ring's lane through a dozen roads merged
	// away and more.
	for (const s of cut.segments)
		if (!s.id.includes('ramp')) s.lanes = s.lanes.map((l) => ({ ...l, id: `${s.id}/${l.id}` }));
	expect(lostConnections(cut)).toEqual([]);
});

test('a ramp dragged to pass within a few metres of a ring node, clear of it and its roads, is left unjoined', () => {
	// The north exit's ring end moved 5 m in: the exit ramp passes 5 m from
	// ring-n, its edge 0.8 m clear of the ring's, and crosses none of its
	// roads.
	const graph = new Graph();
	graph.fromJSON(moved('exit-n', 0, 5));
	expect(resolveCrossings(graph, graph.nodes.get('exit-n')!.connectedSegments)).toBe(false);
});

test('a bend between two short roads, each ending at a junction, gets room to turn and its roads don’t lap', () => {
	// The east ring node moved 5 m in bends the ring there by about 60° on
	// two 9 m pieces, each running into the merged junction of an entry and
	// an exit.
	const data = moved('ring-e', -5, 0);
	const { derived, scene } = buildModel(data);
	expect(derived.junctions.get('ring-e')!.link).toBeDefined();
	const trim = (id: string, end: 'start' | 'end') => {
		const span = derived.spans.get(id)!;
		return end === 'start' ? span.d0 : span.total - span.d0 - span.length;
	};
	// A bend of the ring's 5 m lane through 60° turns on a radius of 3.75 m
	// (TAPER.BEND_RADIUS), 2.2 m each side of the node.
	expect(trim('ring-ring-e', 'start')).toBeGreaterThan(2.1);
	expect(trim('ring-exit-e', 'end')).toBeGreaterThan(2.1);
	expect(check(scene)).toEqual([]);
});

test('a ramp swung into its sibling leaves the split clear of it, the split taking what the ring’s junction would leave for paint', () => {
	// Each ramp's ring end moved 5 m toward the other ramp of its split: the
	// two run side by side for 20 m and more from the split, longer than the
	// ring's junction leaves them, and the split node reaches along them
	// until they are apart.
	for (const [id, dx, dy] of [
		['entry-e', 0, 5],
		['exit-e', 0, -5],
		['exit-n', -5, 0],
		['entry-mid-n', 5, 0]
	] as const)
		expect([id, check(buildModel(moved(id, dx, dy)).scene)]).toEqual([id, []]);
});

test('an entry cut by a node keeps its arrow, behind where it gives way', () => {
	// The east split 3 m north and the ring's north node 2 m out leave the
	// north entry's first piece, up to its node 9 m short of the ring, too
	// short for an arrow of its own; the entry as a whole has room.
	const data = moved('ring-n', 0, -2, moved('split-e', 0, -3));
	const { scene } = buildModel(data);
	const j = scene.place.junctions.find((j) => j.members.includes('entry-n'))!;
	const signs = scene.node(j.id)!.signs;
	const giveWay = signs.find(
		(s) => s.kind === 'yield' && s.lanes[0].road.startsWith('entry-ramp-n')
	);
	const arrow = signs.find((s) => s.kind === 'arrow' && s.lane.road.startsWith('entry-ramp-n'));
	expect(giveWay && arrow).toBeDefined();
	if (giveWay?.kind !== 'yield' || arrow?.kind !== 'arrow') return;
	const mid = { x: (giveWay.a.x + giveWay.b.x) / 2, y: (giveWay.a.y + giveWay.b.y) / 2 };
	// Its tail at least 6 m behind the teeth, as on any approach (its own
	// road's paint stops behind them).
	expect(Math.hypot(arrow.at.x - mid.x, arrow.at.y - mid.y)).toBeGreaterThan(6);
});

test('the ring’s edge lines run on past every ramp, broken only across its mouth', () => {
	const data = readScene('roundabout');
	expect(ringEdgeGaps(data, buildModel(data).scene)).toEqual([]);
});

test('every entry yields where it meets the ring, with its line and arrow, cut short of it or not', () => {
	const data = readScene('roundabout');
	const { scene } = buildModel(data);
	for (const name of NAMES) {
		const j = scene.place.junctions.find((j) => j.members.includes(`entry-${name}`))!;
		const signs = scene.node(j.id)!.signs;
		const entry = (road: string) => road.startsWith(`entry-ramp-${name}`);
		expect([
			name,
			signs.some((s) => s.kind === 'yield' && s.lanes.every((l) => entry(l.road)))
		]).toEqual([name, true]);
		expect([name, signs.some((s) => s.kind === 'arrow' && entry(s.lane.road))]).toEqual([
			name,
			true
		]);
	}
	// The north entry, cut in two at entry-mid-n near the ring, only carries
	// on through it: one road (core/place.ts), named by its first piece, with
	// no node there, giving way where it meets the ring; a stop set by hand
	// at the ring on its last piece stays.
	expect(scene.place.junctions.some((j) => j.members.includes('entry-mid-n'))).toBe(false);
	const north = scene.place.junctions.find((j) => j.members.includes('entry-n'))!;
	const northYield = scene
		.node(north.id)!
		.signs.find(
			(s) => s.kind === 'yield' && s.lanes.some((l) => l.road.startsWith('entry-ramp-n'))
		);
	expect(northYield?.kind === 'yield' && northYield.lanes.map((l) => l.road)).toEqual([
		'entry-ramp-n-a'
	]);
	const ring = data.nodes.find((n) => n.id === 'entry-n')!;
	ring.junction = { control: { 'entry-ramp-n-b:end': 'stop' } };
	const stopped = buildModel(data).scene;
	const j = stopped.place.junctions.find((j) => j.members.includes('entry-n'))!;
	expect(j.control['entry-ramp-n-a:end']).toBe('stop');
	expect(stopped.node(j.id)!.signs.some((s) => s.kind === 'stop')).toBe(true);
});

test('with the east split dragged 3 m north and the ring’s north node 2 m out, it still draws clean, every entry yielding, nothing laid across', () => {
	// Every entry ramp that yields at a junction of the ring, by approach.
	const yielding = (data: GraphData) =>
		buildModel(data)
			.scene.place.junctions.flatMap((j) =>
				Object.entries(j.control)
					.filter(([end, c]) => c === 'yield' && end.startsWith('entry-ramp-'))
					.map(([end]) => end.split(':')[0].replace(/-[ab]$/, ''))
			)
			.sort();
	const entries = NAMES.map((n) => `entry-ramp-${n}`).sort();
	const before = readScene('roundabout');
	const after = moved('ring-n', 0, -2, moved('split-e', 0, -3));
	expect(yielding(before)).toEqual(entries);
	expect(yielding(after)).toEqual(entries);
	expect(check(buildModel(after).scene)).toEqual([]);
	// The move lays no road across another it did not cross before.
	const graph = (data: GraphData) => {
		const g = new Graph();
		g.fromJSON(data);
		return g;
	};
	const roads = after.segments
		.filter((s) => ['split-e', 'ring-n'].some((n) => s.startNodeId === n || s.endNodeId === n))
		.map((s) => s.id);
	const then = crossingPairs(linesOf(graph(before)), roads);
	expect([...crossingPairs(linesOf(graph(after)), roads)].filter((k) => !then.has(k))).toEqual([]);
});

test('an entry swung along the ring past where its junction merges with the next exit’s paves smoothly', () => {
	// entry-w moved round the ring a twentieth of a degree at a time (1.3 cm),
	// its two ring roads kept on the circle, and what is drawn within 15 m
	// of where the ring meets the south-west gore measured.
	const data = readScene('roundabout');
	const near = [
		toPath(
			Array.from({ length: 72 }, (_, i) => ({
				x: R * Math.cos((3 * Math.PI) / 4) + 15 * Math.cos((i * Math.PI) / 36),
				y: R * Math.sin((3 * Math.PI) / 4) + 15 * Math.sin((i * Math.PI) / 36)
			}))
		)
	];
	const graph = liveShape(data);
	const draw = editorDrawing();
	const node = graph.nodes.get('entry-w')!;
	const ringRoads = [...graph.segments.values()].filter(
		(s) => s.id.startsWith('ring-') && (s.startNodeId === node.id || s.endNodeId === node.id)
	);
	const steps: { merged: boolean; paved: number }[] = [];
	for (let deg = 147; deg <= 150; deg += 0.05) {
		node.x = R * Math.cos((deg * Math.PI) / 180);
		node.y = R * Math.sin((deg * Math.PI) / 180);
		for (const s of ringRoads) {
			const a = graph.nodes.get(s.startNodeId)!;
			const b = graph.nodes.get(s.endNodeId)!;
			const span = (Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x) + 2 * Math.PI) % (2 * Math.PI);
			const mid = Math.atan2(b.y, b.x) + span / 2;
			[s.controlX, s.controlY] = [
				(R / Math.cos(span / 2)) * Math.cos(mid),
				(R / Math.cos(span / 2)) * Math.sin(mid)
			];
		}
		const scene = draw(graph);
		const j = scene.place.junctions.find((j) => j.members.includes('entry-w'))!;
		steps.push({
			merged: j.members.length > 1,
			paved: intersect(drawn(scene), near).reduce((sum, p) => sum + area(p), 0)
		});
	}
	// It merges part way.
	expect(steps[0].merged).toBe(true);
	expect(steps.at(-1)!.merged).toBe(false);
	// Each step changes what is paved by a few hundredths of a square metre;
	// none jumps where the two junctions merge.
	const jumps = steps.slice(1).map((s, i) => Math.abs(s.paved - steps[i].paved));
	expect(Math.max(...jumps)).toBeLessThan(0.1);
});

test('every entry gives way at the ring’s edge, its setback read along the curving ramp', () => {
	// Each ramp meets the ring at 25° and curves in tangent to it: read along
	// the two as drawn, the ring's junction takes about 6 m of it, not the
	// 9.9 m two straight lines at that angle would need, and the give-way
	// line stands within 2 m of the ring's outer edge.
	const { scene } = buildModel(readScene('roundabout'));
	for (const name of NAMES) {
		const j = scene.place.junctions.find((j) => j.members.includes(`entry-${name}`))!;
		const line = scene
			.node(j.id)!
			.signs.find(
				(s) => s.kind === 'yield' && s.lanes.every((l) => l.road.startsWith(`entry-ramp-${name}`))
			);
		expect([name, line?.kind]).toEqual([name, 'yield']);
		if (line?.kind !== 'yield') continue;
		const out = Math.min(Math.hypot(line.a.x, line.a.y), Math.hypot(line.b.x, line.b.y)) - R - HALF;
		expect([name, out < 2]).toEqual([name, true]);
	}
	// Nudged as the jitter run nudges them, the smaller merges this leaves
	// at the ring's gore tips draw clean.
	for (const [id, dx, dy] of [
		['entry-e', -5, 0],
		['entry-e', 0, -0.5],
		['entry-mid-n', 0, 5],
		['ring-n', 0, -5]
	] as const)
		expect([id, dx, dy, check(buildModel(moved(id, dx, dy)).scene)]).toEqual([id, dx, dy, []]);
});

test('with the ramps attached at the ring’s edge, each pair of ring nodes merges as a node of two sides and keeps its lines', () => {
	const data = attachedAtRing();
	const { scene } = buildModel(data);
	for (const name of NAMES) {
		const j = scene.place.junctions.find((j) => j.members.includes(`entry-${name}`))!;
		expect(j.members).toHaveLength(2);
		expect(j.link).toBeDefined();
		// The ring's inner edge and its outer one, the ramps' too.
		const colours = new Set(scene.node(j.id)!.markings.map((m) => m.colour));
		expect([j.id, [...colours].sort()]).toEqual([j.id, ['white', 'yellow']]);
	}
});
