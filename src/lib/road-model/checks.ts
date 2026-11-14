// Geometry rules every built place must satisfy, read off its descriptions
// (description.ts). Used by the unit tests and the jitter test
// (unit/jitter.ts).

import { layerOf, paintOf } from '../rendering/road-meshes';
import {
	area,
	close,
	fromPath,
	inside,
	intersect,
	offset,
	subtract,
	toPath,
	union,
	type Path,
	type Paths
} from './clip';
import type { Description, LanePath, Ribbon, Surface } from './description';
import { crossesItself, folded, offsetPoint, project, segmentsCross, signedArea } from './geometry';
import type { Pt } from './model';
import type { Drawing } from './drawing';

const sum = (paths: Paths) => paths.reduce((s, p) => s + area(p), 0);
const TOL = 0.05;
// A junction's corner sidewalks, verges and crossing paving are drawn a
// centimetre wider all round (LAP in node.ts), allowed for in each margin
// below, so the rules measure what was drawn.
const GROWN = 0.01;

export function check(scene: Drawing): string[] {
	scene.build();
	const out: string[] = [];
	const roads = scene.place.roads.map((r) => ({ id: r.id, d: scene.road(r.id)! }));
	const nodes = scene.place.junctions.map((j) => ({ id: j.id, d: scene.node(j.id)! }));
	const pieces: { id: string; d: Description }[] = [...roads, ...nodes];

	// A ribbon's outline covers what its quads do: none is turned over.
	const shapeOf = (s: Surface): Paths =>
		'left' in s.shape
			? [toPath([...s.shape.left, ...[...s.shape.right].reverse()])]
			: s.shape.map(toPath);
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
			.flatMap((p) =>
				p.line.flatMap((q, k) => {
					if (!k) return [q];
					const a = p.line[k - 1];
					const n = Math.max(1, Math.ceil(Math.hypot(q.x - a.x, q.y - a.y) / 0.25));
					return Array.from({ length: n }, (_, i) => ({
						x: a.x + ((q.x - a.x) * (i + 1)) / n,
						y: a.y + ((q.y - a.y) * (i + 1)) / n
					}));
				})
			)
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

	// No spikes in the sidewalk: no outer corner sharper than SPIKE, measured
	// over a short stretch either side so curve facets don't count.
	// Slivers and slits under 8 cm wide, where two pieces of sidewalk meet
	// edge to edge, are closed and opened away first: too thin to see at any
	// working zoom, they aren't spikes.
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
	// or the outline), never out in the middle of the asphalt.
	for (const { id, d } of roads) {
		const length = d.path.length;
		const near = (s: number) =>
			s <= d.cut.start.paint + LINE_END || s >= length - d.cut.end.paint - LINE_END;
		// Or at a crossing's edge: its body's reach along the road.
		const crossed = (s: number) =>
			d.crossings.some((c) => {
				const along = c.body.flat().map((q) => project(d.path, q).s);
				return s >= Math.min(...along) - LINE_END && s <= Math.max(...along) + LINE_END;
			});
		for (const m of d.markings) {
			// A line closed round a median with a nose at either end has none.
			const [first, last] = [m.line[0], m.line[m.line.length - 1]];
			if (first && Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) continue;
			for (const k of [0, m.line.length - 1]) {
				const p = m.line[k];
				if (!p) continue;
				const s = m.along[k];
				if (!near(s) && !crossed(s))
					out.push(
						`line ends mid-road: ${id} at ${s.toFixed(1)} m (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`
					);
			}
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
	// exact: the triangles a
	// ribbon is drawn as (strip in rendering/road-meshes.ts) and the rings of
	// one surface only ever share edges, and so do the rings of one piece's
	// crossings. Between two surfaces each is shrunk first, so a shared edge
	// and a centimetre's lap don't count: two of one piece, of two roads, of
	// two nodes, or of a road and the node it ends at. One lap is meant: a
	// junction's corner sidewalks and verges run SEAM back over the roads' own
	// (node.ts), so walk and grass verge aren't compared with their own
	// kind between a road and its node. A double cover is named by its two
	// surfaces' role and material, once where they are the same.
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
	const grounds = pieces.map(({ id, d }) => {
		for (const s of d.surfaces)
			if (twice('left' in s.shape ? trianglesOf(s.shape) : s.shape) > TOL)
				out.push(`double cover: ${id} ${kindOf(s)} within one surface`);
		if (twice(d.crossings.flatMap((c) => c.runs.flatMap((r) => r.rings))) > TOL)
			out.push(`double cover: ${id} crossings`);
		// By layer, then by kind: each surface shrunk.
		const layers = new Map(
			[...Map.groupBy(d.surfaces, layerOf)].map(([layer, same]) => [
				layer,
				same.map((s) => ({ kind: kindOf(s), shape: offset(shapeOf(s), -0.02 - GROWN) }))
			])
		);
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
			// The roads a node ends.
			roads: 'outline' in d ? new Set(d.ends.map((e) => e.ref.road)) : null,
			layers,
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
			if (between && !node.roads?.has(road.id)) continue;
			if (u.x1 < v.x0 || v.x1 < u.x0 || u.y1 < v.y0 || v.y1 < u.y0) continue;
			for (const [layer, shapes] of u.layers) {
				const theirs = v.layers.get(layer) ?? [];
				for (const ka of new Set(shapes.map((s) => s.kind)))
					for (const kb of new Set(theirs.map((s) => s.kind))) {
						if (between && ka === kb && LAPPED.includes(ka)) continue;
						const shared = sum(
							intersect(
								shapes.filter((s) => s.kind === ka).flatMap((s) => s.shape),
								theirs.filter((s) => s.kind === kb).flatMap((s) => s.shape)
							)
						);
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

const SPIKE = (30 * Math.PI) / 180;
const LINE_END = 0.75;
const CRACK = 0.05;
// What a junction's corner sidewalks and verges lap of its roads.
const LAPPED = ['walk|concrete', 'verge|grass'];

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

// The sharpest outer corner of a ring, if one is a spike: the angle between
// the points 0.3 m back and 0.3 m on along the edge, at a corner that turns
// outward (a notch turning in isn't a spike), of those `counts` keeps.
function spike(ring: Path, counts: (p: Pt) => boolean) {
	const pts = fromPath(ring);
	const n = pts.length;
	if (n < 3) return null;
	const orient = Math.sign(area(ring));
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
		// Convex for the ring's own winding: the turn from (p - a) to (b - p).
		const turn = (p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x);
		if (angle < SPIKE && Math.sign(turn) === orient && counts(p)) return p;
	}
	return null;
}
