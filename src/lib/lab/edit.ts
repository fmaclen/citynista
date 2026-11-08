// Edits that keep a place valid. A road end sits on its junction's edge: a
// drag that would push it inside the junction, past a neighbouring end, onto
// an island or over another road is clamped at the last valid position.

import { area, inside, intersect, offset, toPath, union, type Paths } from './clip';
import { samplePath } from './geometry';
import {
	centreOf,
	continuingPairs,
	endsOf,
	islandShape,
	outlineOf,
	type RoadGeo
} from './junction';
import { effectiveJunctions, SPLIT_GAP } from './merge';
import type { End, Junction, Place, Pt } from './model';
import { isRoadway, isWalk, laneStrips, roadRows } from './road';

export function geosOf(place: Place) {
	return new Map<string, RoadGeo>(place.roads.map((r) => [r.id, { road: r, path: samplePath(r) }]));
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt) {
	const side = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
	return side(c, d, a) * side(c, d, b) < 0 && side(a, b, c) * side(a, b, d) < 0;
}

export function selfIntersects(poly: Pt[]) {
	const n = poly.length;
	for (let i = 0; i < n; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % n];
		for (let j = i + 2; j < n; j++) {
			if (i === 0 && j === n - 1) continue;
			if (segmentsCross(a, b, poly[j], poly[(j + 1) % n])) return true;
		}
	}
	return false;
}

const footprint = (geo: RoadGeo, keep: (l: Parameters<typeof isRoadway>[0]) => boolean): Paths => {
	const rows = roadRows(geo.road, geo.path);
	const paths: Paths = [];
	for (const { polys } of laneStrips(rows, keep).values())
		for (const p of polys) paths.push(toPath(p));
	return union(paths);
};

