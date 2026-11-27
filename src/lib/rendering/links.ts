// What the connection overlay shows (rendering/road-renderer.ts), read off a
// build as it stands while the overlay is on; nothing of it is stored. Blue
// is a way to drive, orange a way to walk, and every walking link a footpath
// has is shown:
//
// - `drive`: each car movement through a node, along the path it drives,
//   with a dot on each lane end it comes in or goes out by (`ends`).
// - `street`: a car piece's own ways to walk: a sidewalk carried through a
//   node of two sides (its walk paths), each corner sidewalk a junction
//   carries round its corners along its middle (NodeDescription.walkways),
//   across any road's mouth it crosses on the way, and every other crosswalk
//   of a street or junction along its line (Crossing.line; the pieces of a
//   footpath's crossing are drawn off the crossing instead, `cross`).
// - The footpaths' walking lines, each drawn only on ground a walker has:
//   a footpath's walk paving as it is laid over the cars, and a crossing's
//   paint (`walkable`). The lines are the model's, which walks a footpath
//   down the middle of its whole cross-section, verges and all: `strips`
//   are each strip's middle (middleOf), where it has a walk lane, up to
//   where a bend's line or an end's join line leaves it; `walk`, each way
//   through a footpath node (a bend, a joint) along its line as drawn
//   (NodeDescription.paths), where it has walk paving; `onto`, from each
//   footpath end lying on a walkway onto the walkway's middle
//   (Derived.sidewalks); and `cross`, one line for each run of a crossing
//   (Walking.runsOf), along the walker's way over it from where the
//   footpath's line reaches the asphalt to where it leaves it: along the
//   middles of the footpaths it joins as they sit across each run's band
//   (acrossOf), kept on its crossing's paint (painted). The lines of one footpath join up: the first three and the
//   last meet end to end at the curb.
//   Where runs of one footpath's crossings lie over one stretch of ground,
//   the first draws its line there and the others none (`lessLapped`), so
//   no two of a footpath's lines run side by side.
// - `joins`: an orange dot for every join of a footpath to a walkway
//   (joinsOf, deadEnds).
//
// The footpaths' part is read a footpath, a footpath node and a node's ends
// on walkways at a time (`unit`), each kept from read to read while what it
// is read from is the same object (the paving, crossings and join lines the
// build keeps while they stay the same) and the car pieces near it are, so a
// read after an edit works out only what lies near it.

import { WALK } from '../core/footpaths';
import type { Scene, WalkedCrossing, Walking } from '../core/networks';
import type { Derived } from '../core/place';
import {
	fromPath,
	inside,
	intersect,
	offset,
	offsetLine,
	type Paths,
	subtract,
	toPath,
	union
} from '../road-model/clip';
import type { Description, RoadDescription } from '../road-model/description';
import { cutLine, dist, mix } from '../road-model/geometry';
import { type Pt, walkwayId } from '../road-model/model';
import { type Box, BoxGrid, boxOf, shapeOf, type Under } from '../road-model/overlay';

export interface Links {
	drive: Pt[][];
	ends: { point: Pt; flow: 'in' | 'out' | 'both' }[];
	street: Pt[][];
	strips: Pt[][];
	walk: Pt[][];
	cross: Pt[][];
	onto: Pt[][];
	joins: Pt[];
}

type Read = Pick<Derived, 'sidewalks' | 'ends'>;

// The footpaths' lines and dots one unit adds.
interface Unit {
	strips: Pt[][];
	walk: Pt[][];
	cross: Pt[][];
	onto: Pt[][];
	joins: Pt[];
}

// What the overlay shows of a build, read whole.
export const linksOf = (scene: Scene, derived: Read) => new LinksReader().read(scene, derived);

// What the overlay shows of each build in turn, each footpath unit read again
// only where what it is read from changed.
export class LinksReader {
	private units = new Map<
		unknown,
		{ inputs: unknown[]; near: Map<Description, string>; out: Unit }
	>();

	// How many units it keeps from read to read (tests read it).
	get kept() {
		return this.units.size;
	}

