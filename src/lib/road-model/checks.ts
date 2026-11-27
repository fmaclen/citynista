// Geometry rules every built place must satisfy, read off its descriptions
// (description.ts). Used by the unit tests and the jitter test
// (unit/jitter.ts).

import { layerOf, paintOf, signShapes } from '../rendering/road-meshes';
import {
	area,
	close,
	fromPath,
	inside,
	intersect,
	offset,
	piecesOf,
	subtract,
	toPath,
	union,
	type Path,
	type Paths
} from './clip';
import type {
	Description,
	LanePath,
	Ribbon,
	RoadDescription,
	Ring,
	Sign,
	Surface
} from './description';
import {
	crossesItself,
	dot,
	folded,
	frameAt,
	hullOf,
	offsetPoint,
	project,
	sampled,
	segmentsCross,
	signedArea
} from './geometry';
import { ARROW_ROOM, STOP_ROOM } from './approach';
import { INSET } from './lines';
import { LINE } from './paint';
import type { EndInfo } from './ends';
import { endKey, isRoadway, isWalk, laneKey, type Pt } from './model';
import type { Scene } from '../core/networks';
import { boxOf, overlap, shapeOf } from './overlay';

const sum = (paths: Paths) => paths.reduce((s, p) => s + area(p), 0);
const TOL = 0.05;
// A junction's corner sidewalks, verges and crossing paving are drawn a
// centimetre wider all round (LAP in node.ts), allowed for in each margin
// below, so the rules measure what was drawn.
const GROWN = 0.01;
// How far each of two surfaces is shrunk before the ground both cover is
// measured (one owner per ground, m): the centimetre a junction's corners
// are drawn wider by and 2 cm more, or between two footpath pieces half a
// centimetre.
const SHRUNK = 0.02 + GROWN;
const FOOT_SHRUNK = 0.005;

