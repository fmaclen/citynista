// A network laid over the ones drawn before it (core/networks.ts): the
// footpaths over the car roads. Each network is built and drawn on its own;
// this is where the two meet, and the only way the one below learns of the
// one over it.
//
// A piece laid over (a footpath, or a node of footpaths) is drawn by its own
// network, then laid on the ground below (`layOver`): over a sidewalk it is
// that sidewalk, and nothing of its own is drawn there; over a verge it is
// walk paving; over car lanes or a median nothing of it is drawn. There a
// footpath is a crossing only where its run through a road's roadway enters
// it at one curb and leaves it at the other (core/runs.ts): its runs' bands (bandOf there, `crossedBy` here), whatever the
// footpath does at its nodes inside the roadway, which the pieces below draw
// (`crossingsOver`): a zebra over car lanes, a refuge on a median. So a
// footpath ended on a street stops at its curb or on its sidewalk, and one
// dipping into the roadway and back out on the side it entered is not drawn
// over the lanes. Paint is all the piece below takes from the one over it:
// its lines stop under a crossing (`clearOf`), and its approaches stop short
// of one (approach.ts, road.ts).

import {
	area,
	fromPath,
	inside,
	intersect,
	offset,
	type Paths,
	piecesOf,
	subtract,
	toPath,
	toRings,
	union
} from './clip';
import { LAP } from './corners';
import type { Crossing, Description, Marking, Surface } from './description';
import { cutLine, dist, dot, offsetPoint, pieceAt, quad } from './geometry';
import { type Control, isTravel, type Lane, type LaneRef, type Pt } from './model';
import { LINE, MIN_PIECE } from './paint';

// A box round some points, grown by `by`, and whether two boxes overlap.
export type Box = [number, number, number, number];
export const boxOf = (pts: Iterable<Pt>, by = 0): Box => {
	const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
	for (const p of pts) {
		if (p.x < box[0]) box[0] = p.x;
		if (p.y < box[1]) box[1] = p.y;
		if (p.x > box[2]) box[2] = p.x;
		if (p.y > box[3]) box[3] = p.y;
	}
	return [box[0] - by, box[1] - by, box[2] + by, box[3] + by];
};
export const overlap = (a: Box, b: Box) =>
	a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

// Things filed by the boxes round them, in the cells of a grid each box
// covers, so finding those whose boxes meet a box reads only the things in
// its cells. Kept from one build to the next: only things that come or go
// are filed or taken out, and each says where it was (`add`, `keepOnly`), so
// what lies near what changed is all that needs reading again.
export class BoxGrid<T> {
	private cells = new Map<number, Set<T>>();
	private boxes = new Map<T, Box>();
	constructor(private size = 64) {}

	// Each cell a box covers, by a number (cells within 2,000 km of the
	// origin each have their own).
	private cellsOf(box: Box, each: (cell: number) => void) {
		const [x0, y0, x1, y1] = box.map((v) => Math.floor(v / this.size) + 32768);
		for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) each(x * 65536 + y);
	}

	// Files an item, unless it is filed already: whether it was new.
	add(box: Box, item: T) {
		if (!box.every(Number.isFinite) || this.boxes.has(item)) return false;
		this.boxes.set(item, box);
		this.cellsOf(box, (cell) => {
			const here = this.cells.get(cell);
			if (here) here.add(item);
			else this.cells.set(cell, new Set([item]));
		});
		return true;
	}

	// Takes an item out of the cells its box covers, giving back each cell
	// it leaves empty.
	private unfile(box: Box, item: T) {
		this.boxes.delete(item);
		this.cellsOf(box, (cell) => {
			const here = this.cells.get(cell);
			if (here?.delete(item) && !here.size) this.cells.delete(cell);
		});
	}

	// Takes an item out: whether it was filed.
	remove(item: T) {
		const box = this.boxes.get(item);
		if (!box) return false;
		this.unfile(box, item);
		return true;
	}

	// Takes out everything not in `keep`: the boxes of what it took out.
	keepOnly(keep: Set<T>) {
		const gone: Box[] = [];
		for (const [item, box] of this.boxes)
			if (!keep.has(item)) {
				this.unfile(box, item);
				gone.push(box);
			}
		return gone;
	}

	near(box: Box): T[] {
		if (!box.every(Number.isFinite)) return [];
		const found = new Set<T>();
		this.cellsOf(box, (cell) => {
			for (const item of this.cells.get(cell) ?? [])
				if (overlap(this.boxes.get(item)!, box)) found.add(item);
		});
		return [...found];
	}
}