	read(scene: Scene, derived: Read): Links {
		const out: Links = {
			drive: [],
			ends: [],
			street: [],
			strips: [],
			walk: [],
			cross: [],
			onto: [],
			joins: []
		};
		// A street's own crosswalks by their lines; a footpath's crossing
		// (Crossing.of) is drawn off its runs instead (`cross`).
		for (const road of scene.place.roads)
			for (const c of scene.road(road.id)?.crossings ?? []) if (!c.of) out.street.push(c.line);
		for (const j of scene.place.junctions) {
			if (j.id.startsWith(WALK)) continue;
			const node = scene.node(j.id);
			if (!node) continue;
			// Each corner sidewalk along its middle, any road's mouth it crosses
			// on the way included, so its crossing there draws no line of its
			// own.
			const corners = new Set((node.walkways ?? []).map((w) => walkwayId(w.a, w.b)));
			for (const w of node.walkways ?? []) out.street.push(w.line);
			for (const c of node.crossings) if (!c.of && !corners.has(c.id)) out.street.push(c.line);
			for (const p of node.paths) {
				if (p.kind === 'drive') out.drive.push(p.line);
				else if (p.kind === 'walk') out.street.push(p.line);
			}
			for (const l of node.ends.flatMap((e) => e.lanes))
				if (l.flow !== 'none') out.ends.push({ point: l.point, flow: l.flow });
		}
		const walking = scene.walking();
		// A car piece by its id, as drawn.
		const drawnAs = (id: string): Description | undefined => scene.road(id) ?? scene.node(id);
		// Each car road's dead ends (a node it alone ends at), by its id.
		const deadAt = new Map<string, string>();
		for (const here of derived.ends.values())
			if (here.length === 1) {
				const id = here[0].geo.road.id;
				deadAt.set(id, [deadAt.get(id), here[0].end].filter(Boolean).join());
			}
		const dead = (d: Description) => deadAt.get(walking.idOf(d) ?? '') ?? '';
		const seen = new Set<unknown>();
		const units: Unit[] = [];
		// Each footpath node's bend or joint, by its own paving.
		const fillsOf = new Map<Description, Box>();
		// A unit read off `inputs` and the car pieces within READ of its lines
		// and paving (`lines`, `boxes`), all it reads of them, kept while each
		// is the same object.
		const unit = (
			key: unknown,
			inputs: unknown[],
			lines: Pt[][],
			boxes: Box[],
			make: () => Unit
		) => {
			seen.add(key);
			const near = new Map<Description, string>();
			for (const box of [
				...lines.flatMap(piecesOf).map((p) => boxOf(p, READ)),
				...boxes.map(([x0, y0, x1, y1]): Box => [x0 - READ, y0 - READ, x1 + READ, y1 + READ])
			])
				for (const d of walking.near(box)) near.set(d, dead(d));
			const was = this.units.get(key);
			const same =
				was &&
				was.inputs.length === inputs.length &&
				was.inputs.every((x, k) => x === inputs[k]) &&
				was.near.size === near.size &&
				[...near].every(([d, ends]) => was.near.get(d) === ends);
			const result = same ? was.out : make();
			if (!same) this.units.set(key, { inputs, near, out: result });
			units.push(result);
		};
		for (const road of scene.place.roads) {
			const id = road.id;
			const nodes = scene.footpathNodes(id);
			const [strip, ...atNodes] = scene.footpathPaving(id);
			const own = strip?.description;
			if (!nodes || !own || 'outline' in own) continue;
			for (const fill of atNodes) fillsOf.set(fill.description, fill.box);
			const middle = middleOf(own);
			const fills = nodes.map((n) => (scene.footpathBend(n) ? scene.node(WALK + n) : undefined));
			const onWalk = nodes.map((n) => derived.sidewalks.get(n));
			const held = walking.runsOf(id);
			// The car pieces its crossings are laid on, as drawn with their paint.
			const paintedOn = held.map((h) => h.on.flatMap((p) => drawnAs(p.piece) ?? []));
			// The strips of the footpaths of its crossings, down whose middles
			// their lines across run (acrossOf).
			const crossers = [...new Set(held.flatMap((h) => h.segments))].map(
				(s) => [s, scene.footpathPaving(s)[0]?.description] as const
			);
			// Each crossing's line, in pieces: each run's across its band
			// (acrossOf), kept on the asphalt and on its paint (painted).
			const across = () => {
				const of = new Map(
					crossers.map(([s, d]): [string, Crosser[]] => [
						s,
						d && !('outline' in d)
							? [{ edges: [d.edges[0], d.edges.at(-1)!], middle: middleOf(d) }]
							: []
					])
				);
				return held.flatMap((h, k) => {
					const near = h.segments.flatMap((s) => of.get(s) ?? []);
					const lines = h.bands.map((band) =>
						acrossOf(band, near, (line) => walkable(line, walking, true))
					);
					const paint = painted(h, paintedOn[k]);
					return lines.map((line) =>
						walkable(line, walking, true).flatMap((piece) => within(piece, paint, TOUCH))
					);
				});
			};
			unit(
				`strip:${id}`,
				[own, ...fills, ...onWalk, held, ...crossers.map(([, d]) => d), ...paintedOn.flat()],
				middle ? [middle] : [],
				[
					strip.box,
					...held.flatMap((h) => [...h.bands, h.rings.flatMap(fromPath)].map((b) => boxOf(b)))
				],
				() => {
					// The strip's line up to where a bend's line or an end's line
					// onto a walkway leaves it at either node.
					let line = middle;
					nodes.forEach((n, k) => {
						const leaves: Pt[] = [];
						for (const p of fills[k]?.paths ?? []) {
							if (p.from.road === id) leaves.push(p.line[0]);
							if (p.to.road === id) leaves.push(p.line.at(-1)!);
						}
						for (const on of onWalk[k] ?? []) if (on.path === id) leaves.push(on.line[0]);
						for (const p of leaves)
							if (line) line = k ? cutAt(line, p) : cutAt([...line].reverse(), p).reverse();
					});
					const strips = line ? onPaving(walkable(line, walking, false), own, walking) : [];
					const cross: Pt[][] = [];
					for (const pieces of across()) cross.push(...lessLapped(pieces, cross));
					const arrivals = onWalk.flatMap((here) =>
						(here ?? []).filter((on) => on.path === id).map((on) => on.line.at(-1)!)
					);
					const joins = joinsOf([...strips, ...cross], walking);
					const paving = walkPaving(own);
					joins.push(...deadEnds(paving, dead, [...joins, ...arrivals], walking));
					return { strips, walk: [], cross, onto: [], joins };
				}
			);
		}
		// Each footpath node's bend or joint, by its own paving: its lines
		// through, and the sidewalks its paving reaches at a car road's dead end.
		for (const [fill, box] of fillsOf) {
			if (!('outline' in fill)) continue;
			const paving = walkPaving(fill);
			const paths = paving.length
				? fill.paths.filter((p) => p.kind === 'walk').map((p) => p.line)
				: [];
			unit(fill, [], paths, [box], () => {
				const walk = paths.flatMap((line) => walkable(line, walking, false));
				const joins = joinsOf(walk, walking);
				joins.push(...deadEnds(paving, dead, joins, walking));
				return { strips: [], walk, cross: [], onto: [], joins };
			});
		}
		// Each node's ends on walkways: each one's line onto its walkway, and
		// a dot where it arrives.
		for (const [node, here] of derived.sidewalks) {
			const lines = here.map((on) => on.line);
			unit(`onto:${node}`, [here], lines, [], () => {
				const onto = lines.flatMap((line) => walkable(line, walking, false));
				const joins = [...lines.map((line) => line.at(-1)!), ...joinsOf(onto, walking)];
				return { strips: [], walk: [], cross: [], onto, joins };
			});
		}
		for (const key of [...this.units.keys()]) if (!seen.has(key)) this.units.delete(key);
		for (const u of units) {
			out.strips.push(...u.strips);
			out.walk.push(...u.walk);
			out.cross.push(...u.cross);
			out.onto.push(...u.onto);
			for (const p of u.joins) if (!out.joins.some((q) => dist(p, q) < JOIN)) out.joins.push(p);
		}
		return out;
	}
}