// What's wrong with a place, looking only at what touches `roads` (all of
// them when absent).
export function problems(place: Place, roads?: Set<string>) {
	const geos = geosOf(place);
	const out: string[] = [];
	const { junctions } = effectiveJunctions(place, geos);
	for (const j of junctions) {
		if (roads && !j.ends.some((e) => roads.has(e.road))) continue;
		const ends = endsOf(j, geos);
		const outline = outlineOf(j, ends);
		const kerbed = [...outline.curbs.values()].map((c) => c.end);
		if (kerbed.length < 2) continue;
		const centre = centreOf(kerbed);
		for (const e of kerbed) {
			const away = { x: e.frame.p.x - centre.x, y: e.frame.p.y - centre.y };
			if (kerbed.length > 2 && away.x * e.frame.out.x + away.y * e.frame.out.y <= 0) {
				out.push(`${j.id}: ${e.key} points into the junction`);
			}
		}
		// The ends must keep the order round the junction its outline stores.
		const stored = j.corners.map((c) => c.a);
		if (stored.length === kerbed.length && kerbed.length > 2) {
			const now = outline.corners.map((c) => c.a);
			const fresh = [...kerbed]
				.sort(
					(a, b) =>
						Math.atan2(a.frame.p.y - centre.y, a.frame.p.x - centre.x) -
						Math.atan2(b.frame.p.y - centre.y, b.frame.p.x - centre.x)
				)
				.map((e) => e.key);
			const rot = fresh.indexOf(now[0]);
			if (rot < 0 || now.some((k, i) => fresh[(rot + i) % fresh.length] !== k)) {
				out.push(`${j.id}: ends passed each other`);
			}
		}
		if (selfIntersects(outline.polygon)) out.push(`${j.id}: outline crosses itself`);
		// A minor road's mouth stays out of the road it joins.
		for (const e of ends) {
			const b = boundsIn(place, j, ends, e.key);
			if (b && b.out < b.least - 0.05)
				out.push(`${j.id}: ${e.key} past the edge of the road it joins`);
		}
		// The outline stays clear of every road's sidewalks, verges and medians:
		// an end pushed behind its neighbour's end line would pave over them.
		const polygon = union([toPath(outline.polygon)]);
		for (const e of ends) {
			// A walk-only road (a trail) stays out of the junction altogether.
			const walkOnly = !e.lanes.some((l) => isRoadway(l.lane));
			// Shrunk a little: a curb running along a road's own edge shares that
			// edge, it doesn't overlap it.
			const off = offset(
				footprint(e.geo, (l) => walkOnly || !isRoadway(l)),
				-0.02
			);
			const over = intersect(polygon, off).reduce((s, p) => s + Math.abs(area(p)), 0);
			if (over > 0.005) out.push(`${j.id}: outline over ${e.ref.road}'s sidewalk`);
		}
		// Each mouth opens onto the junction: just inside it, all across the
		// roadway, is the junction's own surface.
		for (const c of outline.curbs.values()) {
			let opens = true;
			for (let k = 1; k < c.mouth.length && opens; k++) {
				const a = c.mouth[k - 1];
				const b = c.mouth[k];
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				if (Math.abs(dx * c.end.frame.out.x + dy * c.end.frame.out.y) > 0.5 * Math.hypot(dx, dy))
					continue;
				for (let f = 0.1; f <= 0.91 && opens; f += 0.2) {
					const q = {
						x: a.x + dx * f - c.end.frame.out.x * 0.3,
						y: a.y + dy * f - c.end.frame.out.y * 0.3
					};
					if (!inside(polygon, q)) opens = false;
				}
			}
			if (!opens) out.push(`${j.id}: ${c.end.key} doesn't open onto the junction`);
		}
		// Going round, each corner has to move on from one end to the next, not
		// fold back over the end it left.
		const ang = (p: Pt) => Math.atan2(p.y - centre.y, p.x - centre.x);
		for (const c of outline.corners) {
			const from = outline.curbs.get(c.a)!.leave;
			const to = outline.curbs.get(c.b)!.arrive;
			let d = ang(to) - ang(from);
			while (d > Math.PI) d -= 2 * Math.PI;
			while (d <= -Math.PI) d += 2 * Math.PI;
			if (kerbed.length > 2 && d < -0.01) out.push(`${j.id}: outline folds back at ${c.a}`);
		}
	}
	const islands: Paths = place.islands.map((i) => toPath(i.shape));
	for (const j of junctions) {
		const ends = endsOf(j, geos);
		for (const i of j.islands) {
			const shape = islandShape(i, ends);
			if (shape) islands.push(toPath(shape));
		}
	}
	// Footprints: everything, and just the roadway. Two roads may share an
	// edge, and their sidewalks or verges may run into each other; what can't
	// happen is a roadway over anything of another road's.
	const prints = new Map<string, { all: Paths; way: Paths }>();
	const printOf = (id: string) => {
		if (!prints.has(id)) {
			const geo = geos.get(id)!;
			prints.set(id, {
				all: offset(
					footprint(geo, () => true),
					-0.005
				),
				way: offset(footprint(geo, isRoadway), -0.02)
			});
		}
		return prints.get(id)!;
	};
	const sum = (paths: Paths) => paths.reduce((s, p) => s + Math.abs(area(p)), 0);
	for (const road of place.roads) {
		if (roads && !roads.has(road.id)) continue;
		const geo = geos.get(road.id)!;
		if (geo.path.length < 0.3) out.push(`${road.id}: too short`);
		const lanes = footprint(geo, (l) => isRoadway(l) || l.kind === 'trail');
		if (sum(intersect(lanes, union(islands))) > 0.05) out.push(`${road.id}: lanes over an island`);
		for (const other of place.roads) {
			if (other.id === road.id) continue;
			const a = printOf(road.id);
			const b = printOf(other.id);
			if (sum(intersect(a.way, b.all)) + sum(intersect(a.all, b.way)) > 0.01) {
				out.push(`${road.id}: overlaps ${other.id}`);
			}
		}
	}
	return out;
}

function place_(place: Place, road: string, end: End, p: Pt) {
	const r = place.roads.find((x) => x.id === road)!;
	const pts = r.points;
	const i = end === 'start' ? 0 : pts.length - 1;
	const dx = p.x - pts[i].x;
	const dy = p.y - pts[i].y;
	pts[i] = { ...pts[i], x: p.x, y: p.y };
	// Keep the curve's shape at this end by carrying its handle along.
	if (end === 'end' && pts[i].c2)
		pts[i] = { ...pts[i], c2: { x: pts[i].c2!.x + dx, y: pts[i].c2!.y + dy } };
	if (end === 'start' && pts[1]?.c1)
		pts[1] = { ...pts[1], c1: { x: pts[1].c1!.x + dx, y: pts[1].c1!.y + dy } };
}

const endPoint = (place: Place, road: string, end: End) => {
	const r = place.roads.find((x) => x.id === road)!;
	const p = end === 'start' ? r.points[0] : r.points[r.points.length - 1];
	return { x: p.x, y: p.y };
};

