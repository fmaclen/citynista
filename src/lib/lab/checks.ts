// Geometry rules every built place must satisfy. Used by the jitter test.

import {
	area,
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
import { endsPastEdge } from './edit';
import { offsetPoint, project } from './geometry';
import { islandShape, endsOf } from './junction';
import type { Pt } from './model';
import type { Scene } from './scene';

const sum = (paths: Paths) => paths.reduce((s, p) => s + area(p), 0);
const TOL = 0.05;

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt) {
	const side = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
	// Apart in either axis: no crossing (and no float noise between two
	// pieces of one straight line).
	if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x))
		return false;
	if (Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y))
		return false;
	return side(c, d, a) * side(c, d, b) < 0 && side(a, b, c) * side(a, b, d) < 0;
}

export function check(scene: Scene): string[] {
	scene.build();
	const out: string[] = [];
	const roads = scene.place.roads.filter((r) => !scene.hidden.has(r.id));
	const roadDraws = roads.map((r) => ({ id: r.id, draw: scene.roadDraw(r.id)! }));
	const junctions = scene.effective.map((j) => ({ j, draw: scene.junctionDraw(j.id)! }));

	const roadway = union(roadDraws.flatMap((r) => r.draw.roadway));
	const outlines = union(junctions.flatMap((j) => j.draw.asphalt));
	const surface = union([...roadway, ...outlines]);
	// Paint may also sit on a trail (its centre line).
	const painted = union([...surface, ...roadDraws.flatMap((r) => r.draw.fills.get('trail') ?? [])]);
	const raised = union([
		...roadDraws.flatMap((r) => [
			...(r.draw.fills.get('grass') ?? []),
			...(r.draw.fills.get('concrete') ?? [])
		]),
		...junctions.flatMap((j) =>
			j.draw.carried.filter((c) => c.surface !== 'hatch').flatMap((c) => c.paths)
		),
		...junctions.flatMap((j) => j.draw.islands.map((i) => i.path)),
		...junctions.flatMap((j) => j.draw.verges),
		...scene.placeIslands().map((i) => i.path)
	]);
	const pavement = union([
		...roadDraws.flatMap((r) => r.draw.fills.get('pavement') ?? []),
		...junctions.flatMap((j) => j.draw.pavement)
	]);
	// Sidewalk laid across a road's mouth: paint mustn't sit on it either.
	const paving = union(
		junctions.flatMap((j) => j.draw.crossings.filter((c) => c.on).flatMap((c) => c.paving))
	);

	// Paint stays on asphalt: inside roads and outlines, never on grass,
	// concrete or sidewalk.
	const paint: Paths = [
		...roadDraws.flatMap((r) => [...r.draw.white, ...r.draw.yellow].map(toPath)),
		...junctions.flatMap((j) => [...j.draw.white, ...j.draw.yellow].map(toPath))
	];
	const lines = union(paint);
	const off = sum(subtract(lines, offset(painted, 0.02)));
	if (off > TOL) out.push(`paint outside the roads and outlines: ${off.toFixed(2)} m²`);
	const onRaised = sum(intersect(lines, offset(raised, -0.02)));
	if (onRaised > TOL) out.push(`paint on grass or concrete: ${onRaised.toFixed(2)} m²`);
	// A trail laid over a sidewalk is drawn on top of it; its paint is fine.
	const trails = union(roadDraws.flatMap((r) => r.draw.fills.get('trail') ?? []));
	const onWalk = sum(
		intersect(lines, offset(subtract(union([...pavement, ...paving]), trails), -0.02))
	);
	if (onWalk > TOL) out.push(`paint on sidewalk: ${onWalk.toFixed(2)} m²`);

	// Sidewalk never overlaps asphalt (crossings are drawn as crossings).
	const walkOver = sum(intersect(offset(pavement, -0.02), surface));
	if (walkOver > TOL) out.push(`sidewalk over asphalt: ${walkOver.toFixed(2)} m²`);

	// Lines never cross each other.
	const marks = [
		...roadDraws.flatMap((r) => r.draw.marks.map((m) => ({ m, who: r.id }))),
		...junctions.flatMap((j) => j.draw.marks.map((m) => ({ m, who: j.j.id })))
	];
	for (let i = 0; i < marks.length; i++) {
		for (let k = i + 1; k < marks.length; k++) {
			const p = marks[i].m.pts;
			const q = marks[k].m.pts;
			let hit = false;
			for (let a = 1; a < p.length && !hit; a++) {
				for (let b = 1; b < q.length && !hit; b++) {
					if (segmentsCross(p[a - 1], p[a], q[b - 1], q[b])) hit = true;
				}
			}
			if (hit) out.push(`lines cross: ${marks[i].who} and ${marks[k].who}`);
		}
	}

	// No hole between a road and its junction: just inside the junction and
	// just inside the road, all across the roadway, there is surface.
	const covered = union([...surface, ...raised]);
	for (const { j, draw } of junctions) {
		for (const m of draw.mouths) {
			for (let k = 1; k < m.pts.length; k++) {
				const a = m.pts[k - 1];
				const b = m.pts[k];
				// Steps along a carriageway's side run along the road: skip them.
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				if (Math.abs(dx * m.out.x + dy * m.out.y) > 0.5 * Math.hypot(dx, dy)) continue;
				for (let f = 0.1; f <= 0.91; f += 0.2) {
					const p = { x: a.x + dx * f, y: a.y + dy * f };
					for (const d of [-0.3, 0.3]) {
						const q = offsetPoint(p, m.out, d);
						if (!inside(covered, q))
							out.push(`hole at ${j.id} ${m.key} (${q.x.toFixed(1)}, ${q.y.toFixed(1)})`);
					}
				}
			}
		}
	}

	// No island over a lane.
	const lanes = roadway;
	const islandPaths = [
		...junctions.flatMap(({ j }) =>
			j.islands
				.map((i) => islandShape(i, endsOf(j, scene.geos)))
				.filter((s): s is Pt[] => !!s)
				.map(toPath)
		),
		...scene.placeIslands().map((i) => i.path)
	];
	const overLane = sum(intersect(union(islandPaths), offset(lanes, -0.02)));
	if (overLane > TOL) out.push(`island over a lane: ${overLane.toFixed(2)} m²`);

	// No road end inside an island, or pushed past the edge of the road it
	// joins (out in the street, inside a roundabout's ring).
	const solidIslands = offset(union(islandPaths), -0.1);
	for (const r of roads) {
		for (const [end, p] of [
			['start', r.points[0]],
			['end', r.points[r.points.length - 1]]
		] as const) {
			if (inside(solidIslands, p)) out.push(`${r.id}:${end} inside an island`);
		}
	}
	for (const e of endsPastEdge(scene.place)) out.push(`end past the through road's edge: ${e}`);

	// No spikes in the sidewalk: no outer corner sharper than SPIKE, measured
	// over a short stretch either side so curve facets don't count.
	// Slivers and slits under 8 cm wide, where two pieces of sidewalk meet
	// edge to edge, are closed and opened away first: too thin to see at any
	// working zoom, they aren't spikes.
	// Only what shows: asphalt is drawn over the sidewalk.
	// A trail crossing a sidewalk at an angle makes sharp corners by design,
	// so trails aren't part of it.
	const walks = subtract(union([...pavement, ...paving]), surface);
	for (const ring of offset(offset(offset(walks, 0.04), -0.08), 0.04)) {
		// A speck too small to see isn't a spike.
		if (Math.abs(area(ring)) < 0.05) continue;
		const tip = spike(ring);
		if (tip) out.push(`sidewalk spike at (${tip.x.toFixed(1)}, ${tip.y.toFixed(1)})`);
	}

	// A crossing across a road is one piece with no holes.
	for (const { id, draw } of roadDraws) {
		draw.crossings.forEach((c, k) => {
			const rings = union(c.hit);
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
	// or the outline), at a stretch change, or where a carriageway ends: never
	// out in the middle of the asphalt.
	for (const { id, draw } of roadDraws) {
		const road = scene.place.roads.find((r) => r.id === id)!;
		const length = draw.path.length;
		const near = (s: number) => {
			if (s <= draw.cut.start.paint + LINE_END) return true;
			if (s >= length - draw.cut.end.paint - LINE_END) return true;
			for (const st of road.stretches.slice(1))
				if (s >= st.at - LINE_END && s <= st.at + st.taper + LINE_END) return true;
			for (const d of Object.values(road.cuts?.start ?? {}))
				if (Math.abs(s - d - draw.cut.start.paint) <= LINE_END + draw.cut.start.paint) return true;
			for (const d of Object.values(road.cuts?.end ?? {}))
				if (Math.abs(length - d - s) <= LINE_END + draw.cut.end.paint) return true;
			return false;
		};
		for (const m of draw.marks) {
			for (const k of [0, m.pts.length - 1]) {
				const p = m.pts[k];
				if (!p) continue;
				const s = m.along?.[k] ?? project(draw.path, p).s;
				if (!near(s))
					out.push(
						`line ends mid-road: ${id} at ${s.toFixed(1)} m (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`
					);
			}
		}
	}
	return out;
}

const SPIKE = (30 * Math.PI) / 180;
const LINE_END = 0.75;

// The sharpest outer corner of a ring, if one is a spike: the angle between
// the points 0.3 m back and 0.3 m on along the edge, at a corner that turns
// outward (a notch turning in isn't a spike).
function spike(ring: Path) {
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
		if (angle < SPIKE && Math.sign(turn) === orient) return p;
	}
	return null;
}