// A run's line across its roadway, meeting the line of the footpath coming
// in at each end where that line reaches the asphalt at the curb. A band
// (bandOf in core/runs.ts) is its two sides point for point, each from past
// the curb at one end, through where it meets each curb, to past the curb at
// the other, as wide at each end as the footpath coming in there. Of the
// footpaths of the run's crossing (`crossers`: each one's two outer edges
// and its middle, middleOf), the one coming in at an end is the one whose
// edges lie nearest the band's sides there. The line across runs down that
// footpath's middle from past the curb to where it reaches the asphalt
// (`onAsphalt`, the pieces of a line on it, as the strip's own line is cut
// there: walkable), so the two meet at that point; then from the band's
// next point on, at the fraction of the way across the band the footpath's
// middle crosses it at the curb, easing to the other end's. An end no
// footpath's middle comes in at is crossed at the band's middle.
export function acrossOf(band: Pt[], crossers: Crosser[], onAsphalt: (line: Pt[]) => Pt[][]) {
	const n = band.length / 2;
	const [left, right] = [band.slice(0, n), band.slice(n).reverse()];
	// How far across the band at point k a line crosses it (reaching on a
	// quarter of its width past either side, for an edge of the band's
	// width), and where.
	const fraction = (w: Pt[], k: number) => {
		const [a, b] = [left[k], right[k]];
		const at = crossAt(w, mix(a, b, -0.25), mix(a, b, 1.25));
		if (!at) return null;
		const [dx, dy] = [b.x - a.x, b.y - a.y];
		return { f: ((at.p.x - a.x) * dx + (at.p.y - a.y) * dy) / (dx * dx + dy * dy || 1), ...at };
	};
	// The footpath coming in at the end whose point past the curb is `out`:
	// its middle from there to the asphalt, the band's point the line runs on
	// from (`k`, no further than the other curb's, `to`) and its fraction
	// across there.
	const end = (out: number, to: number) => {
		const step = Math.sign(to - out);
		const across = { own: [mix(left[out], right[out], 0.5)], k: out + step, f: 0.5 };
		let best: { crosser: Crosser; off: number } | null = null;
		for (const crosser of crossers) {
			const e = crosser.edges.map((w) => fraction(w, out));
			if (!e[0] || !e[1]) continue;
			const [lo, hi] = [Math.min(e[0].f, e[1].f), Math.max(e[0].f, e[1].f)];
			const off = Math.abs(lo) + Math.abs(hi - 1);
			if (!best || off < best.off) best = { crosser, off };
		}
		const w = best?.crosser.middle;
		const [from, next] = w ? [fraction(w, out), fraction(w, out + step)] : [null, null];
		if (!w || !from || !next) return across;
		// The middle on from `from` the way it goes into the band.
		const ahead =
			from.i < next.i ||
			(from.i === next.i && dist(w[from.i - 1], from.p) <= dist(w[from.i - 1], next.p));
		const into = ahead ? [from.p, ...w.slice(from.i)] : [from.p, ...w.slice(0, from.i).reverse()];
		const reach = onAsphalt(into)[0]?.[0];
		const own = reach ? cutAt(into, reach) : [from.p];
		const past = reach ? lengthTo(into, reach) : 0;
		for (let k = out + step; k !== to + step; k += step) {
			const at = fraction(w, k);
			if (at && lengthTo(into, at.p) > past + 0.01) return { own, k, f: next.f };
		}
		return across;
	};
	const [a, b] = [end(0, n - 2), end(n - 1, 1)];
	// The band's points between, where the two ends leave some; where they
	// pass each other, straight from the one to the other.
	const between = Array.from({ length: Math.max(0, b.k - a.k + 1) }, (_, i) =>
		mix(left[a.k + i], right[a.k + i], a.f + ((b.f - a.f) * i) / (b.k - a.k || 1))
	);
	return [...a.own, ...between, ...[...b.own].reverse()];
}