// The road ends that share a junction with this one (merged junctions
// count as one).
function neighbours(place: Place, road: string, end: End) {
	const { junctions } = effectiveJunctions(place, geosOf(place));
	const j = junctions.find((x) => x.ends.some((e) => e.road === road && e.end === end));
	return j ? j.ends.filter((e) => !(e.road === road && e.end === end)) : [];
}

// Make room for a moved road end: a neighbouring end it now overlaps or
// crowds is pulled back along its own road, or failing that carried along
// by the same move, so dragging a driveway along the street moves the gap
// in the street with it.
function makeRoom(
	place: Place,
	road: string,
	end: End,
	delta: Pt,
	scope: Set<string>,
	ok: () => boolean,
	depth = 0,
	root = road,
	// Ends of the road the dragged minor road joins: they only ever slide
	// along their own line.
	held = heldEnds(place, road, end)
) {
	if (ok()) return true;
	const geos = geosOf(place);
	for (const n of neighbours(place, road, end)) {
		// A minor road never bends the road it joins: those ends may only give
		// way along their own road.
		const fixedLine = held.has(`${n.road}:${n.end}`);
		if (ok()) return true;
		if (n.road === root || (scope.has(n.road) && depth > 0)) continue;
		scope.add(n.road);
		const r = place.roads.find((x) => x.id === n.road)!;
		const geo = geos.get(n.road)!;
		const start = endPoint(place, n.road, n.end);
		const saved = r.points.map((p) => ({ ...p }));
		const t =
			n.end === 'start'
				? (geo.path.pts[1] ?? geo.path.pts[0])
				: (geo.path.pts[geo.path.pts.length - 2] ?? start);
		const out = { x: t.x - start.x, y: t.y - start.y };
		const l = Math.hypot(out.x, out.y) || 1;
		let fixed = false;
		// A neighbour lying along the move gives way by pulling back along its
		// own road; one across it is carried along.
		const dl = Math.hypot(delta.x, delta.y) || 1;
		const along = Math.abs((out.x / l) * (delta.x / dl) + (out.y / l) * (delta.y / dl)) > 0.7;
		// Pulling back never shortens a road into a merge; the through road
		// beside a minor road keeps a piece long enough to stand on its own.
		const room = geo.path.length - (fixedLine ? SPLIT_GAP : 3);
		for (const back of along ? [0.25, 0.5, 1, 2, 3, 5, 8] : []) {
			if (back > room) break;
			place_(place, n.road, n.end, {
				x: start.x + (out.x / l) * back,
				y: start.y + (out.y / l) * back
			});
			if (!problems(place, new Set([n.road, road])).some((p) => mentions(p, n.road))) {
				fixed = true;
				break;
			}
		}
		const clear = () => !problems(place, new Set([n.road, road])).some((p) => mentions(p, n.road));
		const along_ = (out.x / l) * delta.x + (out.y / l) * delta.y;
		if (!fixed && !(fixedLine && along_ > room)) {
			// Carried along with the moved end, making room in turn. The road a
			// minor road joins only slides along its own line.
			const by = fixedLine ? { x: (out.x / l) * along_, y: (out.y / l) * along_ } : delta;
			if (fixedLine) place_(place, n.road, n.end, { x: start.x + by.x, y: start.y + by.y });
			else carry(place, n.road, n.end, start, by);
			const sub = new Set([n.road]);
			if (!clear() && depth < 2)
				makeRoom(place, n.road, n.end, by, sub, clear, depth + 1, root, held);
			for (const r of sub) scope.add(r);
			fixed = clear();
			if (!fixed) restoreRoad(place, n.road, saved);
		}
		// Last, a neighbour across the move may still clear by pulling back.
		for (const back of fixed || along || fixedLine ? [] : [0.5, 1, 2, 3, 5]) {
			if (back > room) break;
			place_(place, n.road, n.end, {
				x: start.x + (out.x / l) * back,
				y: start.y + (out.y / l) * back
			});
			if (clear()) {
				fixed = true;
				break;
			}
		}
		if (!fixed) restoreRoad(place, n.road, saved);
		void r;
	}
	return ok();
}

// The ends of the road that carries on through a junction with priority:
// a minor road (a driveway, a side street) dragged there never moves them
// sideways.
export function majorEnds(place: Place, road: string, end: End) {
	const geos = geosOf(place);
	const { junctions } = effectiveJunctions(place, geos);
	const j = junctions.find((x) => x.ends.some((e) => e.road === road && e.end === end));
	if (!j) return new Set<string>();
	const ends = endsOf(j, geos);
	const major = new Set<string>();
	for (const { pair, priority } of continuingPairs(ends, j.connections)) {
		if (priority) for (const e of pair) major.add(e.key);
	}
	return major;
}