// The points of what a description covers.
export function* pointsOf(d: Description) {
	for (const s of d.surfaces)
		if ('left' in s.shape) yield* [...s.shape.left, ...s.shape.right];
		else for (const ring of s.shape) yield* ring;
}

// The ground a surface covers.
export const shapeOf = (s: Surface): Paths =>
	'left' in s.shape
		? [toPath([...s.shape.left, ...[...s.shape.right].reverse()])]
		: s.shape.map(toPath);

// What a piece below covers, by what a walk laid over it makes of it: car
// lanes and a node's paving (`hard`), crossed as a zebra; a median, crossed
// as a refuge; a verge, crossed as walk paving; and sidewalk (its own, and
// the paving of its own crossings), where the walk laid over is that
// sidewalk. With the lines its traffic runs along (`lines`: a road's own
// line, a node's car paths), which its crossings' stripes follow.
export interface Under {
	hard: Paths;
	median: Paths;
	verge: Paths;
	walk: Paths;
	lines: Pt[][];
}

// Ground a network laid over another crosses on it, in one piece, and the
// way the traffic it crosses runs there (`along`): every piece of a crossing
// over a road and its node lays its stripes that one way, spaced across it
// from the middle (`stripes.mid`, measured along the normal of `along`) of
// how wide it is over car lanes and medians (`stripes.wide`). Whether it
// lies over car lanes or a median (`traffic`): only such a crossing is one
// the traffic is held at, by its control (`control`: give-way unless one is
// set on it, core/crossing-controls.ts, and the middle of the roadway there,
// core/networks.ts), which holds the traffic in the car lanes it lies across
// alone (`across`: the road's segments and its carriageway's car lanes, so
// on a street with a walkway down its middle each carriageway's crossing
// holds its own; absent, every car lane it lies on); a piece over a verge is
// walk paving, which no control stands behind.
export interface Crossed {
	// The crossing's id where a footpath's (Networks), which each crossing
	// drawn of it names (Crossing.of).
	id?: string;
	rings: Paths;
	// The car pieces it is drawn on, by id (all near it, where not given).
	on?: string[];
	along: Pt;
	stripes: { mid: number; wide: number };
	traffic: boolean;
	control?: { kind: Control; at: Pt };
	across?: { roads: string[]; lanes: string[] };
}

// Whether a crossing holds the traffic in a car lane of a road it lies on:
// a crossing of that road only in the car lanes it lies across, and one of
// another road (reaching over this one from its junction) in every lane.
export const holdsLane = (c: Crossed, road: string, lane: string) =>
	!c.across?.roads.includes(road) || c.across.lanes.includes(lane);

// Whether a crossing holds a car lane of a road whose traffic runs one way
// along it (`dir`), as holdsLane.
export const holdsGoing =
	(c: Crossed, road: string, dir: Lane['dir'] | undefined) => (lane: Lane) =>
		isTravel(lane) && lane.dir === dir && holdsLane(c, road, lane.id);

// The walkway of a piece below that a point lies on, or null: a road's
// sidewalk or one a junction carries on, by its road and lane; or a
// junction's corner sidewalk (NodeDescription.walkways), the one whose middle
// line comes nearest the point, by the lane it joins nearer the point along
// it, with the two lanes it joins and its middle line from the first to the
// second (`corner`).
export function walkAt(
	d: Description,
	p: Pt
): {
	road: string;
	lane: string;
	corner?: { a: LaneRef; b: LaneRef; line: Pt[] };
} | null {
	for (const s of d.surfaces)
		if (s.role === 'walk' && inside(shapeOf(s), p)) {
			if (s.lane) return s.lane;
			const near = 'walkways' in d ? nearestOf(d.walkways ?? [], (w) => w.line, p) : null;
			if (!near) continue;
			const { item: w, along } = near;
			const mine = along * 2 <= near.length ? w.a : w.b;
			return { road: mine.road, lane: mine.lane, corner: { a: w.a, b: w.b, line: w.line } };
		}
	return null;
}