// How far along a line the point of it nearest p lies.
function lengthTo(line: Pt[], p: Pt) {
	let best = { d: Infinity, at: 0 };
	let run = 0;
	for (let k = 1; k < line.length; k++) {
		const q = foot(p, line[k - 1], line[k]);
		const d = dist(p, q);
		if (d < best.d) best = { d, at: run + dist(line[k - 1], q) };
		run += dist(line[k - 1], line[k]);
	}
	return best.at;
}

// A footpath of a crossing as acrossOf reads it: its strip's outer edges and
// its middle (middleOf).
export interface Crosser {
	edges: [Pt[], Pt[]];
	middle: Pt[] | null;
}

// Where a line first crosses the segment from a to b: the point, and the
// index of the line's point it crosses before.
function crossAt(line: Pt[], a: Pt, b: Pt) {
	for (let i = 1; i < line.length; i++) {
		const p = meet(line[i - 1], line[i], a, b);
		if (p) return { i, p };
	}
	return null;
}

// The pieces of a walking line on a walker's ground. Of the ground the cars
// draw, a footpath laid over car lanes or a median is drawn nothing of
// (asphaltOf in road-model/overlay.ts, as layOver lays it): there a walker
// has a crossing's paint alone, and everywhere else the footpath's own
// paving, the sidewalk it lies on or the walk paving it lays over a verge.
// So a footpath's own line (`crossing` false) is kept off the asphalt, and a
// crossing's line (which reaches a little on past each curb) on it, and then
// on its paint (painted). Both read one region, the asphalt
// grown by EDGE, so they meet where they cross its edge, and a crossing's
// line lying along the asphalt's edge (a path straight across a dead end,
// along the road's end) is the crossing's alone.
function walkable(line: Pt[], walking: Walking, crossing: boolean) {
	const near = new Set<Description>();
	for (const piece of piecesOf(line)) for (const d of walking.near(boxOf(piece))) near.add(d);
	// Only what lies round the line, so a long road costs a short line little.
	const around = [boxPath(boxOf(line, 1))];
	const asphalt = intersect(
		around,
		[...near].flatMap((d) => grownAsphalt(d, walking))
	);
	if (!asphalt.length) return crossing ? [] : [line];
	return crossing ? within(line, asphalt) : outside(line, asphalt);
}