// The through road's ends at the junction of a minor end; none if the end
// is itself on the through road.
function heldEnds(place: Place, road: string, end: End) {
	const major = majorEnds(place, road, end);
	return major.has(`${road}:${end}`) ? new Set<string>() : major;
}

// Where a minor road's end may go: never past the through road's curb (the
// street's edge, or a ring's outer edge, carried across the junction as a
// smooth curve between the through road's two ends), and for a road with no
// sidewalk of its own (a driveway) no more than half a metre out from it,
// or the junction would stretch into a funnel lined with sidewalk. An end
// already beyond either limit may stay where it is. Null for an end on the
// through road.
function sideBounds(place: Place, road: string, end: End) {
	const geos = geosOf(place);
	const { junctions } = effectiveJunctions(place, geos);
	const j = junctions.find((x) => x.ends.some((e) => e.road === road && e.end === end));
	return j ? boundsIn(place, j, endsOf(j, geos), `${road}:${end}`) : null;
}

function boundsIn(place: Place, j: Junction, ends: ReturnType<typeof endsOf>, key: string) {
	const held = new Set<string>();
	for (const { pair, priority } of continuingPairs(ends, j.connections))
		if (priority) for (const e of pair) held.add(e.key);
	if (held.has(key)) return null;
	const through = ends.filter((e) => held.has(e.key));
	const self = ends.find((e) => e.key === key);
	if (!self || through.length === 0) return null;
	const { road, end } = self.ref;
	const me = endPoint(place, road, end);
	const side = (e: (typeof ends)[number], q: Pt) =>
		(q.x - e.frame.p.x) * e.frame.n.x + (q.y - e.frame.p.y) * e.frame.n.y;
	const curb = (e: (typeof ends)[number]) => {
		const ways = e.lanes.filter((l) => isRoadway(l.lane));
		const edge =
			side(e, me) >= 0
				? Math.max(...ways.map((l) => l.right))
				: Math.min(...ways.map((l) => l.left));
		return { x: e.frame.p.x + e.frame.n.x * edge, y: e.frame.p.y + e.frame.n.y * edge };
	};
	const far = 60;
	const [a, b] = through;
	const pa = curb(a);
	const da = { x: -a.frame.out.x, y: -a.frame.out.y };
	let line: Pt[];
	if (!b) {
		line = [
			{ x: pa.x - da.x * far, y: pa.y - da.y * far },
			{ x: pa.x + da.x * far, y: pa.y + da.y * far }
		];
	} else {
		const pb = curb(b);
		const db = b.frame.out;
		const cross = da.x * db.y - da.y * db.x;
		const rx = pb.x - pa.x;
		const ry = pb.y - pa.y;
		const sAt = Math.abs(cross) > 1e-6 ? (rx * db.y - ry * db.x) / cross : -1;
		const tAt = Math.abs(cross) > 1e-6 ? (da.x * ry - da.y * rx) / cross : -1;
		const mid: Pt[] = [];
		if (sAt > 0 && tAt > 0) {
			const c = { x: pa.x + da.x * sAt, y: pa.y + da.y * sAt };
			for (let k = 1; k < 16; k++) {
				const t = k / 16;
				const u = 1 - t;
				mid.push({
					x: u * u * pa.x + 2 * u * t * c.x + t * t * pb.x,
					y: u * u * pa.y + 2 * u * t * c.y + t * t * pb.y
				});
			}
		}
		line = [
			{ x: pa.x - da.x * far, y: pa.y - da.y * far },
			pa,
			...mid,
			pb,
			{ x: pb.x + db.x * far, y: pb.y + db.y * far }
		];
	}
	// Signed distance from that curb line, positive on the minor road's side.
	const raw = (q: Pt) => {
		let best = { d: Infinity, s: 0 };
		for (let i = 1; i < line.length; i++) {
			const p0 = line[i - 1];
			const p1 = line[i];
			const dx = p1.x - p0.x;
			const dy = p1.y - p0.y;
			const l2 = dx * dx + dy * dy || 1;
			const f = Math.max(0, Math.min(1, ((q.x - p0.x) * dx + (q.y - p0.y) * dy) / l2));
			const fx = p0.x + dx * f;
			const fy = p0.y + dy * f;
			const d = Math.hypot(q.x - fx, q.y - fy);
			if (d < best.d) best = { d, s: Math.sign(dx * (q.y - p0.y) - dy * (q.x - p0.x)) || 1 };
		}
		return best;
	};
	const pts = self.geo.path.pts;
	const inward =
		self.ref.end === 'start' ? pts[Math.min(pts.length - 1, 3)] : pts[Math.max(0, pts.length - 4)];
	const outside = raw(inward).s;
	const dist = (q: Pt) => {
		const r = raw(q);
		return r.d * (r.s === outside ? 1 : -1);
	};
	// The end's mouth corners: the whole mouth has to stay out of the
	// through road, not just its middle.
	const corners = [
		Math.min(...self.lanes.map((l) => l.left)),
		Math.max(...self.lanes.map((l) => l.right))
	].map((o) => ({ x: self.frame.n.x * o, y: self.frame.n.y * o }));
	const inside = (q: Pt) =>
		Math.min(dist(q), ...corners.map((c) => dist({ x: q.x + c.x, y: q.y + c.y })));
	const now = { in: inside(me), out: dist(me) };
	const rigid = !self.lanes.some((l) => isWalk(l.lane));
	// Where an end first sat counts as allowed, so it can always go back.
	place.reach ??= {};
	// Per junction: merging or splitting junctions changes the road joined.
	const reachKey = `${j.id}|${key}`;
	place.reach[reachKey] ??= { in: now.in, out: now.out };
	const reach = place.reach[reachKey];
	const least = Math.min(reach.in, 0);
	const most = rigid ? Math.max(reach.out, 0.5) : Infinity;
	return {
		rigid,
		// How far the mouth is out from the through road's edge (negative:
		// past it, into the through road), and how far it may go in.
		out: now.in,
		least,
		allowed: (q: Pt) => {
			const d = dist(q);
			return inside(q) >= least - 1e-6 && d <= most + 1e-6;
		}
	};
}