// Of some items, each with a line, the one whose line comes nearest a point:
// the point there, how far along its line it lies and the line's length.
export function nearestOf<T>(items: T[], lineOf: (item: T) => Pt[], p: Pt) {
	let best: { item: T; at: Pt; d: number; along: number; length: number } | null = null;
	for (const item of items) {
		const line = lineOf(item);
		let run = 0;
		const found: { at: Pt; d: number; along: number }[] = [];
		for (let k = 1; k < line.length; k++) {
			const [a, b] = [line[k - 1], line[k]];
			const l = dist(a, b);
			const f =
				l > 1e-9
					? Math.max(
							0,
							Math.min(
								1,
								dot({ x: p.x - a.x, y: p.y - a.y }, { x: b.x - a.x, y: b.y - a.y }) / (l * l)
							)
						)
					: 0;
			const at = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
			found.push({ at, d: dist(at, p), along: run + l * f });
			run += l;
		}
		const near = found.reduce<(typeof found)[number] | null>(
			(m, q) => (!m || q.d < m.d ? q : m),
			null
		);
		if (near && (!best || near.d < best.d)) best = { item, ...near, length: run };
	}
	return best;
}

export function underOf(d: Description): Under {
	const pick = (keep: (s: Surface) => boolean) => union(d.surfaces.filter(keep).flatMap(shapeOf));
	return {
		hard: pick((s) => s.role === 'lane' || s.role === 'paving'),
		median: pick((s) => s.role === 'median'),
		verge: pick((s) => s.role === 'verge'),
		walk: union([
			...d.surfaces.filter((s) => s.role === 'walk').flatMap(shapeOf),
			...d.crossings.flatMap((c) =>
				c.runs.filter((r) => r.kind !== 'zebra').flatMap((r) => r.rings.map(toPath))
			)
		]),
		lines:
			'outline' in d ? d.paths.filter((p) => p.kind === 'drive').map((p) => p.line) : [d.path.pts]
	};
}

// The way the nearest of `lines` to the middle of some ground runs there.
function trafficAt(lines: Pt[][], rings: Paths): Pt {
	const pts = rings.flatMap(fromPath);
	const mid = {
		x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
		y: pts.reduce((s, p) => s + p.y, 0) / pts.length
	};
	let best = { d: Infinity, along: { x: 1, y: 0 } };
	for (const line of lines)
		for (let k = 1; k < line.length; k++) {
			const [a, b] = [line[k - 1], line[k]];
			const l = dist(a, b);
			if (l < 1e-9) continue;
			const t = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
			const f = Math.max(0, Math.min(l, dot({ x: mid.x - a.x, y: mid.y - a.y }, t)));
			const d = dist(offsetPoint(a, t, f), mid);
			if (d < best.d) best = { d, along: t };
		}
	return best.along;
}

// What of the ground crossed is no crossing at all (m²).
const MIN_AREA = 0.05;
const sumOf = (paths: Paths) => paths.reduce((s, p) => s + area(p), 0);

// The ground a crossing (core/runs.ts) crosses on the pieces below
// (`under`): its runs' bands (`bands`, bandOf, which keep within its road's
// width), over car lanes and medians. Null where that is too small to be a
// crossing (MIN_AREA).
export function crossedBy(bands: Pt[][], under: Under[]): Crossed | null {
	const hard = union(under.flatMap((u) => [...u.hard, ...u.median]));
	const ground = intersect(union(bands.map(toPath)), hard);
	const rings = piecesOf(ground)
		.filter((piece) => sumOf(piece) >= MIN_AREA)
		.flat();
	if (!rings.length) return null;
	const along = trafficAt(
		under.flatMap((u) => u.lines),
		rings
	);
	// Its stripes are spaced from the middle of what it crosses, so every
	// piece below lays them in one rhythm and a crossing over one narrow lane
	// still gets one.
	const across = { x: -along.y, y: along.x };
	const wide = rings.flatMap(fromPath).map((q) => dot(q, across));
	const [lo, hi] = [Math.min(...wide), Math.max(...wide)];
	return { rings, along, stripes: { mid: (lo + hi) / 2, wide: hi - lo }, traffic: true };
}

// The pieces of some crossed ground a piece below draws: each piece of it
// in one, as big as a crossing must be (MIN_AREA). Two touches apart are two
// pieces, each drawn or left out on its own (crossingsOver).
const drawnPieces = (paths: Paths) => piecesOf(paths).filter((piece) => sumOf(piece) >= MIN_AREA);