// A strip's own lines kept to where there is paving under them: its own
// walk paving (`own`) and that of
// the car pieces near the line (a sidewalk it lies on), grown by EDGE. A
// strip whose curve hooks back at its tip is paved short of where its
// middle line ends, and no line runs on past the paving there.
function onPaving(lines: Pt[][], own: Description, walking: Walking) {
	return lines.flatMap((line) => {
		const near = new Set<Description>([own]);
		for (const piece of piecesOf(line)) for (const d of walking.near(boxOf(piece))) near.add(d);
		const paving = offset(union([...near].flatMap(walkPaving)), EDGE);
		return within(line, paving, TOUCH);
	});
}

// A box as a path.
const boxPath = ([x0, y0, x1, y1]: Box) =>
	toPath([
		{ x: x0, y: y0 },
		{ x: x1, y: y0 },
		{ x: x1, y: y1 },
		{ x: x0, y: y1 }
	]);

// What of a car piece a footpath laid over it is drawn nothing of, as layOver
// in road-model/overlay.ts lays it: its car lanes, a node's paving and its
// medians.
const asphaltOf = (u: Under) => [...u.hard, ...u.median];

// A car piece's asphalt (asphaltOf) grown by EDGE, once for each
// description: the asphalt near a line is these together.
const grownOf = new WeakMap<Description, Paths>();
function grownAsphalt(d: Description, walking: Walking) {
	let grown = grownOf.get(d);
	if (!grown) grownOf.set(d, (grown = offset(union(asphaltOf(walking.under(d))), EDGE)));
	return grown;
}

// The pieces of a line inside some ground, and outside it, each a
// millimetre long (Clipper's unit, or `least`) or more.
const within = (line: Pt[], ground: Paths, least = 0.001) =>
	cutLine(line, ground.map(fromPath))
		.filter(({ along }) => along.at(-1)! - along[0] >= least)
		.map((piece) => piece.line);
function outside(line: Pt[], ground: Paths) {
	return within(line, subtract([boxPath(boxOf(line, 1))], ground));
}

// A run's line (its pieces) less where it runs along a line drawn before it
// of the same footpath's crossings, within ALONG of it for LAP or more: two
// runs over one stretch of ground (two roads meeting at a bend, each with a
// run across) draw one line there. Lines fanning
// out from one point stay whole.
function lessLapped(pieces: Pt[][], drawn: Pt[][]) {
	if (!drawn.length) return pieces;
	const by = union(drawn.flatMap((d) => offsetLine(d, ALONG)));
	const lapped = pieces
		.flatMap((p) => cutLine(p, by.map(fromPath)))
		.filter(({ along }) => along.at(-1)! - along[0] >= LAP)
		.flatMap(({ line }) => offsetLine(line, 2 * ALONG));
	if (!lapped.length) return pieces;
	const gone = union(lapped);
	return pieces.flatMap((p) => outside(p, gone));
}
const ALONG = 0.01;
const LAP = 1;

// How far past the asphalt's edge (m) a crossing's line is kept and a
// footpath's own line starts, and past its paint's edge a crossing's line is
// kept.
const EDGE = 0.002;

// The least piece of a crossing's line kept on its paint (m): a shorter one
// lies where the paint only touches the asphalt, both grown by EDGE.
const TOUCH = 0.01;