// The furthest point toward `target`, straight along the pointer's line,
// that the bounds allow: a clamp shortens a drag, it never turns it.
function clampAlong(from: Pt, target: Pt, allowed: (q: Pt) => boolean) {
	if (allowed(target)) return target;
	const at = (f: number) => ({
		x: from.x + (target.x - from.x) * f,
		y: from.y + (target.y - from.y) * f
	});
	let lo = 0;
	let hi = 1;
	for (let k = 0; k < 24; k++) {
		const mid = (lo + hi) / 2;
		if (allowed(at(mid))) lo = mid;
		else hi = mid;
	}
	return at(lo);
}

// Slides the through road's ends along their own line with a minor end that
// moves along it, so the gap in the street travels with a driveway instead
// of stretching. An end that can't follow stays.
function slideHeld(place: Place, road: string, end: End, delta: Pt) {
	const geos = geosOf(place);
	const held = heldEnds(place, road, end);
	// Only for a road that meets the street across it; one running alongside
	// it (half of a split) has no gap in the street to carry.
	const own = geos.get(road)!.path.pts;
	const ownDir = end === 'start' ? [own[0], own[1]] : [own[own.length - 1], own[own.length - 2]];
	const ol = Math.hypot(ownDir[1].x - ownDir[0].x, ownDir[1].y - ownDir[0].y) || 1;
	for (const n of neighbours(place, road, end)) {
		if (!held.has(`${n.road}:${n.end}`)) continue;
		const geo = geos.get(n.road)!;
		const np = geo.path.pts;
		const nd = n.end === 'start' ? [np[0], np[1]] : [np[np.length - 1], np[np.length - 2]];
		const nl = Math.hypot(nd[1].x - nd[0].x, nd[1].y - nd[0].y) || 1;
		const along =
			((ownDir[1].x - ownDir[0].x) * (nd[1].x - nd[0].x) +
				(ownDir[1].y - ownDir[0].y) * (nd[1].y - nd[0].y)) /
			(ol * nl);
		if (Math.abs(along) > 0.9) continue;
		const start = endPoint(place, n.road, n.end);
		const pts = geo.path.pts;
		const t = n.end === 'start' ? (pts[1] ?? pts[0]) : (pts[pts.length - 2] ?? start);
		const l = Math.hypot(t.x - start.x, t.y - start.y) || 1;
		const out = { x: (t.x - start.x) / l, y: (t.y - start.y) / l };
		const by = out.x * delta.x + out.y * delta.y;
		if (Math.abs(by) < 1e-6 || (by > 0 && by > geo.path.length - SPLIT_GAP)) continue;
		const before = new Set(problems(place, new Set([n.road])));
		for (const f of [1, 0.75, 0.5, 0.25, 0]) {
			place_(place, n.road, n.end, { x: start.x + out.x * by * f, y: start.y + out.y * by * f });
			const now = problems(place, new Set([n.road]));
			if (f === 0 || !now.some((p) => !before.has(p) && mentions(p, n.road))) break;
		}
	}
}