// A piece laid over the pieces below it (`under`, those whose boxes meet
// its own): its description, less all of the ground below, and the verge
// it crosses there (`crossing`), walk paving, which no control stands
// behind. What it crosses of car lanes and medians is no part of it: each
// crossing is the bands of runs across a road (crossedBy), held by one
// footpath segment (crossingsHeldBy in core/runs.ts).
// The ground of some pieces below as one: their verges, and all they cover.
// Kept with the first of them for as long as the same pieces lie below
// (each piece's Under is kept from build to build while it stays the same:
// Networks), so laying a footpath over a long road again unites its ground
// once, not on every frame.
type Merged = { under: Under[]; verge: Paths; all: Paths };
const merged = new WeakMap<Under, Merged[]>();
function mergedOf(under: Under[]) {
	const known = merged.get(under[0]) ?? [];
	const same = (m: Merged) =>
		m.under.length === under.length && m.under.every((u, i) => u === under[i]);
	let m = known.find(same);
	if (!m) {
		const hard = union(under.flatMap((u) => [...u.hard, ...u.median]));
		const verge = union(under.flatMap((u) => u.verge));
		const all = union([...hard, ...verge, ...under.flatMap((u) => u.walk)]);
		m = { under: [...under], verge, all };
		merged.set(under[0], [...known.slice(-7), m]);
	}
	return m;
}

export function layOver(d: Description, under: Under[]) {
	const shape = union(d.surfaces.flatMap(shapeOf));
	const none = { description: d, crossing: [] as Crossed[] };
	if (!under.length || !shape.length) return none;
	const { verge, all } = mergedOf(under);
	if (!intersect(shape, all).length) return none;
	const lines = under.flatMap((u) => u.lines);
	const crossing = piecesOf(intersect(shape, verge))
		.filter((piece) => sumOf(piece) >= MIN_AREA)
		.map(
			(rings): Crossed => ({
				rings,
				along: trafficAt(lines, rings),
				stripes: { mid: 0, wide: 0 },
				traffic: false
			})
		);
	const faults = [...d.faults];
	const surfaces = d.surfaces.flatMap((s): Surface[] => {
		const own = shapeOf(s);
		if (!intersect(own, all).length) return [s];
		const rings = toRings(subtract(own, all), faults);
		if (!rings.length) return [];
		const bars = s.bars && toRings(subtract(s.bars.rings.map(toPath), all), faults);
		return [
			{ ...s, shape: rings, ...(s.bars && { bars: { colour: s.bars.colour, rings: bars ?? [] } }) }
		];
	});
	return { description: { ...d, surfaces, faults }, crossing };
}

// How wide a zebra's bar is (m).
const BAR = 0.4;

// Zebra bars over a piece of ground (its points, `piece`) of a crossing,
// laid along the traffic there: a metre apart across it and BAR wide, as
// many as whole metres it is wide over car lanes and medians (one at the
// least), centred on that, each as long as the piece is deep. The pieces of
// one crossing over a road and its node so line up edge to edge.
function zebra(piece: Pt[], { along, stripes }: Crossed): Paths {
	const across = { x: -along.y, y: along.x };
	const deep = piece.map((q) => dot(q, along));
	const [d0, d1] = [Math.min(...deep) - 0.3, Math.max(...deep) + 0.3];
	const count = Math.max(1, Math.round(stripes.wide));
	const out: Paths = [];
	for (let k = 0; k < count; k++) {
		const mid = offsetPoint({ x: 0, y: 0 }, across, stripes.mid + k - (count - 1) / 2);
		out.push(toPath(quad(offsetPoint(mid, along, d0), offsetPoint(mid, along, d1), BAR / 2)));
	}
	return out;
}