export function check(scene: Scene): string[] {
	const out: string[] = [];
	const roads = scene.place.roads.map((r) => ({ id: r.id, d: scene.road(r.id)! }));
	const nodes = scene.place.junctions.map((j) => ({ id: j.id, d: scene.node(j.id)! }));
	const pieces: { id: string; d: Description }[] = [...roads, ...nodes];

	// A ribbon's outline (shapeOf) covers what its quads do: none is turned
	// over.
	const pick = (keep: (s: Surface) => boolean) =>
		union(pieces.flatMap(({ d }) => d.surfaces.filter(keep).flatMap(shapeOf)));
	// Where paint may go: lanes and the paving between them.
	const surface = pick((s) => s.role === 'lane' || s.role === 'paving');
	const raised = pick(
		(s) => (s.role === 'verge' || s.role === 'median') && s.material !== 'asphalt'
	);
	const pavement = pick((s) => s.role === 'walk');
	// Sidewalk laid across a road or a mouth: paint mustn't sit on it either.
	const paving = union(
		pieces.flatMap(({ d }) =>
			d.crossings.flatMap((c) =>
				c.runs.filter((r) => r.kind !== 'zebra').flatMap((r) => r.rings.map(toPath))
			)
		)
	);

	// Paint stays on asphalt: inside roads and outlines, never on grass,
	// concrete or sidewalk. Hatch bars count as paint.
	const paint: Paths = pieces.flatMap(({ d }) => [
		...paintOf(d).flatMap((p) => p.rings.map(toPath)),
		...d.surfaces.flatMap((s) => (s.bars?.rings ?? []).map(toPath))
	]);
	const lines = union(paint);
	const off = sum(subtract(lines, offset(surface, 0.02 - GROWN)));
	if (off > TOL) out.push(`paint outside the roads and outlines: ${off.toFixed(2)} m²`);
	const onRaised = sum(intersect(lines, offset(raised, -0.02 - GROWN)));
	if (onRaised > TOL) out.push(`paint on grass or concrete: ${onRaised.toFixed(2)} m²`);
	const onWalk = sum(intersect(lines, offset(union([...pavement, ...paving]), -0.02 - GROWN)));
	if (onWalk > TOL) out.push(`paint on sidewalk: ${onWalk.toFixed(2)} m²`);

	// Hatching stays off a node's car paths: each path's band, as wide as its
	// widths, shrunk so a bar ending on its edge doesn't count.
	for (const { id, d } of nodes) {
		const bars = d.surfaces.flatMap((s) => (s.bars?.rings ?? []).map(toPath));
		if (!bars.length) continue;
		const cars = d.paths.filter((p) => p.kind === 'drive').map(bandOf);
		const on = sum(intersect(union(bars), offset(union(cars), -0.02 - GROWN)));
		if (on > TOL) out.push(`hatch bars on a car path: ${id} ${on.toFixed(2)} m²`);
	}

	// Sidewalk never lies over car lanes or a node's paving: neither a
	// sidewalk's own surface nor the paving of a crossing (a refuge, a
	// footpath's run up to a street). Over car lanes a walkway is a crossing,
	// drawn as zebra stripes.
	const walkOver = sum(
		intersect(offset(union([...pavement, ...paving]), -0.02 - 2 * GROWN), surface)
	);
	if (walkOver > TOL) out.push(`sidewalk over asphalt: ${walkOver.toFixed(2)} m²`);

	// Wherever car lanes cross the line of a sidewalk that carries on across
	// a node, a crossing covers them: no point of a walking path there lies
	// on a car path outside every crossing. Read every quarter metre along
	// the path, against each car path's ground shrunk so a path only touching
	// its edge doesn't count.
	const bodies = union(pieces.flatMap(({ d }) => d.crossings.flatMap((c) => c.body.map(toPath))));
	for (const { id, d } of nodes) {
		const walks = d.paths.filter((p) => p.kind === 'walk');
		const cars = d.paths.filter((p) => p.kind === 'drive').map(bandOf);
		if (!walks.length || !cars.length) continue;
		const driven = offset(union(cars), -TOL);
		const crossed = offset(bodies, TOL);
		const bare = walks
			.flatMap((p) => sampled(p.line, 0.25))
			.find((q) => inside(driven, q) && !inside(crossed, q));
		if (bare)
			out.push(
				`car lanes across a sidewalk with no crossing: ${id} (${bare.x.toFixed(1)}, ${bare.y.toFixed(1)})`
			);
	}

	// Lines never cross each other.
	const marks = pieces.flatMap(({ id, d }) => d.markings.map((m) => ({ m, who: id })));
	// Lines whose boxes are apart can't cross; on a whole city that skips
	// nearly every pair.
	const boxes = marks.map(({ m }) => ({
		x0: Math.min(...m.line.map((p) => p.x)),
		x1: Math.max(...m.line.map((p) => p.x)),
		y0: Math.min(...m.line.map((p) => p.y)),
		y1: Math.max(...m.line.map((p) => p.y))
	}));
	for (let i = 0; i < marks.length; i++) {
		for (let k = i + 1; k < marks.length; k++) {
			const [u, v] = [boxes[i], boxes[k]];
			if (u.x1 < v.x0 || v.x1 < u.x0 || u.y1 < v.y0 || v.y1 < u.y0) continue;
			const p = marks[i].m.line;
			const q = marks[k].m.line;
			let hit = false;
			for (let a = 1; a < p.length && !hit; a++) {
				for (let b = 1; b < q.length && !hit; b++) {
					if (segmentsCross(p[a - 1], p[a], q[b - 1], q[b])) hit = true;
				}
			}
			if (hit) out.push(`lines cross: ${marks[i].who} and ${marks[k].who}`);
		}
	}

	// No hole between a road and its node: just inside the node and just
	// inside the road, all across the roadway, there is surface (a sidewalk
	// between two carriageways is surface too).
	const covered = union([...surface, ...raised, ...pavement]);
	for (const { id, d } of nodes) {
		for (const m of d.outline.mouths) {
			for (let k = 1; k < m.line.length; k++) {
				const a = m.line[k - 1];
				const b = m.line[k];
				// Steps along a carriageway's side run along the road: skip them.
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				if (Math.abs(dx * m.out.x + dy * m.out.y) > 0.5 * Math.hypot(dx, dy)) continue;
				for (let f = 0.1; f <= 0.91; f += 0.2) {
					const p = { x: a.x + dx * f, y: a.y + dy * f };
					for (const s of [-0.3, 0.3]) {
						const q = offsetPoint(p, m.out, s);
						if (!inside(covered, q))
							out.push(`hole at ${id} ${m.end} (${q.x.toFixed(1)}, ${q.y.toFixed(1)})`);
					}
				}
			}
		}
	}

	// No seam between a road and its node: each of the road's lane edges that
	// ends on the node's mouth, on the edge of the node's ground, ends on one
	// of the node's own points (of its paving or a band), the same numbers,
	// so nothing can open between them. (Where two road ends lap, a corner of
	// one can lie past the other's mouth, off the node's ground: no seam.)
	for (const { id, d } of nodes) {
		const own = new Set(
			d.surfaces
				.flatMap((s) => ('left' in s.shape ? [...s.shape.left, ...s.shape.right] : s.shape.flat()))
				.map((p) => `${p.x},${p.y}`)
		);
		const edges = d.surfaces.flatMap((s) =>
			'left' in s.shape
				? [s.shape.left, s.shape.right, [s.shape.left[0], s.shape.right[0]]]
				: s.shape.map((ring) => [...ring, ring[0]])
		);
		const onEdge = (p: Pt) => edges.some((line) => offLine(p, line) < 0.002);
		for (const m of d.outline.mouths) {
			const end = d.ends.find((e) => e.key === m.end);
			const road = end && scene.road(end.ref.road);
			if (!end || !road) continue;
			const k = end.ref.end === 'start' ? 0 : road.along.length - 1;
			for (const p of road.edges.map((edge) => edge[k]))
				if (offLine(p, m.line) < 0.05 && onEdge(p) && !own.has(`${p.x},${p.y}`))
					out.push(`seam open: ${id} ${m.end} (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
		}
	}

	// No crack: closing the ground drawn round a node (its surfaces and
	// crossings, and its roads', within a metre of it) by CRACK adds no long
	// thin sliver. A seam
	// a centimetre wide is too thin for the raster comparison to see. What
	// closing adds within 2 mm of the ground (clipper's grid) doesn't count,
	// nor a fillet in a corner or the tip of a narrow wedge of ground: a
	// sliver counts once it is half a metre long and at most 3 cm wide on
	// average.
	for (const { id, d } of nodes) {
		const near = [
			...d.surfaces.flatMap(shapeOf),
			...d.crossings.flatMap((c) => c.runs.flatMap((run) => run.rings.map(toPath)))
		];
		if (!near.length) continue;
		const pts = near.flatMap(fromPath);
		const box = (grow: number) => [
			toPath([
				{ x: Math.min(...pts.map((p) => p.x)) - grow, y: Math.min(...pts.map((p) => p.y)) - grow },
				{ x: Math.max(...pts.map((p) => p.x)) + grow, y: Math.min(...pts.map((p) => p.y)) - grow },
				{ x: Math.max(...pts.map((p) => p.x)) + grow, y: Math.max(...pts.map((p) => p.y)) + grow },
				{ x: Math.min(...pts.map((p) => p.x)) - grow, y: Math.max(...pts.map((p) => p.y)) + grow }
			])
		];
		const roadsHere = d.ends.flatMap((e) => {
			const road = scene.road(e.ref.road);
			if (!road) return [];
			return [
				...road.surfaces.flatMap(shapeOf),
				...road.crossings.flatMap((c) => c.runs.flatMap((run) => run.rings.map(toPath)))
			];
		});
		const ground = intersect(union([...near, ...roadsHere]), box(1));
		const filled = subtract(intersect(close(ground, CRACK), box(0.9)), offset(ground, 0.002));
		for (const ring of filled) {
			const pts = fromPath(ring);
			const half = perimeter(ring) / 2;
			if (half >= 0.5 && Math.abs(area(ring)) / half <= 0.03)
				out.push(
					`crack at ${id} (${pts[0].x.toFixed(1)}, ${pts[0].y.toFixed(1)}) ${half.toFixed(1)} m long`
				);
		}
	}

	// No crack inside a node's curb outline, however wide: all of it is
	// covered by the node's surfaces and crossings and its roads' (a road's
	// end and the paving lap; bands and paving share their edges). Ground
	// meant to show (a gore beyond the curbs, between a footpath and a
	// street) lies outside the outline. A piece left bare counts once it is
	// half a metre long and 3 mm wide on average: narrower is the tip of a
	// wedge of paving that SLIVER's opening (node.ts) trims off, and a
	// gap that narrow at a road's end is the seam rule's.
	for (const { id, d } of nodes) {
		if (!d.outline.rings.length) continue;
		const roads = d.ends.flatMap((e) => scene.road(e.ref.road) ?? []);
		const ground = union(
			[d, ...roads].flatMap((x) => [
				...x.surfaces.flatMap(shapeOf),
				...x.crossings.flatMap((c) => c.runs.flatMap((run) => run.rings.map(toPath)))
			])
		);
		const bare = subtract(d.outline.rings.map(toPath), ground);
		for (const ring of bare) {
			if (area(ring) <= 0) continue;
			// Less the holes in it: a hairline all round a piece that is covered
			// comes as that piece's outline with the piece as a hole.
			const a = bare
				.filter((hole) => area(hole) < 0 && inside([ring], fromPath(hole)[0]))
				.reduce((left, hole) => left + area(hole), area(ring));
			const half = perimeter(ring) / 2;
			if (half >= 0.5 && a / half >= 0.003) {
				const p = fromPath(ring)[0];
				out.push(
					`crack inside ${id} (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) ${half.toFixed(1)} m long`
				);
			}
		}
	}

	// No ground between footpaths meeting: a junction whose roads all have
	// walks and none a roadway has no curb outline for the rules above to
	// read, so what must be covered is the ground between its road ends: the
	// polygon through the middle of each end's cross-section, taken round
	// their centre in turn, is covered by the node's ground and its roads'.
	for (const { id, d } of nodes) {
		if (d.ends.length < 3 || !d.ends.every(footpathEnd)) continue;
		const middles = d.ends.map((e) =>
			offsetPoint(
				e.frame.p,
				e.frame.n,
				(Math.min(...e.lanes.map((l) => l.left)) + Math.max(...e.lanes.map((l) => l.right))) / 2
			)
		);
		const c = {
			x: middles.reduce((s, p) => s + p.x, 0) / middles.length,
			y: middles.reduce((s, p) => s + p.y, 0) / middles.length
		};
		const ring = middles.sort(
			(p, q) => Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(q.y - c.y, q.x - c.x)
		);
		const roads = d.ends.flatMap((e) => scene.road(e.ref.road) ?? []);
		const ground = union([d, ...roads].flatMap((x) => x.surfaces.flatMap(shapeOf)));
		const bare = sum(subtract(union([toPath(ring)]), ground));
		if (bare > TOL) out.push(`ground between footpaths at ${id}: ${bare.toFixed(2)} m²`);
	}

	// No spikes in the sidewalk: no outer corner sharper than SPIKE, measured
	// over a short stretch either side so curve facets don't count. A spike
	// is a point of paving running out thin into what lies round it. A sharp
	// notch cut into the sidewalk is the opposite, open ground running into
	// paving, and is no spike whether it opens on the sidewalk's edge or lies
	// closed inside it as a hole (spike, below): it has the same shape in
	// both cases, so the rule treats them the same. Where such open ground is
	// a fault it is the fault of whatever left it open: a thin wedge between
	// pieces is a crack (above), and asphalt over the sidewalk is drawn
	// there on purpose.
	// Slivers and slits under 8 cm wide, where two pieces of sidewalk meet
	// edge to edge, are closed and opened away first, so the pieces either
	// side of a slit don't count as spikes: a slit is open ground, not a
	// point of paving, and only a crack (above) is looked for there.
	// Only what shows: asphalt is drawn over the sidewalk. A sidewalk that
	// carries on as a crossing ends on the edge of the lane cutting through
	// it, at whatever slant the lane does: its corner on the crossing's edge
	// is no spike.
	const walks = subtract(union([...pavement, ...paving]), surface);
	const beside = offset(bodies, 0.1);
	for (const ring of offset(offset(offset(walks, 0.04), -0.08), 0.04)) {
		// A speck too small to see isn't a spike.
		if (Math.abs(area(ring)) < 0.05) continue;
		const tip = spike(ring, (p) => !inside(beside, p));
		if (tip) out.push(`sidewalk spike at (${tip.x.toFixed(1)}, ${tip.y.toFixed(1)})`);
	}

	// A crossing across a road is one piece with no holes.
	for (const { id, d } of roads) {
		d.crossings.forEach((c, k) => {
			const rings = union(c.body.map(toPath));
			if (rings.length === 0) return;
			const sign = Math.sign(
				area(rings.reduce((a, b) => (Math.abs(area(b)) > Math.abs(area(a)) ? b : a)))
			);
			const holes = rings.filter((r) => Math.sign(area(r)) !== sign && Math.abs(area(r)) > 0.05);
			const pieces = rings.filter((r) => Math.sign(area(r)) === sign && Math.abs(area(r)) > 0.05);
			if (holes.length) out.push(`crossing with a hole: ${id} #${k}`);
			if (pieces.length > 1) out.push(`crossing split: ${id} #${k}`);
		});
	}

	// Lane lines end where paint stops at a road end (a stop line, a crossing
	// or the outline), never out in the middle of the asphalt: within
	// LINE_END of the cut at either end, or of a crossing's body or the
	// ground cleared for a line traffic meets one at (holds.ts) where they
	// lie, so a line beside a crossing of the other carriageway, as far
	// along the road as it but not on it, ends mid-road.
	for (const { id, d } of roads) {
		const length = d.path.length;
		const near = (s: number) =>
			s <= d.cut.start.paint + LINE_END || s >= length - d.cut.end.paint - LINE_END;
		const held = offset(
			union([...d.crossings.flatMap((c) => c.body), ...(d.cleared ?? [])].map(toPath)),
			LINE_END
		);
		const crossed = (p: Pt) => inside(held, p);
		for (const m of d.markings) {
			// A line closed round a median with a nose at either end has none.
			const [first, last] = [m.line[0], m.line[m.line.length - 1]];
			if (first && Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) continue;
			for (const k of [0, m.line.length - 1]) {
				const p = m.line[k];
				if (!p) continue;
				const s = m.along[k];
				if (!near(s) && !crossed(p))
					out.push(
						`line ends mid-road: ${id} at ${s.toFixed(1)} m (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`
					);
			}
		}
	}

	// Every approach that takes arrows (where traffic stops, or a lane can't
	// go straight on) has one on each lane that takes one, wherever its own
	// road has room for them behind where its paint stops and any crossing
	// over it there. One left out for want of that room isn't reported.
	const drawnRoads = new Map(roads.map((r) => [r.id, r.d]));
	for (const { id, d } of nodes)
		for (const a of d.approaches) {
			if (!a.arrows) continue;
			const drawn = d.signs.filter((s) => s.kind === 'arrow' && endKey(s.lane) === a.end);
			if (drawn.length >= a.arrows) continue;
			const at = a.end.lastIndexOf(':');
			const road = drawnRoads.get(a.end.slice(0, at));
			if (!road) continue;
			const end = a.end.slice(at + 1) === 'start' ? 'start' : 'end';
			const length = road.path.length;
			const back = (s: number) => (end === 'start' ? s : length - s);
			// How far back from the end its crossings reach, those near it, and
			// the ground cleared behind the lines held traffic meets them at.
			let reach = road.cut[end].paint;
			for (const ring of [...road.crossings.flatMap((c) => c.body), ...(road.cleared ?? [])]) {
				const along = ring.map((q) => back(project(road.path, q).s));
				const crossing = !road.cleared?.includes(ring);
				if (along.length && Math.min(...along) < reach + ARROW_ROOM)
					reach = Math.max(reach, Math.max(...along) + (crossing ? STOP_ROOM : 0));
			}
			if (length >= reach + ARROW_ROOM)
				out.push(`arrows left out: ${id} ${a.end} (${drawn.length} of ${a.arrows})`);
		}

	// A stop line or row of give-way teeth is paint: one described with
	// none (a row too short for a tooth) is no line.
	for (const { id, d } of pieces)
		for (const s of d.signs)
			if ((s.kind === 'stop' || s.kind === 'yield') && sum(signShapes(s).map(toPath)) < 0.01)
				out.push(`${s.kind} line with no paint: ${id}`);

	// No marking of an approach lies on another of its own, nor on a
	// crossing (anywhere on its ground, between its stripes too): its arrows,
	// its line and any crossing over it each have ground of their own
	// (arrows, then one line, then the crossing, in driving order). An
	// approach is the lanes heading to one road end, whoever draws its
	// markings, the road or the node it heads to. Each is shrunk by a
	// centimetre first, so markings only touching don't count.
	const stripes = union(
		pieces.flatMap(({ d }) =>
			d.crossings.flatMap((c) => c.runs.flatMap((r) => r.rings.map(toPath)))
		)
	);
	const onCrossings = union([...stripes, ...bodies]);
	const signed = pieces.flatMap(({ id, d }) =>
		d.signs.flatMap((s) => {
			if (s.kind === 'end') return [];
			const ref = s.kind === 'arrow' ? s.lane : s.lanes[0];
			const shape = offset(union(signShapes(s).map(toPath)), -0.01);
			const pts = shape.flatMap(fromPath);
			if (!ref || !pts.length) return [];
			return [{ id, kind: s.kind, way: endKey(ref), shape, box: boxOf(pts) }];
		})
	);
	for (const s of signed) {
		const on = sum(intersect(s.shape, onCrossings));
		if (on > TOL) out.push(`${s.kind} on a crossing: ${s.id} ${s.way} ${on.toFixed(2)} m²`);
	}
	// Nor does any other paint: no lane or edge line and no hatching lies on
	// a crossing's ground (its body), wherever it is drawn. Each is shrunk by
	// a centimetre first, so paint only touching doesn't count.
	const crossingBodies = offset(bodies, -0.01);
	const bodyBox = boxOf(crossingBodies.flatMap(fromPath));
	for (const { id, d } of pieces) {
		if (!crossingBodies.length) break;
		const own = [
			...paintOf({ ...d, signs: [] }).flatMap((p) => p.rings),
			...d.surfaces.flatMap((s) => s.bars?.rings ?? [])
		].filter((r) => overlap(boxOf(r), bodyBox));
		if (!own.length) continue;
		const on = sum(intersect(union(own.map(toPath)), crossingBodies));
		if (on > TOL) out.push(`paint on a crossing: ${id} ${on.toFixed(2)} m²`);
	}
	for (let i = 0; i < signed.length; i++)
		for (let k = i + 1; k < signed.length; k++) {
			const [u, v] = [signed[i], signed[k]];
			if (u.way !== v.way || !overlap(u.box, v.box)) continue;
			const both = sum(intersect(u.shape, v.shape));
			if (both > TOL)
				out.push(`markings overlap: ${u.kind} and ${v.kind} on ${u.way} ${both.toFixed(2)} m²`);
		}

	// One line per lane for one crossing, and no stub of lane line between
	// them: looking from a stop line or row of give-way teeth the way its
	// traffic drives, straight on from each point along it, the first
	// crossing within SIGN_REACH is the one it stands for. Whichever pieces
	// draw them (a road, the node at its end), no other line for traffic
	// heading that way lies between it and that crossing, and no lane line
	// ends there, its lanes' edges included (the lines stop from the sign up
	// to the crossing; a median's nose comes forward past a stop line, the
	// lines round it running on beside its lanes). A crossing's ground is
	// read off its runs, a zebra's the hull of its stripes, grown by
	// SIGN_EDGE, as its stripes stop short of its lanes' edges.
	const crossingGround = offset(
		union(
			pieces
				.flatMap(({ d }) =>
					d.crossings.flatMap((c) =>
						c.runs.flatMap((r) => (r.kind === 'zebra' ? [hullOf(r.rings.flat())] : r.rings))
					)
				)
				.map(toPath)
		),
		SIGN_EDGE
	).map(fromPath);
	// Rays every half metre or so along a line and on SIGN_EDGE past either
	// end, where the lines along its lanes' edges lie, and the crossings
	// (rings of the crossings' ground) its rays meet.
	const facing = pieces.flatMap(({ id, d }) =>
		d.signs.flatMap((s) => {
			if (s.kind !== 'stop' && s.kind !== 'yield') return [];
			const ahead =
				s.kind === 'yield' ? { x: -s.toward.x, y: -s.toward.y } : aheadOf(s, drawnRoads);
			const u = { x: s.b.x - s.a.x, y: s.b.y - s.a.y };
			const l = Math.hypot(u.x, u.y);
			if (!ahead || l < 1e-6) return [];
			const across = { x: u.x / l, y: u.y / l };
			const n = Math.max(2, Math.ceil((l + 2 * SIGN_EDGE) / 0.5));
			const rays = Array.from({ length: n + 1 }, (_, k) => {
				const along = -SIGN_EDGE + ((l + 2 * SIGN_EDGE) * k) / n;
				const p = offsetPoint(s.a, across, along);
				const hit = firstHit(p, ahead, crossingGround);
				return hit === null
					? null
					: { p, q: offsetPoint(p, ahead, hit.t), ...hit, on: along >= 0 && along <= l };
			}).filter((r) => r !== null);
			const lanes = new Set(s.lanes.map(laneKey));
			const meets = new Set(rays.filter((r) => r.on).map((r) => r.ring));
			return [{ id, s, ahead, rays, lanes, meets }];
		})
	);
	for (const { id, s, ahead, rays, lanes, meets } of facing) {
		// Another line for traffic heading this way between it and its
		// crossing, or another for one of its lanes standing for the same
		// crossing beside it (two paths out of one lane each given a line).
		const twice = facing.find(
			(o) =>
				o.s !== s &&
				dot(o.ahead, ahead) > 0.5 &&
				(rays.some((r) => r.on && segmentsCross(r.p, r.q, o.s.a, o.s.b)) ||
					([...o.lanes].some((k) => lanes.has(k)) && [...o.meets].some((k) => meets.has(k))))
		);
		if (twice) out.push(`lane marked twice for one crossing: ${id} and ${twice.id}`);
		// The ground between, from SIGN_EDGE past the line to its crossing:
		// the strips between rays side by side.
		const ground: Path[] = [];
		for (let k = 1; k < rays.length; k++) {
			const [r, q] = [rays[k - 1], rays[k]];
			if (r.t <= SIGN_EDGE || q.t <= SIGN_EDGE) continue;
			const [a, b] = [offsetPoint(r.p, ahead, SIGN_EDGE), offsetPoint(q.p, ahead, SIGN_EDGE)];
			ground.push(toPath([a, b, q.q, r.q]));
		}
		const between = union(ground);
		if (!between.length) continue;
		const stray = pieces.find(({ d }) =>
			d.markings.some((m) => [m.line[0], m.line.at(-1)].some((p) => !!p && inside(between, p)))
		);
		if (stray) out.push(`lane line ends between a line and its crossing: ${id} (${stray.id})`);
		// Nor does any paint lie there: lane and edge lines, hatching, arrows.
		// But for the lines round a median's nose, which comes forward past a
		// stop line: what hugs a raised median ending there, short of the
		// crossing, isn't read. One running on up to the crossing (a refuge
		// on it) has no nose there, and the lines beside it count.
		const noses = piecesOf(intersect(raised, offset(between, INSET + LINE + SIGN_EDGE))).filter(
			(piece) => !intersect(offset(piece, 0.05), bodies).length
		);
		const open = noses.length ? subtract(between, offset(noses.flat(), INSET + LINE)) : between;
		const box = boxOf(open.flatMap(fromPath));
		for (const { id: other, d } of pieces) {
			const rings = [
				...paintOf({ ...d, signs: d.signs.filter((x) => x.kind === 'arrow') }).flatMap(
					(p) => p.rings
				),
				...d.surfaces.flatMap((x) => x.bars?.rings ?? [])
			].filter((r) => overlap(boxOf(r), box));
			if (!rings.length) continue;
			const lying = sum(intersect(union(rings.map(toPath)), open));
			if (lying > TOL)
				out.push(`paint between a line and its crossing: ${id} (${other}) ${lying.toFixed(2)} m²`);
		}
	}

	// Every ring is simple (it neither crosses nor touches itself) and wound
	// positively (toRings sees to it), and no ribbon is folded (ribbonOf sees
	// to it).
	for (const { id, d } of pieces) {
		const rings = [
			...d.surfaces.flatMap((s) => [
				...('left' in s.shape ? [] : s.shape),
				...(s.bars?.rings ?? [])
			]),
			...d.crossings.flatMap((c) => [...c.body, ...c.runs.flatMap((r) => r.rings)]),
			...(d.cleared ?? []),
			...('outline' in d ? d.outline.rings : [])
		];
		if (rings.some((r) => signedArea(r) <= 0 || crossesItself(r, true)))
			out.push(`ring not simple: ${id}`);
		for (const s of d.surfaces)
			if ('left' in s.shape && folded(s.shape)) out.push(`ribbon inverted: ${id}`);
		for (const p of d.faults)
			out.push(`ring left with a hole: ${id} at (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
	}

	// One owner per ground: nothing is drawn twice over the same ground in one
	// layer of the renderer (layerOf in rendering/road-meshes.ts), where which
	// shows is down to the order they are drawn in. Within a surface that is
	// exact: the triangles a ribbon is drawn as (strip in
	// rendering/road-meshes.ts) and the rings of one surface only ever share
	// edges, and so do the rings of one layer of a crossing (its stripes, its
	// paving); a crossing's paving, drawn a centimetre wider (LAP in
	// corners.ts) under its own stripes, which lie in a layer above it, may
	// lap them. Two crossings of one piece, each drawn so a centimetre wider
	// where they meet, are read shrunk by SHRUNK, as two surfaces are. Between two
	// surfaces each is shrunk by SHRUNK first, so a shared edge and the
	// centimetre a junction's corners are drawn wider by don't count: no lap
	// under 6 cm across (nor any under TOL in all) is reported between two of
	// one piece, of two roads, of two nodes, of a road and the node it ends
	// at, or of any two footpath pieces (a strip lying on a bend or joint it
	// doesn't end at among them). Two footpath pieces, never drawn wider, are
	// each shrunk by FOOT_SHRUNK alone: a lap of theirs 1 cm across counts.
	// Two laps are meant: a junction's corner sidewalks and verges run SEAM
	// back over the roads' own (node.ts), so walk and grass verge aren't
	// compared with their own kind between a road and its node, but between
	// two footpath pieces; and footpaths are strips paved up to their nodes,
	// or to where a bend there takes them over (core/footpaths.ts), so two footpath pieces ending at one node (that
	// node, not another lying at the same spot) lap each other from that node
	// outward: ground of a kind they share, in one piece, is their lap there
	// where that piece reaches the end of each at that node, each strip's
	// cross-section there, a fill's being those of the strips it joins
	// (`unshared`), and read against a fill of two a strip's being both of
	// those (`together`); and the two strips of a bend may lap each other
	// within the bend's own ground alone. Any other ground two footpath
	// pieces both cover, a piece away from every node they share or reaching
	// the end of only one there outside the bend, counts. A double cover is
	// named by its two surfaces' role and material, once where they are the
	// same.
	const kindOf = (s: Surface) => `${s.role}|${s.material}`;
	const named = (a: string, b: string) => (a === b ? a : [a, b].sort().join(' and '));
	// The area a set of rings covers more than once.
	const twice = (rings: Pt[][]) => {
		const paths = rings.map(toPath);
		return sum(paths) - sum(union(paths));
	};
	const trianglesOf = ({ left, right }: Ribbon) =>
		left.slice(1).flatMap((_, k) => [
			[left[k], left[k + 1], right[k + 1]],
			[left[k], right[k + 1], right[k]]
		]);
	// Each footpath strip's ends: the node it ends at, with its cross-section
	// there.
	const stripEnds = new Map(
		scene.place.roads.flatMap((r) => {
			const d = scene.road(r.id)!;
			const nodes = scene.footpathNodes(r.id);
			if (!nodes || !d.edges.length) return [];
			const at = (node: string, k: 0 | -1) => ({
				node,
				edge: [d.edges[0].at(k)!, d.edges.at(-1)!.at(k)!] as [Pt, Pt]
			});
			return [[r.id, { start: at(nodes[0], 0), end: at(nodes[1], -1) }] as const];
		})
	);
	// The ends of two strips a fill joins at its node, by each: there they
	// end together, read so against that fill. A bend cuts both its strips
	// back and paves the way round between them, so a lap of the bend's with
	// either reaches the end of one of them and the other's only through the
	// bend. (Two at a car road's dead end, both paved up to their node, lap
	// from it anyway; three or more each keep their own.)
	const together = new Map<string, { node: string; edge: [Pt, Pt] }[]>();
	// Each bend's own ground, by its node: the one place its two strips may
	// lap each other (a bend tighter than they are wide takes them over as
	// far as they would lap: core/footpaths.ts).
	const bends = new Map<string, Paths>();
	for (const { d } of nodes) {
		const ends = d.ends.flatMap((e) => stripEnds.get(e.ref.road)?.[e.ref.end] ?? []);
		if (ends.length !== 2) continue;
		for (const e of d.ends) together.set(endKey(e.ref), ends);
		if (scene.footpathBend(ends[0].node))
			bends.set(ends[0].node, union(d.surfaces.flatMap(shapeOf)));
	}
	// A footpath piece's ends: a strip's two, or those of the strips a fill
	// joins at its node; and a strip's read against a fill (`withFill`, each
	// with those it ends together with).
	const endsOf = (id: string, d: Description, withFill: boolean) =>
		'outline' in d
			? d.ends.flatMap((e) => stripEnds.get(e.ref.road)?.[e.ref.end] ?? [])
			: (['start', 'end'] as const).flatMap((k) => {
					const own = stripEnds.get(id)?.[k];
					return own ? (withFill && together.get(`${id}:${k}`)) || [own] : [];
				});
	// Of the ground two footpath pieces both cover, what is not their lap at
	// a node both end at: the parts of it that, grown by END_REACH (the
	// shapes compared were shrunk, each lane's apart from its neighbour's),
	// don't reach the end of each there, two strips lapping so only at a
	// node that is no bend; and of two strips, what of those lies outside
	// the ground of a bend at a node both end at.
	const unshared = (u: (typeof grounds)[number], v: (typeof grounds)[number], both: Paths) => {
		const shared = [...new Set(u.ends.map((e) => e.node))].filter((n) =>
			v.ends.some((f) => f.node === n)
		);
		if (!shared.length) return sum(both);
		const lapAt = u.node || v.node ? shared : shared.filter((n) => !bends.has(n));
		const [mine, yours] = [
			u.node || !v.node ? u.ends : u.joined,
			v.node || !u.node ? v.ends : v.joined
		];
		const reaches = (near: Paths, of: typeof u.ends, node: string) =>
			of.some((e) => e.node === node && meets(near, e.edge));
		const bend = u.node || v.node ? [] : union(shared.flatMap((n) => bends.get(n) ?? []));
		const held = bend.length ? offset(bend, END_REACH) : [];
		return piecesOf(offset(both, END_REACH))
			.filter((near) => !lapAt.some((n) => reaches(near, mine, n) && reaches(near, yours, n)))
			.reduce((s, near) => {
				const lap = intersect(both, near);
				return s + sum(held.length ? subtract(lap, held) : lap);
			}, 0);
	};
	const grounds = pieces.map(({ id, d }) => {
		for (const s of d.surfaces)
			if (twice('left' in s.shape ? trianglesOf(s.shape) : s.shape) > TOL)
				out.push(`double cover: ${id} ${kindOf(s)} within one surface`);
		// Of each crossing, its stripes and its paving, each a layer.
		const crossingLayers = d.crossings.flatMap((c) =>
			[true, false].map((stripes) =>
				c.runs.filter((r) => (r.kind === 'zebra') === stripes).flatMap((r) => r.rings)
			)
		);
		const crossingGrounds = d.crossings.map((c) =>
			offset(union(c.runs.flatMap((r) => r.rings).map(toPath)), -SHRUNK).map(fromPath)
		);
		if (crossingLayers.some((r) => twice(r) > TOL) || twice(crossingGrounds.flat()) > TOL)
			out.push(`double cover: ${id} crossings`);
		// By layer, then by kind: each surface shrunk, and a footpath's shrunk
		// less (`foot`) to be read against other footpaths.
		const byLayer = (by: number) =>
			new Map(
				[...Map.groupBy(d.surfaces, layerOf)].map(([layer, same]) => [
					layer,
					same.map((s) => ({ kind: kindOf(s), shape: offset(shapeOf(s), -by) }))
				])
			);
		const layers = byLayer(SHRUNK);
		for (const shapes of layers.values())
			for (let i = 0; i < shapes.length; i++)
				for (let k = i + 1; k < shapes.length; k++)
					if (sum(intersect(shapes[i].shape, shapes[k].shape)) > TOL)
						out.push(`double cover: ${id} ${named(shapes[i].kind, shapes[k].kind)}`);
		const pts = d.surfaces.flatMap((s) =>
			'left' in s.shape ? [...s.shape.left, ...s.shape.right] : s.shape.flat()
		);
		return {
			id,
			node: 'outline' in d,
			footpath: onFoot(d),
			ends: onFoot(d) ? endsOf(id, d, false) : [],
			joined: onFoot(d) ? endsOf(id, d, true) : [],
			// The roads a node ends.
			roads: 'outline' in d ? new Set(d.ends.map((e) => e.ref.road)) : null,
			layers,
			foot: onFoot(d) ? byLayer(FOOT_SHRUNK) : null,
			x0: Math.min(...pts.map((p) => p.x)),
			x1: Math.max(...pts.map((p) => p.x)),
			y0: Math.min(...pts.map((p) => p.y)),
			y1: Math.max(...pts.map((p) => p.y))
		};
	});
	for (let i = 0; i < grounds.length; i++) {
		for (let k = i + 1; k < grounds.length; k++) {
			const [u, v] = [grounds[i], grounds[k]];
			const [node, road] = u.node ? [u, v] : [v, u];
			const between = u.node !== v.node;
			const onFoot = u.footpath && v.footpath;
			if (between && !onFoot && !node.roads?.has(road.id)) continue;
			if (u.x1 < v.x0 || v.x1 < u.x0 || u.y1 < v.y0 || v.y1 < u.y0) continue;
			const [mine, yours] = u.foot && v.foot ? [u.foot, v.foot] : [u.layers, v.layers];
			for (const [layer, shapes] of mine) {
				const theirs = yours.get(layer) ?? [];
				for (const ka of new Set(shapes.map((s) => s.kind)))
					for (const kb of new Set(theirs.map((s) => s.kind))) {
						if (ka === kb && between && !onFoot && LAPPED.includes(ka)) continue;
						const both = intersect(
							shapes.filter((s) => s.kind === ka).flatMap((s) => s.shape),
							theirs.filter((s) => s.kind === kb).flatMap((s) => s.shape)
						);
						const shared = ka === kb && u.footpath && v.footpath ? unshared(u, v, both) : sum(both);
						if (shared > TOL)
							out.push(
								`double cover: ${u.id} and ${v.id} ${named(ka, kb)} ${shared.toFixed(2)} m²`
							);
					}
			}
		}
	}
	return out;
}

// A road end of footpaths meeting: walks, and no roadway.
const footpathEnd = (e: EndInfo) =>
	e.lanes.some((l) => isWalk(l.lane)) && !e.lanes.some((l) => isRoadway(l.lane));

// A footpath's piece (core/footpaths.ts): a road of lanes none of which is
// a car lane, or a node of such roads alone.
const noCars = (lanes: { lane: { kind: string } }[]) =>
	lanes.length > 0 && lanes.every((l) => l.lane.kind !== 'drive');
const onFoot = (d: Description) =>
	'outline' in d ? d.ends.length > 0 && d.ends.every((e) => noCars(e.lanes)) : noCars(d.lanes);

// How far ahead of a stop line or give-way teeth the crossing it stands
// for may lie (m): behind a crossing at a slant, the far side of its lanes
// meets it further on than the near side.
const SIGN_REACH = 10;
// How far past either end of such a line, and short of where it and its
// crossing lie, the ground between them is read (m): the lane lines along
// its lanes' edges lie just past its ends.
const SIGN_EDGE = 0.3;

const SPIKE = (30 * Math.PI) / 180;
const LINE_END = 0.75;
const CRACK = 0.05;
// What a junction's corner sidewalks and verges lap of its roads.
const LAPPED = ['walk|concrete', 'verge|grass'];
// How near the end of each of two footpath pieces at a node ground both
// cover must come to be their lap there (m): the shapes compared are shrunk
// first.
const END_REACH = 0.1;

// The way a stop line's traffic drives: along the road of the first lane
// it holds, toward the end that lane heads to. Null where that road is not
// drawn (merged away).
function aheadOf(s: Extract<Sign, { kind: 'stop' }>, roads: Map<string, RoadDescription>) {
	const ref = s.lanes[0];
	const road = ref && roads.get(ref.road);
	if (!road) return null;
	const mid = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
	const { t } = frameAt(road.path, project(road.path, mid).s);
	return ref.end === 'end' ? t : { x: -t.x, y: -t.y };
}

// How far along a ray from `p` heading `dir` (a unit vector) it first
// enters any of `rings`, within SIGN_REACH, and which of them, or null.
function firstHit(p: Pt, dir: Pt, rings: Ring[]) {
	let best: { t: number; ring: number } | null = null;
	for (const [k, ring] of rings.entries())
		for (let i = 0; i < ring.length; i++) {
			const [a, b] = [ring[i], ring[(i + 1) % ring.length]];
			const e = { x: b.x - a.x, y: b.y - a.y };
			const den = dir.x * e.y - dir.y * e.x;
			if (Math.abs(den) < 1e-12) continue;
			const w = { x: a.x - p.x, y: a.y - p.y };
			const t = (w.x * e.y - w.y * e.x) / den;
			const f = (w.x * dir.y - w.y * dir.x) / den;
			if (t >= 0 && t <= SIGN_REACH && f >= 0 && f <= 1 && (best === null || t < best.t))
				best = { t, ring: k };
		}
	return best;
}

// Whether a line from a to b meets a set of rings: an end inside, or the
// line crossing an edge.
function meets(paths: Paths, [a, b]: [Pt, Pt]) {
	if (inside(paths, a) || inside(paths, b)) return true;
	return paths.some((path) => {
		const ring = fromPath(path);
		return ring.some((p, i) => segmentsCross(a, b, p, ring[(i + 1) % ring.length]));
	});
}

// The length round a ring.
function perimeter(ring: Path) {
	const pts = fromPath(ring);
	return pts.reduce((s, p, i) => {
		const q = pts[i ? i - 1 : pts.length - 1];
		return s + Math.hypot(p.x - q.x, p.y - q.y);
	}, 0);
}

// The ground a path sweeps: its line moved half its width to either side.
function bandOf({ line, widths }: LanePath): Path {
	const side = (sign: number) =>
		line.map((p, i) => {
			const a = line[Math.max(0, i - 1)];
			const b = line[Math.min(line.length - 1, i + 1)];
			const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
			return offsetPoint(p, { x: -(b.y - a.y) / l, y: (b.x - a.x) / l }, (sign * widths[i]) / 2);
		});
	return toPath([...side(1), ...side(-1).reverse()]);
}

// How far a point lies from a polyline.
function offLine(p: Pt, line: Pt[]) {
	let best = Infinity;
	for (let i = 1; i < line.length; i++) {
		const [a, b] = [line[i - 1], line[i]];
		const [dx, dy] = [b.x - a.x, b.y - a.y];
		const f = Math.max(
			0,
			Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))
		);
		best = Math.min(best, Math.hypot(a.x + dx * f - p.x, a.y + dy * f - p.y));
	}
	return best;
}

// The sharpest outer corner of the ground on a ring, if one is a spike: the
// angle between the points 0.3 m back and 0.3 m on along the edge, at a
// corner where the ground turns outward, of those `counts` keeps. A notch
// turning in isn't a spike, nor is the sharp tip of a hole in the ground:
// there the ground turns in round open ground. `ring` is one clipper
// returned (`offset`), and clipper winds every ring it returns by its role,
// whatever the winding it was handed: an outer ring to a positive area
// (`area` in clip.ts), a hole to a negative one. So the ground lies to the
// left of every ring walked along it, and its outer corners all turn left.
function spike(ring: Path, counts: (p: Pt) => boolean) {
	const pts = fromPath(ring);
	const n = pts.length;
	if (n < 3) return null;
	const away = (i: number, step: number) => {
		let run = 0;
		let k = i;
		for (let guard = 0; guard < n; guard++) {
			const next = (k + step + n) % n;
			run += Math.hypot(pts[next].x - pts[k].x, pts[next].y - pts[k].y);
			k = next;
			if (run >= 0.3) return pts[k];
		}
		return pts[k];
	};
	for (let i = 0; i < n; i++) {
		const p = pts[i];
		const a = away(i, -1);
		const b = away(i, 1);
		const u = { x: a.x - p.x, y: a.y - p.y };
		const v = { x: b.x - p.x, y: b.y - p.y };
		const lu = Math.hypot(u.x, u.y);
		const lv = Math.hypot(v.x, v.y);
		if (lu < 0.2 || lv < 0.2) continue;
		const angle = Math.acos(Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y) / (lu * lv))));
		// An outer corner of the ground: the turn from (p - a) to (b - p) the
		// way an outer ring winds.
		const turn = (p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x);
		if (angle < SPIKE && turn > 0 && counts(p)) return p;
	}
	return null;
}