// Carries a neighbouring road end by `delta`. A road whose other end is
// free moves whole, so it doesn't tilt; one tied at both ends just has this
// end moved.
function carry(place: Place, road: string, end: End, from: Pt, delta: Pt) {
	const r = place.roads.find((x) => x.id === road)!;
	const otherTied = place.junctions.some((j) =>
		j.ends.some((e) => e.road === road && e.end === (end === 'start' ? 'end' : 'start'))
	);
	if (otherTied) {
		place_(place, road, end, { x: from.x + delta.x, y: from.y + delta.y });
		return;
	}
	const i = end === 'start' ? 0 : r.points.length - 1;
	const shift = { x: from.x + delta.x - r.points[i].x, y: from.y + delta.y - r.points[i].y };
	r.points = r.points.map((p) => ({
		...p,
		x: p.x + shift.x,
		y: p.y + shift.y,
		c1: p.c1 ? { x: p.c1.x + shift.x, y: p.c1.y + shift.y } : undefined,
		c2: p.c2 ? { x: p.c2.x + shift.x, y: p.c2.y + shift.y } : undefined
	}));
}

const mentions = (problem: string, road: string) =>
	problem.includes(`${road}'s`) ||
	problem.includes(`overlaps ${road}`) ||
	problem.startsWith(`${road}:`) ||
	problem.includes(` ${road}:start`) ||
	problem.includes(` ${road}:end`);

function restoreRoad(place: Place, road: string, points: Place['roads'][number]['points']) {
	place.roads.find((x) => x.id === road)!.points = points.map((p) => ({ ...p }));
}

// One step of a drag: toward `target`, as far as it stays valid, making
// room among its neighbours. Returns where it ended up. Problems the place
// already had don't block the move.
function stepEnd(place: Place, road: string, end: End, target: Pt) {
	const from = endPoint(place, road, end);
	const saved = place.roads.map((r) => r.points.map((p) => ({ ...p })));
	const restore = () => place.roads.forEach((r, i) => (r.points = saved[i].map((p) => ({ ...p }))));
	// Everything the move can touch: this road and the roads sharing its
	// junction.
	const near = new Set([road, ...neighbours(place, road, end).map((n) => n.road)]);
	const before = new Set(problems(place, near));
	const rigid = sideBounds(place, road, end)?.rigid ?? false;
	const attempt = (f: number) => tryAt(f, true) || tryAt(f, false);
	const tryAt = (f: number, pull: boolean) => {
		restore();
		const at = { x: from.x + (target.x - from.x) * f, y: from.y + (target.y - from.y) * f };
		// A road with no sidewalk of its own (a driveway) joining a through
		// road moves whole when its far end is free, so it slides along the
		// street square to the curb instead of swinging round.
		if (rigid) carry(place, road, end, from, { x: at.x - from.x, y: at.y - from.y });
		else place_(place, road, end, at);
		// The end of a merged link is inside one junction: dragging it pulls the
		// junction at that end along (that's how two merged junctions come
		// apart again), unless that doesn't fit and the end alone does.
		if (pull && place.merged?.includes(road)) {
			const own = place.junctions.find((j) => j.ends.some((e) => e.road === road && e.end === end));
			for (const e of own?.ends ?? []) {
				if (e.road === road) continue;
				const p0 = saved[place.roads.findIndex((r) => r.id === e.road)];
				const q = e.end === 'start' ? p0[0] : p0[p0.length - 1];
				carry(place, e.road, e.end, { x: q.x, y: q.y }, { x: at.x - from.x, y: at.y - from.y });
			}
		}
		// Left behind, a merged link's junction mustn't come apart: only the
		// pull splits merged junctions.
		if (
			!pull &&
			place.merged?.includes(road) &&
			!effectiveJunctions(place, geosOf(place)).hidden.has(road)
		)
			return false;
		slideHeld(place, road, end, { x: at.x - from.x, y: at.y - from.y });
		const scope = new Set([road]);
		const ok = () => problems(place, scope).every((p) => before.has(p));
		return (
			makeRoom(place, road, end, { x: at.x - from.x, y: at.y - from.y }, scope, ok) &&
			problems(place, near).every((p) => before.has(p))
		);
	};
	let lo = 0;
	if (attempt(1)) lo = 1;
	else {
		let hi = 1;
		for (let k = 0; k < 7; k++) {
			const mid = (lo + hi) / 2;
			if (attempt(mid)) lo = mid;
			else hi = mid;
		}
		attempt(lo);
	}
	return { x: from.x + (target.x - from.x) * lo, y: from.y + (target.y - from.y) * lo };
}