// Where a footpath's crossing is painted, grown by EDGE (so a line lying
// along the paint's edge is kept): what the car pieces it is laid on (`on`,
// as drawn) paint of its ground (WalkedCrossing.rings), its own crossings
// drawn there (Crossing.of) and any other's that took part of its ground by
// being drawn first (a street's own crosswalk, another footpath's crossing
// over the same ground: crossingsOver in road-model/overlay.ts).
function painted(h: WalkedCrossing, on: Description[]) {
	const paint = on
		.flatMap((d) => d.crossings)
		.flatMap((c) => [...c.body, ...c.runs.flatMap((r) => r.rings)].map(toPath));
	return offset(intersect(h.rings, union(paint)), EDGE);
}

// A line up to p, from the point of it nearest p.
function cutAt(line: Pt[], p: Pt) {
	let best = { d: Infinity, k: 0 };
	for (let k = 1; k < line.length; k++) {
		const d = dist(p, foot(p, line[k - 1], line[k]));
		if (d < best.d) best = { d, k };
	}
	return [...line.slice(0, best.k), p];
}

// The point of the segment from a to b nearest p.
function foot(p: Pt, a: Pt, b: Pt) {
	const [dx, dy] = [b.x - a.x, b.y - a.y];
	const t = Math.max(
		0,
		Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))
	);
	return { x: a.x + dx * t, y: a.y + dy * t };
}

// Where a footpath's walking lines (`lines`, the orange lines the overlay
// draws for it) cross the middle of a walkway (a car road's sidewalk or a
// walkway down its middle, a sidewalk a junction carries on or round a
// corner) where it is drawn, on the walkway's own surface: where a footpath
// passing over a walkway, which the build keeps no fact of, is joined to it.
//
// Each line is read in pieces about a grid cell long (`piecesOf`), and each
// piece reads the walkways' middles filed in the cells under it alone
// (middlesFiled), so a long path reads only what lies along it.
function joinsOf(lines: Pt[][], walking: Walking): Pt[] {
	const out: Pt[] = [];
	for (const piece of lines.flatMap(piecesOf)) {
		const box = boxOf(piece);
		for (const d of walking.near(box))
			for (const m of middlesFiled(d).near(box))
				for (let i = 1; i < piece.length; i++) {
					const p = meet(piece[i - 1], piece[i], m.a, m.b);
					if (p && (!m.on || inside(m.on, p))) out.push(p);
				}
	}
	return out;
}

// The segments of a car piece's walkways' middles (walkMiddles), filed by
// their boxes once for each description.
const filed = new WeakMap<Description, BoxGrid<Middle>>();
function middlesFiled(d: Description) {
	let grid = filed.get(d);
	if (grid) return grid;
	grid = new BoxGrid<Middle>(CELL);
	for (const { line: m, on } of walkMiddles(d))
		for (let j = 1; j < m.length; j++)
			grid.add(boxOf([m[j - 1], m[j]]), { a: m[j - 1], b: m[j], on });
	filed.set(d, grid);
	return grid;
}

// Where a footpath's paving (`paving`, its own walk paving) joins a car
// road's sidewalk at a dead end of the road (`dead`, the ends of a road's
// description that are), as the build joins them: a footpath paved across
// or past a road's end is laid over the sidewalks there and is them (layOver
// in road-model/overlay.ts), and a footpath node on the dead end holds them
// carried on past it (fillOf in core/footpaths.ts). The two pavings share an
// edge there: the stretch of the sidewalk's end (across it, from edge to
// edge) the footpath's paving reaches (within READ). A dot stands at the
// middle of each such stretch, unless the footpath is joined to that
// sidewalk already (a dot of its own, `have`, on that sidewalk's middle on
// its paving: a line crossing it, an end's line arriving).
function deadEnds(paving: Paths, dead: (d: Description) => string, have: Pt[], walking: Walking) {
	if (!paving.length) return [];
	const reach = offset(paving, READ);
	const out: Pt[] = [];
	for (const d of walking.near(boxOf(paving.flatMap(fromPath), READ))) {
		const ends = dead(d);
		if (!ends || 'outline' in d) continue;
		const road: RoadDescription = d;
		const walks = road.surfaces.filter((s) => s.role === 'walk');
		road.lanes.forEach((span, i) => {
			if (!walks.some((s) => s.lane?.lane === span.lane.id)) return;
			const middle = road.edges[i].map((p, k) => mix(p, road.edges[i + 1][k], 0.5));
			if (have.some((q) => offLine(q, middle) < 0.01 && inside(offset(reach, JOIN), q))) return;
			for (const end of ['start', 'end'] as const) {
				if (!ends.includes(end)) continue;
				const at = (edge: Pt[]) => (end === 'start' ? edge[0] : edge.at(-1)!);
				for (const shared of within([at(road.edges[i]), at(road.edges[i + 1])], reach))
					out.push(mix(shared[0], shared.at(-1)!, 0.5));
			}
		});
	}
	return out;
}
// How far (m) a footpath's links read beyond its own shape: its paving
// joins a sidewalk's end this near it (deadEnds), and the car pieces this
// near its lines and paving are all a unit reads (LinksReader).
const READ = 0.02;