// The crossings a network laid over this piece makes on it, where the ground
// it crosses (`over`, layOver's) lies on the piece's car lanes (`hard`, and
// each car lane's own, `lanes`), its medians and its verges: one for each
// piece of that ground, zebra stripes over its car lanes, a refuge on a
// median, walk paving on a verge, its body all of it but the verge. A car
// lane narrower than the gap between two stripes, which their rhythm can
// miss, gets one of its own across its middle: every car lane crossed carries
// stripe. Where crossed ground overlaps, the first has it, and the piece's
// own crossings (`own`) have theirs. This is the one place a crossing is
// drawn or not: each crossing drawn names the crossed ground it is of
// (`of`), and whatever asks where a footpath's crossing is drawn (its badge,
// the crossing under the pointer, where its footpath shows) reads these.
export function crossingsOver(
	id: string,
	over: Crossed[],
	ground: { hard: Paths; lanes: Paths[]; median: Paths; verge: Paths },
	own: Crossing[],
	faults: Pt[]
): Crossing[] {
	if (!over.length) return [];
	const all = union([...ground.hard, ...ground.median, ...ground.verge]);
	const out: Crossing[] = [];
	let taken = union(own.flatMap((c) => [...c.body, ...c.runs.flatMap((r) => r.rings)]).map(toPath));
	for (const crossed of over) {
		const on = subtract(intersect(crossed.rings, all), taken);
		taken = union([...taken, ...on]);
		for (const piece of drawnPieces(on)) {
			// Ground crossing no car lane or median is verge paving alone.
			const hard = crossed.traffic ? intersect(piece, ground.hard) : [];
			const refuge = crossed.traffic ? intersect(piece, ground.median) : [];
			const paved = subtract(intersect(piece, ground.verge), union([...hard, ...refuge]));
			const pts = fromPath(piece[0]);
			const lanes = subtract(hard, refuge);
			const bars = hard.length ? intersect(zebra(pts, crossed), lanes) : [];
			const { along } = crossed;
			const across = { x: -along.y, y: along.x };
			const extent = (p: Paths, d: Pt) => {
				const at = p.flatMap(fromPath).map((q) => dot(q, d));
				return [Math.min(...at), Math.max(...at)];
			};
			// The pieces of car lanes their bars cross less than half a bar wide.
			const missed = (hard.length ? ground.lanes : [])
				.flatMap((lane) => piecesOf(intersect(piece, intersect(lane, lanes))))
				.filter((p) => {
					if (sumOf(p) < MIN_AREA) return false;
					const [d0, d1] = extent(p, along);
					return sumOf(intersect(p, bars)) < (BAR / 2) * (d1 - d0);
				});
			const stripes = [
				...subtract(bars, union(missed.flat())),
				...missed.flatMap((p) => {
					const [w0, w1] = extent(p, across);
					const alone = { ...crossed, stripes: { mid: (w0 + w1) / 2, wide: 0 } };
					return intersect(zebra(pts, alone), p);
				})
			];
			const runs = (
				[
					{ kind: 'paved', rings: toRings(union([...refuge, ...paved]), faults, LAP) },
					{ kind: 'zebra', rings: toRings(stripes, faults) }
				] as const
			).filter((run) => run.rings.length > 0);
			if (!runs.length) continue;
			out.push({
				id: `${id}~${out.length}`,
				...(crossed.id !== undefined && { of: crossed.id }),
				line: lineOf(pts),
				runs: [...runs],
				body: toRings(union([...hard, ...refuge]), faults)
			});
		}
	}
	return out;
}

// A crossing's middle as a line: the longest way across its outline.
function lineOf(pts: Pt[]) {
	let best: [Pt, Pt] = [pts[0], pts[0]];
	for (const a of pts) for (const b of pts) if (dist(a, b) > dist(...best)) best = [a, b];
	return best;
}

// Markings less where they pass over crossings' bodies (and a stroke's half
// width round them). Cut pieces keep the whole line's dashes; a piece left
// shorter than MIN_PIECE is dropped.
export function clearOf(markings: Marking[], bodies: Pt[][]): Marking[] {
	if (!bodies.length) return markings;
	const held = offset(union(bodies.map(toPath)), LINE / 2);
	const box = boxOf(held.flatMap(fromPath));
	return markings.flatMap((m) => {
		if (!overlap(boxOf(m.line), box)) return [m];
		const all = boxOf([...m.line, ...held.flatMap(fromPath)], 1);
		const keep = subtract(
			[
				toPath([
					{ x: all[0], y: all[1] },
					{ x: all[2], y: all[1] },
					{ x: all[2], y: all[3] },
					{ x: all[0], y: all[3] }
				])
			],
			held
		).map(fromPath);
		// Each piece's distances read back on the line's own (`along`), by how
		// far along the line it is.
		const arc = [0];
		for (let i = 1; i < m.line.length; i++) arc.push(arc[i - 1] + dist(m.line[i - 1], m.line[i]));
		const at = (s: number) => {
			const i = arc.at(-1)! < s ? 1 : pieceAt(arc, s);
			const f = arc[i] > arc[i - 1] ? (s - arc[i - 1]) / (arc[i] - arc[i - 1]) : 0;
			return m.along[i - 1] + (m.along[i] - m.along[i - 1]) * Math.max(0, Math.min(1, f));
		};
		const rhythm = m.rhythm ?? [m.along[0], m.along[m.along.length - 1]];
		return cutLine(m.line, keep)
			.map(({ line, along }) => ({ ...m, line, along: along.map(at), rhythm }))
			.filter(
				(piece) =>
					Math.abs(piece.along[piece.along.length - 1] - piece.along[0]) >= MIN_PIECE - LINE
			);
	});
}