// A drag toward `target`, taken in short steps like a pointer would, so the
// neighbours make room as the end goes and merges settle along the way.
function moveOnce(place: Place, road: string, end: End, target: Pt) {
	const from = endPoint(place, road, end);
	// A minor road's end stays at the road it joins, and never drags its
	// junction into another one.
	const bounds = sideBounds(place, road, end);
	if (bounds) target = clampAlong(from, target, bounds.allowed);
	const minor = heldEnds(place, road, end).size > 0;
	const mergedBefore = new Set(place.merged ?? []);
	const newMerge = () => minor && (place.merged ?? []).some((r) => !mergedBefore.has(r));
	const total = Math.hypot(target.x - from.x, target.y - from.y);
	// Straight there if the end can be there, whatever lies in between.
	const saved = place.roads.map((r) => r.points.map((p) => ({ ...p })));
	const fine0 = new Set(problems(place));
	const merged0 = place.merged;
	const direct = stepEnd(place, road, end, target);
	if (Math.hypot(direct.x - target.x, direct.y - target.y) < 1e-6) {
		settleMerges(place);
		if (problems(place).every((p) => fine0.has(p)) && !newMerge()) return direct;
	}
	place.roads.forEach((r, i) => (r.points = saved[i].map((p) => ({ ...p }))));
	place.merged = merged0;
	const steps = Math.max(1, Math.ceil(total / 0.5));
	let at = from;
	// Whatever a step does, the place as a whole must stay as valid as it was.
	const fine = new Set(problems(place));
	for (let k = 1; k <= steps; k++) {
		const want = {
			x: from.x + ((target.x - from.x) * k) / steps,
			y: from.y + ((target.y - from.y) * k) / steps
		};
		const before = place.roads.map((r) => r.points.map((p) => ({ ...p })));
		const merged = place.merged;
		const got = stepEnd(place, road, end, want);
		settleMerges(place);
		if (problems(place).some((p) => !fine.has(p)) || newMerge()) {
			place.roads.forEach((r, i) => (r.points = before[i]));
			place.merged = merged;
			break;
		}
		const progressed = Math.hypot(got.x - at.x, got.y - at.y) > 1e-3;
		at = got;
		if (!progressed) break;
	}
	return at;
}

// Remembers which short links are merged, so merging and splitting have
// some give (see merge.ts).
export function settleMerges(place: Place) {
	place.merged = [...effectiveJunctions(place, geosOf(place)).hidden];
}

// The page and the tests move ends through the same drag.
export const moveEnd = dragEnd;

// Whether a target for a road end really is out of bounds: inside its
// junction, or putting the road across another road or an island. A drag
// that falls short of a target that isn't is a frozen drag.
export function blockedTarget(place: Place, road: string, end: End, target: Pt) {
	// Shared with the trial below, so both judge ends by where they began.
	place.reach ??= {};
	const geos = geosOf(place);
	const { junctions } = effectiveJunctions(place, geos);
	const j = junctions.find((x) => x.ends.some((e) => e.road === road && e.end === end));
	if (j) {
		const outline = outlineOf(j, endsOf(j, geos));
		if (inside(offset(union([toPath(outline.polygon)]), -0.3), target))
			return 'inside the junction';
	}
	const bounds = sideBounds(place, road, end);
	if (bounds && !bounds.allowed(target)) return 'a side road stays at the road it joins';
	const near = new Set([road, ...(j?.ends.map((e) => e.road) ?? [])]);
	const before = new Set(problems(place, near));
	const trial: Place = {
		...place,
		roads: place.roads.map((r) => ({ ...r, points: r.points.map((p) => ({ ...p })) }))
	};
	place_(trial, road, end, target);
	// The end itself lands on another road.
	for (const r of place.roads) {
		if (r.id === road) continue;
		const g = geos.get(r.id)!;
		if (inside(offset(footprint(g, isRoadway), -0.3), target)) return `on ${r.id}`;
	}
	for (const p of problems(trial, near).filter((x) => !before.has(x))) {
		if (p.includes('lanes over an island')) return p;
		if (/overlaps (\S+)$/.test(p)) return p;
		if (p.includes('passed each other') || p.includes('points into the junction')) return p;
		// The junction would pave over a road's sidewalk: the end has been
		// pushed across a neighbouring road.
		if (p.includes('outline over')) return p;
		if (p.includes('past the edge')) return p;
	}
	return null;
}