// A footpath piece's walk paving.
const walkPaving = (d: Description) =>
	union(d.surfaces.filter((s) => s.role === 'walk').flatMap(shapeOf));

// How far p lies from a line.
function offLine(p: Pt, line: Pt[]) {
	let best = Infinity;
	for (let k = 1; k < line.length; k++)
		best = Math.min(best, dist(p, foot(p, line[k - 1], line[k])));
	return best;
}

// A line in pieces, each ending once it is a grid cell from where it
// starts, a segment longer than a cell cut into pieces a cell long.
function piecesOf(line: Pt[]) {
	const out = [[line[0]]];
	for (let i = 1; i < line.length; i++) {
		const n = Math.ceil(dist(line[i - 1], line[i]) / CELL) || 1;
		for (let k = 1; k <= n; k++) {
			const [piece, p] = [out.at(-1)!, mix(line[i - 1], line[i], k / n)];
			piece.push(p);
			if (dist(piece[0], p) >= CELL) out.push([p]);
		}
	}
	return out.filter((piece) => piece.length > 1);
}

// A join's dot's radius (m), drawn by the overlay: points nearer than this
// are one dot, so every point a dot stands for lies under it.
export const JOIN = 0.35;
// The side of the cells the walkways' middles are filed in (m).
const CELL = 16;

// One segment of a walkway's middle, and the surface it is drawn on where
// it may leave it.
interface Middle {
	a: Pt;
	b: Pt;
	on?: Paths;
}

// Where the segments from a to b and from c to d meet, ends included, if
// they do.
function meet(a: Pt, b: Pt, c: Pt, d: Pt) {
	const [dx, dy, ex, ey] = [b.x - a.x, b.y - a.y, d.x - c.x, d.y - c.y];
	const den = dx * ey - dy * ex;
	if (Math.abs(den) < 1e-12) return null;
	const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / den;
	const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / den;
	return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? mix(a, b, t) : null;
}

// A footpath strip's line down the middle of its whole cross-section, from
// its start to its end, as the model walks it (middleLine in core/
// footpaths.ts); none where it has no walk lane, as a strip of verge alone
// is not walked.
function middleOf(strip: RoadDescription) {
	const walks = strip.surfaces.filter((s) => s.role === 'walk');
	if (!strip.lanes.some((span) => walks.some((s) => s.lane?.lane === span.lane.id))) return null;
	return strip.edges[0].map((p, k) => mix(p, strip.edges.at(-1)![k], 0.5));
}

// The middle of each walkway a car piece draws: a road's walk lanes halfway
// between their edges, from its start to its end, on that lane's surface
// all along; a junction's sidewalks carried on through it or round a
// corner, along their walkers' lines (its walk `paths` and `walkways`),
// drawn where they lie on its walk surface. Read once for each description.
const middlesOf = new WeakMap<Description, { line: Pt[]; on?: Paths }[]>();
function walkMiddles(d: Description) {
	let out = middlesOf.get(d);
	if (out) return out;
	const walks = d.surfaces.filter((s) => s.role === 'walk');
	if ('outline' in d) {
		const on = walks.flatMap(shapeOf);
		out = [
			...d.paths.filter((p) => p.kind === 'walk').map((p) => p.line),
			...(d.walkways ?? []).map((w) => w.line)
		].map((line) => ({ line, on }));
	} else {
		const road: RoadDescription = d;
		out = road.lanes.flatMap((span, i) =>
			walks.some((s) => s.lane?.lane === span.lane.id)
				? [{ line: road.edges[i].map((p, k) => mix(p, road.edges[i + 1][k], 0.5)) }]
				: []
		);
	}
	middlesOf.set(d, out);
	return out;
}