type Points = Place['roads'][number]['points'];
const clonePoints = (points: Points): Points =>
	points.map((p) => ({
		...p,
		c1: p.c1 ? { ...p.c1 } : undefined,
		c2: p.c2 ? { ...p.c2 } : undefined
	}));
const samePoints = (a: Points, b: Points) =>
	a.length === b.length &&
	a.every(
		(p, i) =>
			p.x === b[i].x &&
			p.y === b[i].y &&
			p.c1?.x === b[i].c1?.x &&
			p.c1?.y === b[i].c1?.y &&
			p.c2?.x === b[i].c2?.x &&
			p.c2?.y === b[i].c2?.y
	);

// One drag of a road end toward `target`. Roads it pushes aside remember the
// shape they had, and go back to it as soon as it fits again, so dragging
// an end out and back leaves its neighbours where they were.
export function dragEnd(place: Place, road: string, end: End, target: Pt) {
	const start = place.roads.map((r) => clonePoints(r.points));
	const rest: Record<string, Points> = { ...(place.rest ?? {}) };
	// The road being dragged takes the shape it is given.
	delete rest[road];
	// Dragging a merged link's end carries its junction's other ends with it
	// on purpose: those aren't pushed aside.
	const carried = new Set<string>();
	if (place.merged?.includes(road))
		for (const j of place.junctions)
			if (j.ends.some((e) => e.road === road && e.end === end))
				for (const e of j.ends) carried.add(e.road);
	const got = moveOnce(place, road, end, target);
	place.roads.forEach((r, i) => {
		if (r.id === road || carried.has(r.id) || rest[r.id]) return;
		if (!samePoints(r.points, start[i])) rest[r.id] = start[i];
	});
	// Put pushed roads back, over and over while that frees room for others.
	for (let progress = true; progress; ) {
		progress = false;
		for (const [id, home] of Object.entries(rest)) {
			const r = place.roads.find((x) => x.id === id);
			if (!r || samePoints(r.points, home)) {
				delete rest[id];
				continue;
			}
			const was = r.points;
			const merged = place.merged;
			const before = new Set(problems(place));
			r.points = clonePoints(home);
			settleMerges(place);
			if (problems(place).some((p) => !before.has(p))) {
				r.points = was;
				place.merged = merged;
			} else {
				delete rest[id];
				progress = true;
			}
		}
	}
	place.rest = rest;
	return got;
}

// The state a pointer drag starts from. Every frame of the drag is worked
// out afresh from it, so where the pointer is decides everything, and
// bringing the pointer back undoes the drag.
export function dragStart(place: Place) {
	return {
		points: place.roads.map((r) => clonePoints(r.points)),
		merged: place.merged ? [...place.merged] : undefined,
		rest: Object.fromEntries(Object.entries(place.rest ?? {}).map(([k, v]) => [k, clonePoints(v)]))
	};
}

export function dragFrom(
	place: Place,
	start: ReturnType<typeof dragStart>,
	road: string,
	end: End,
	target: Pt
) {
	place.roads.forEach((r, i) => (r.points = clonePoints(start.points[i])));
	place.merged = start.merged ? [...start.merged] : undefined;
	place.rest = Object.fromEntries(Object.entries(start.rest).map(([k, v]) => [k, clonePoints(v)]));
	return dragEnd(place, road, end, target);
}

// Road ends pushed past the through road's edge into it (a side street's
// end out in the street, an arm's end inside a roundabout's ring).
export function endsPastEdge(place: Place) {
	const out: string[] = [];
	for (const j of place.junctions)
		for (const e of j.ends) {
			const b = sideBounds(place, e.road, e.end);
			if (b && b.out < b.least - 0.05)
				out.push(`${e.road}:${e.end} ${(b.least - b.out).toFixed(2)} m`);
		}
	return out;
}
