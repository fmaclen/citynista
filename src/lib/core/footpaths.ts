// The footpaths (core/networks.ts): every segment with no car lane, each a
// strip. A strip is its lanes side by side at their widths along the line
// the segment shows on (core/road-line.ts: its curve, and its shift blending
// from one end's to the other's), square to its line at each end. Nothing
// shapes it but its own node's footpaths: no taper or setback a car road
// takes applies, no node merges with another or carries it on as one road,
// and no end is attached at an edge (core/attach.ts reads a footpath's end
// at its node).
//
// A node of two footpaths, at no car road's dead end nor on its sidewalk,
// is a bend, drawn as a street's bend of two roads is: both strips stop the
// same way short of the node (`bendCut`) and the bend (`bendOf`) paves the
// way round between their ends. A bend tighter than they are wide, where
// stopped so they would still lap each other from their ends out, takes
// them over as far as they lap (`takeOver`): it paves along both as one
// piece that far, so no ground is paved twice. Everywhere else a strip is
// paved right up to its node, so widening one segment changes that strip
// and the bends at its ends alone.
//
// Where three or more footpaths meet at a node the ground between them is
// paved as one joint (`fillOf`), whatever their widths and angles: its
// inside corners rounded, its outside paved round the node, and the line a
// walker follows from each to every other held with it. The joint is paved
// over the strips; no strip changes for it. A footpath node joins the car
// road dead end at each spot its footpaths' ends show (`carEnds`, decided in
// core/networks.ts), so a node whose ends show apart may join two roads'
// dead ends, one at each: the node's joint holds each such road's sidewalks
// too, carried on past its end as far as the widest footpath there is wide.
// A node
// lying on a car road's sidewalk, every end there on it, is that sidewalk
// (`onWalk`, read by core/networks.ts) and is neither filled nor bent.

import {
	area,
	inside,
	intersect,
	offset,
	type Paths,
	toPath,
	toRings,
	union
} from '../road-model/clip';
import type {
	EndCut,
	LanePath,
	NodeDescription,
	RoadDescription,
	Surface
} from '../road-model/description';
import { type EndInfo, endsOf, type RoadGeo } from '../road-model/ends';
import {
	crossSection,
	curveBetween,
	dedupe,
	dist,
	dot,
	endFrame,
	frameAt,
	hullOf,
	mix,
	neg,
	offsetPoint,
	samplePath,
	TAPER
} from '../road-model/geometry';
import {
	type DrawnJunction,
	type End,
	type EndRef,
	isWalk,
	type Pt,
	type Road
} from '../road-model/model';
import { type Box, boxOf, pointsOf } from '../road-model/overlay';
import { describeRoad, materialOf, roleOf } from '../road-model/road';
import type { GraphView } from './graph.svelte';
import { carries } from './lane-types';
import { type FixedEnd, roadOf } from './place';
import { type Curve, curveOf } from './segment-curve';
import type { Segment } from './segment.svelte';
import { bendBack } from './setbacks';

// The id a footpath node's fill goes by among the car pieces.
export const WALK = 'walk:';

const FREE: EndCut = { paint: 0, nose: null };

// A footpath segment's whole line, node to node, sampled (`geo`), kept as one
// object while what it is drawn from (`from`) stays the same: what its nodes
// read of it. Its nodes hold no edits for it to read (core/separate.ts).
export interface Shape {
	from: StripFrom;
	curve: Curve;
	geo: RoadGeo;
	nodes: [string, string];
}

// A footpath segment drawn: its shape, cut back `cut` metres at its start
// and end where a bend takes it over (0 elsewhere), its road and sampled
// line as drawn, and its description, kept as one object while its shape
// and cuts stay the same.
export interface Strip {
	shape: Shape;
	cut: [number, number];
	road: Road;
	geo: RoadGeo;
	nodes: [string, string];
	description: RoadDescription;
	box: Box;
}

// What a strip is drawn from: its nodes and where they lie, its curve's
// handle, its shift at each end and its cross-section (one frozen object
// while it stays the same: core/segment.svelte.ts).
interface StripFrom {
	a: { id: string } & Pt;
	b: { id: string } & Pt;
	control: [number | undefined, number | undefined];
	shift: [number, number];
	lanes: Segment['lanes'];
}

const sameFrom = (f: StripFrom, s: Segment, a: { id: string } & Pt, b: { id: string } & Pt) =>
	f.a.id === a.id &&
	f.b.id === b.id &&
	f.a.x === a.x &&
	f.a.y === a.y &&
	f.b.x === b.x &&
	f.b.y === b.y &&
	f.control[0] === s.controlX &&
	f.control[1] === s.controlY &&
	f.shift[0] === s.offsetStart &&
	f.shift[1] === s.offsetEnd &&
	f.lanes === s.lanes;

// The ground at a node footpaths meet at, a bend or a joint, kept while the
// strips ending there and the car road end it joins stay the same. A bend
// keeps its middle line (`middle`, bendOf), from where the strip of its
// first end stops to where its second's does.
export interface Fill {
	key: string;
	junction: DrawnJunction;
	description: NodeDescription;
	box: Box;
	middle?: Pt[];
}

// What a build of the footpaths hands on: every strip by its segment's id
// and every fill by its node's id, as they stand (kept and changed in place
// from build to build), with the strips drawn afresh or gone (`changed`),
// the nodes read again for their fill (`revisited`), and of those the nodes
// whose fill came, went or was drawn afresh (`refilled`).
export interface Built {
	strips: ReadonlyMap<string, Strip>;
	fills: ReadonlyMap<string, Fill>;
	changed: Set<string>;
	revisited: Set<string>;
	refilled: Set<string>;
}

// What a node footpaths end at is: nothing of its own (a lone end, or ends
// on a sidewalk), a bend of two, or a joint. A bend's strips stop `cut`
// short of the node, and its turn begins `turn` short of it (bendCut), no
// further out than they stop.
type Meeting =
	| { kind: 'none' }
	| { kind: 'bend' | 'joint'; ends: EndRef[]; cars: FixedEnd[]; cut: number; turn: number };

const endKey = (e: EndRef) => `${e.road}:${e.end}`;

export class Footpaths {
	private shapes = new Map<string, Shape>();
	private strips = new Map<string, Strip>();
	private fills = new Map<string, Fill>();
	// How far a bend cuts back each strip end it takes over, by segment id
	// and end.
	private cuts = new Map<string, number>();
	private version = 0;

	// The footpaths of `graph` drawn: a strip per segment, by its id, and a
	// fill per node footpaths meet at, by node id. `carEnds` are the car
	// road ends at the car dead ends' nodes showing where a footpath node's
	// ends do, one for each end that shows on one;
	// `onWalk`, whether every footpath end at a node lies on a car road's
	// sidewalk. Each is asked with the shapes ending at the node. Of each
	// segment only what it was drawn from is read, to compare; only the
	// nodes of shapes drawn afresh or gone, and `shaken` (those whose reading
	// of the cars may have changed), are read again for what meets there,
	// and only the strips ending there drawn again where their cuts changed,
	// so a build costs that comparison per segment and what changed.
	build(
		graph: GraphView,
		at: {
			carEnds: (node: { id: string } & Pt, shapes: Shape[]) => FixedEnd[];
			onWalk: (node: { id: string } & Pt, shapes: Shape[]) => boolean;
		},
		shaken: Iterable<string>
	): Built {
		const shapes = this.shapes;
		const strips = this.strips;
		const refill = new Set(shaken);
		// Segments whose shape is new or changed, and the nodes a footpath
		// came to or left.
		const reshaped = new Set<string>();
		const regrouped = new Set<string>();
		// How many shapes were drawn before and are again, and how many are new.
		let kept = 0;
		let fresh = 0;
		for (const segment of graph.segments.values()) {
			if (carries(segment.lanes) || segment.startNodeId === segment.endNodeId) continue;
			const a = graph.nodes.get(segment.startNodeId);
			const b = graph.nodes.get(segment.endNodeId);
			if (!a || !b) continue;
			const was = shapes.get(segment.id);
			if (was) kept++;
			else fresh++;
			if (was && sameFrom(was.from, segment, a, b)) continue;
			for (const n of was?.nodes ?? []) refill.add(n);
			if (was?.nodes[0] !== a.id || was.nodes[1] !== b.id)
				for (const n of [...(was?.nodes ?? []), a.id, b.id]) regrouped.add(n);
			const curve = curveOf(segment, a, b);
			const road = roadOf(segment, curve, 0, 0);
			road.key = String(++this.version);
			shapes.set(segment.id, {
				from: {
					a: { id: a.id, x: a.x, y: a.y },
					b: { id: b.id, x: b.x, y: b.y },
					control: [segment.controlX, segment.controlY],
					shift: [segment.offsetStart, segment.offsetEnd],
					lanes: segment.lanes
				},
				curve,
				geo: { road, path: samplePath(road) },
				nodes: [a.id, b.id]
			});
			reshaped.add(segment.id);
			refill.add(a.id).add(b.id);
		}
		const changed = new Set<string>();
		// Shapes whose segment is gone or no longer drawn as a footpath: looked
		// for only when fewer were kept than there were.
		const gone = kept < shapes.size - fresh;
		if (gone)
			for (const [id, shape] of shapes)
				if (!drawsStrip(graph, id)) {
					shapes.delete(id);
					strips.delete(id);
					this.cuts.delete(endKey({ road: id, end: 'start' }));
					this.cuts.delete(endKey({ road: id, end: 'end' }));
					changed.add(id);
					for (const n of shape.nodes) {
						refill.add(n);
						regrouped.add(n);
					}
				}
		// How far a bend may take a strip over reads how many footpaths meet
		// at the strip's far node (takeOverCap), so where that changed the
		// nodes at the far ends of the footpaths there are read again.
		for (const n of regrouped)
			for (const s of graph.nodes.get(n)?.connectedSegments ?? []) {
				const shape = shapes.get(s);
				if (shape) refill.add(shape.nodes[shape.nodes[0] === n ? 1 : 0]);
			}

		// What meets at each node read again, and the cuts its bend makes.
		const meetings = new Map<string, Meeting>();
		const meet = (id: string) => {
			const node = graph.nodes.get(id);
			const ends: EndRef[] = [];
			const here: Shape[] = [];
			for (const s of node?.connectedSegments ?? []) {
				const shape = shapes.get(s);
				if (!shape) continue;
				ends.push({ road: s, end: shape.nodes[0] === id ? 'start' : 'end' });
				here.push(shape);
			}
			const cars = node && ends.length ? at.carEnds(node, here) : [];
			let meeting: Meeting = { kind: 'none' };
			if (node && ends.length && (cars.length || (ends.length > 1 && !at.onWalk(node, here)))) {
				const whole = endsOf({ ends }, new Map(ends.map((e, k) => [e.road, here[k].geo])));
				const bend = !cars.length && whole.length === 2 && whole.every((e) => e.lanes.length);
				const turn = bend ? bendCut(whole[0], whole[1]) : 0;
				const cap = bend ? Math.min(...here.map((shape) => takeOverCap(graph, shape, id))) : 0;
				meeting = {
					kind: bend ? 'bend' : 'joint',
					ends,
					cars,
					cut: bend ? takeOver(whole[0], whole[1], turn, cap) : 0,
					turn
				};
			}
			for (const e of ends)
				if (meeting.kind === 'bend') this.cuts.set(endKey(e), meeting.cut);
				else this.cuts.delete(endKey(e));
			meetings.set(id, meeting);
		};
		for (const id of refill) meet(id);

		// Each strip whose shape or cuts changed drawn again, and the nodes at
		// its ends, whose fill reads it as drawn, read again with it.
		const redraw = new Set(reshaped);
		for (const [id, m] of meetings)
			if (m.kind !== 'none') for (const e of m.ends) redraw.add(e.road);
			else
				for (const s of graph.nodes.get(id)?.connectedSegments ?? [])
					if (shapes.has(s)) redraw.add(s);
		for (const id of redraw) {
			const shape = shapes.get(id);
			const segment = graph.segments.get(id);
			if (!shape || !segment) continue;
			const cut: [number, number] = [
				this.cuts.get(endKey({ road: id, end: 'start' })) ?? 0,
				this.cuts.get(endKey({ road: id, end: 'end' })) ?? 0
			];
			const was = strips.get(id);
			if (was?.shape === shape && was.cut[0] === cut[0] && was.cut[1] === cut[1]) continue;
			let geo = shape.geo;
			if (cut[0] || cut[1]) {
				const road = roadOf(segment, shape.curve, cut[0], cut[1]);
				road.key = String(++this.version);
				geo = { road, path: samplePath(road) };
			}
			const description = describeRoad(geo.road, geo.path, { start: FREE, end: FREE });
			strips.set(id, {
				shape,
				cut,
				road: geo.road,
				geo,
				nodes: shape.nodes,
				description,
				box: boxOf(pointsOf(description))
			});
			changed.add(id);
			for (const n of shape.nodes) if (!meetings.has(n)) meet(n);
		}
		// Listed in the graph's order, as a fresh build lists them.
		if (fresh || gone) this.strips = inOrder(graph.segments, strips);

		const fills = this.fills;
		const refilled = new Set<string>();
		// Whether a fill came or went, so the fills are listed afresh.
		let listed = false;
		for (const [id, m] of meetings) {
			if (m.kind === 'none') {
				if (fills.delete(id)) {
					refilled.add(id);
					listed = true;
				}
				continue;
			}
			const { ends, cars } = m;
			const key = [
				m.kind,
				...ends.map((e) => `${this.strips.get(e.road)!.road.key}:${e.end}`),
				...cars.map((c) => c.key)
			].join('|');
			if (fills.get(id)?.key === key) continue;
			const junction: DrawnJunction = {
				id: WALK + id,
				ends,
				connections: [],
				walkways: [],
				control: {},
				members: [id],
				key
			};
			const drawn = new Map(ends.map((e) => [e.road, this.strips.get(e.road)!.geo]));
			const whole = new Map(ends.map((e) => [e.road, shapes.get(e.road)!.geo]));
			const { description, middle } =
				m.kind === 'bend'
					? bendOf(endsOf(junction, drawn), endsOf(junction, whole), m.cut, m.turn)
					: { description: fillOf(endsOf(junction, whole), cars), middle: undefined };
			if (!fills.has(id)) listed = true;
			// The node and where each of its footpaths' ends shows (uncut) lie
			// in its fill's box, a bend's paving reaching them or not, so
			// whatever comes near them comes near a piece of it
			// (core/networks.ts reads what each end lies on).
			const node = graph.nodes.get(id)!;
			const box = boxOf([
				...pointsOf(description),
				{ x: node.x, y: node.y },
				...endsOf(junction, whole).map((e) => middleAt(e, 0).p)
			]);
			fills.set(id, { key, junction, description, box, ...(middle && { middle }) });
			refilled.add(id);
		}
		if (listed) this.fills = inOrder(graph.nodes, fills);
		return {
			strips: this.strips,
			fills: this.fills,
			changed,
			revisited: new Set(meetings.keys()),
			refilled
		};
	}
}

// The entries of `map` in the order of `order`'s keys.
function inOrder<T>(order: ReadonlyMap<string, unknown>, map: Map<string, T>) {
	const out = new Map<string, T>();
	for (const id of order.keys()) {
		const v = map.get(id);
		if (v) out.set(id, v);
	}
	return out;
}

// Whether a segment of `graph` is drawn as a strip: a footpath between two
// nodes of the graph.
function drawsStrip(graph: GraphView, id: string) {
	const s = graph.segments.get(id);
	return (
		!!s &&
		!carries(s.lanes) &&
		s.startNodeId !== s.endNodeId &&
		graph.nodes.has(s.startNodeId) &&
		graph.nodes.has(s.endNodeId)
	);
}

// How the ground where footpaths meet is shaped, to tune by eye.
const JOINT = {
	// The inside of a joint's corner is rounded to a circle this many half
	// widths of the wider footpath there across.
	RADIUS: 1,
	// The most of a footpath's length (a fraction) a bend or joint reaches
	// along it, so those at its two ends stay apart.
	REACH: 0.45,
	// Metres along a footpath a walker's line from it to another starts, or a
	// third of its length where that is shorter.
	LINK: 3,
	// Metres: the longest step a footpath is swept or read along in.
	STEP: 0.5,
	// Steps an arc is sampled in.
	ARC: 16,
	// Metres: a corner rounded tighter than this is left sharp.
	TIGHTEST: 0.05,
	// Metres: a corner is rounded, and a walker turns, only where each
	// footpath's middle lies this near the line it leaves the node along.
	STRAIGHT: 0.02,
	// Metres of a strip a bend taking it over leaves at an end where no
	// other bend is.
	STUB: 0.01,
	// Halvings of the stretch a bend may take its strips over in, to find
	// where they stop lapping.
	HALVINGS: 12,
	// Metres: two strips of a bend this near each other lap, to the bend: a
	// gap that thin between them reads as a crack, not ground, so the bend
	// paves it and takes them over until they are further apart. A look
	// setting: checks.ts sees a crack only once a sliver averages 3 cm or
	// less, which a hairpin leaves only with this under about 2 cm (the
	// hairpin test in unit/footpaths-meeting.test.ts).
	APART: 0.15,
	// How far out from where a bend's strips stop (times their two half
	// widths) a lap of theirs from there is the bend's.
	NEAR: 2
};

const sub = (a: Pt, b: Pt) => ({ x: a.x - b.x, y: a.y - b.y });
// The normals of a direction turned anticlockwise and clockwise.
const ccw = (d: Pt) => ({ x: -d.y, y: d.x });
const cw = (d: Pt) => ({ x: d.y, y: -d.x });

// A footpath's frame `s` along it from its end at a node, and where its
// cross-section reaches either side of its line there (`l` and `r`).
function acrossAt({ geo, ref }: EndInfo, s: number) {
	const along = ref.end === 'start' ? s : geo.path.length - s;
	const f = frameAt(geo.path, along);
	const spans = crossSection(geo.road, along);
	return { f, l: spans[0].left, r: spans.at(-1)!.right };
}

// The middle of a footpath's cross-section `s` along it from its end at a
// node, the right normal there and its half width.
function middleAt(end: EndInfo, s: number) {
	const { f, l, r } = acrossAt(end, s);
	return { p: offsetPoint(f.p, f.n, (l + r) / 2), n: f.n, half: (r - l) / 2 };
}

// The middle of a footpath from `from` to `to` along it from its end at a
// node, a point every STEP or closer.
function middleLine(end: EndInfo, from: number, to: number) {
	const n = Math.max(1, Math.ceil(Math.abs(to - from) / JOINT.STEP));
	return Array.from({ length: n + 1 }, (_, k) => middleAt(end, from + ((to - from) * k) / n).p);
}

// How far along a footpath the line a walker follows from it to another
// starts, from the end it is read from: JOINT.LINK, or a third of its length
// where shorter.
const linkFrom = (length: number) => Math.min(JOINT.LINK, length / 3);

// The middle lane of a footpath's end, by which a walker's line names it.
const middleLane = (end: EndInfo) => end.lanes[Math.floor((end.lanes.length - 1) / 2)].ref;

// Ground where footpaths meet, paved in the material of the widest walk
// lane among them (the widest lane's, where none is a walk), described with
// the lines a walker follows there.
function paved(ends: EndInfo[], rings: Pt[][], paths: LanePath[], faults: Pt[]): NodeDescription {
	const lanes = ends.flatMap((e) => e.lanes.map((lane, k) => ({ lane, k, e })));
	const walking = lanes.filter(({ lane }) => isWalk(lane.lane));
	const widest = (walking.length ? walking : lanes).reduce<(typeof lanes)[number] | null>(
		(best, x) =>
			!best || x.lane.right - x.lane.left > best.lane.right - best.lane.left ? x : best,
		null
	);
	const surfaces: Surface[] =
		widest && rings.length
			? [
					{
						role: roleOf(widest.e.lanes, widest.k),
						material: materialOf(widest.lane.lane.surface),
						shape: rings
					}
				]
			: [];
	return {
		ends,
		outline: { rings: [], corners: [], mouths: [] },
		paths,
		surfaces,
		markings: [],
		signs: [],
		crossings: [],
		approaches: [],
		cuts: new Map(),
		faults
	};
}

// A bend of two footpaths, `a` and `b` (their ends at the node, read along
// their whole lines): how far back from the node both strips stop, as a
// street's two roads at a bend do (linkSetbacks in core/setbacks.ts). Far
// enough that their middle lines turn on a circle TAPER.BEND_RADIUS half
// widths of the wider across (R tan(deflection / 2), the deflection read no
// sharper than TAPER.SHARPEST), never less than TAPER.THROUGH_GAP, nor than
// half what easing from one's width and place to the other's takes at
// TAPER.WALK_ALONG_PER_SHIFT metres along per metre; and never past
// JOINT.REACH of either's length, so on a short footpath the bend turns
// tighter and the bend at its other end stays apart from it.
function bendCut(a: EndInfo, b: EndInfo) {
	const [ma, mb] = [middleAt(a, 0), middleAt(b, 0)];
	const radius = TAPER.BEND_RADIUS * Math.max(ma.half, mb.half);
	const shift = Math.abs(ma.half - mb.half) + dist(ma.p, mb.p);
	const want = Math.max(
		TAPER.THROUGH_GAP,
		(TAPER.WALK_ALONG_PER_SHIFT * shift) / 2,
		bendBack(a.frame.run, b.frame.run, radius)
	);
	return Math.min(want, JOINT.REACH * a.geo.path.length, JOINT.REACH * b.geo.path.length);
}

// How far back from their node a bend may take its two strips over, read on
// one of them (`shape`, whose end at the node is `node`): JOINT.REACH of it
// where its far node holds two footpaths (a bend there, whatever else it
// lies on), so the bend there stays apart from this one; all but JOINT.STUB
// of it where its far node holds it alone or three or more, which cut no
// strip back.
function takeOverCap(graph: GraphView, shape: Shape, node: string) {
	const far = shape.nodes[shape.nodes[0] === node ? 1 : 0];
	const there = (graph.nodes.get(far)?.connectedSegments ?? []).filter(
		(s) => !carries(graph.segments.get(s)?.lanes ?? [])
	);
	const length = shape.geo.path.length;
	return there.length === 2 ? JOINT.REACH * length : Math.max(0, length - JOINT.STUB);
}

// A footpath's cross-section `s` along it from its end at a node (read
// along its whole line): its middle, half width, the way its middle runs on
// away from the node there and its two edges.
function sectionAt(end: EndInfo, s: number) {
	const length = end.geo.path.length;
	const { f, l, r } = acrossAt(end, s);
	const m = offsetPoint(f.p, f.n, (l + r) / 2);
	const [p, q] = [
		middleAt(end, Math.max(0, s - 0.05)).p,
		middleAt(end, Math.min(length, s + 0.05)).p
	];
	const d = Math.hypot(q.x - p.x, q.y - p.y) || 1;
	return {
		m,
		half: (r - l) / 2,
		run: { x: (q.x - p.x) / d, y: (q.y - p.y) / d },
		edges: [offsetPoint(f.p, f.n, l), offsetPoint(f.p, f.n, r)]
	};
}

// A footpath's ground from `from` to `to` along it from its end at a node
// (no further than its far end), read along its whole line, as one ring.
function stripFrom(end: EndInfo, from: number, to: number) {
	const last = Math.min(to, end.geo.path.length);
	const n = Math.max(1, Math.ceil((last - from) / JOINT.STEP));
	const sections = Array.from({ length: n + 1 }, (_, k) =>
		sectionAt(end, from + ((last - from) * k) / n)
	);
	return toPath([...sections.map((x) => x.edges[0]), ...sections.map((x) => x.edges[1]).reverse()]);
}

// Whether two footpaths of a bend, each stopped `cut` short of their node,
// still lap each other from there out (a bend tighter than they are wide),
// or come within JOINT.APART of it, a seam too thin to show as ground: in a
// piece reaching the end of either there, of what each covers within
// JOINT.NEAR times their two half widths of it. A lap further out, of a
// footpath curving back over the other, is no part of the bend.
function lapsFrom(a: EndInfo, b: EndInfo, cut: number) {
	const [sa, sb] = [sectionAt(a, cut), sectionAt(b, cut)];
	const to = cut + JOINT.NEAR * (sa.half + sb.half);
	const near = (e: EndInfo) => offset([stripFrom(e, cut, to)], JOINT.APART / 2);
	const both = intersect(near(a), near(b)).filter((piece) => Math.abs(area(piece)) > LAPPED);
	const reaches = (piece: Paths, [p, q]: Pt[]) =>
		Array.from({ length: 9 }, (_, k) => mix(p, q, k / 8)).some((x) => inside(piece, x));
	return both.some((piece) => {
		const near = offset([piece], 0.01);
		return reaches(near, sa.edges) || reaches(near, sb.edges);
	});
}

// Square metres two strips must share to lap.
const LAPPED = 1e-4;

// How far back from their node the two strips of a bend stop (`a` and `b`,
// their ends read along their whole lines): where its turn begins (`turn`,
// bendCut), or, where stopped there they would still lap each other from
// their ends out, as far out as they do (a bend tighter than they are wide,
// which then paves along both that far: bendOf), up to `cap`
// (takeOverCap), found by halving the stretch between.
function takeOver(a: EndInfo, b: EndInfo, turn: number, cap: number) {
	if (cap <= turn || !lapsFrom(a, b, turn)) return turn;
	if (lapsFrom(a, b, cap)) return cap;
	let [lo, hi] = [turn, cap];
	for (let k = 0; k < JOINT.HALVINGS; k++) {
		const mid = (lo + hi) / 2;
		if (lapsFrom(a, b, mid)) lo = mid;
		else hi = mid;
	}
	return hi;
}

// A bend: the way round between two strips' ends cut back `cut` from their
// node (`ends`, as drawn; `whole`, the same ends read along their whole
// lines), its turn beginning `turn` from the node. Its middle line leaves
// the middle of the first's cross-section where it turns along the way that
// strip runs, and joins the second's the same way, on the even curve a
// street's lanes take round a bend (curveBetween: a circular arc between
// two straight footpaths, as both turn the same way short of the node).
// The paving is that line's half width either side of it, square to it, the
// half width easing (TAPER.EASE) from one strip's to the other's along it,
// so both edges curve with it, an inside edge tighter than its half width
// folded away. Where the strips stop further out than the turn (a bend
// taking them over: takeOver) the line runs in along the first's middle
// from where it stops to the turn and out along the second's as far, and
// the paving there is each one's own cross-section and the ground between
// the two (too thin to show: lapsFrom), so the two are paved as one piece.
// Its ends are the strips' own end edges. A walker follows the middle line,
// along each strip's middle from JOINT.LINK out (or from where the bend
// starts, if further). With its description, the middle line, from the
// first end to the second.
function bendOf(ends: EndInfo[], whole: EndInfo[], cut: number, turn: number) {
	// Each end where its strip stops: the middle of its cross-section, its
	// half width, the way the strip runs off from the node, its edges, and
	// every lane edge across it (`across`).
	const [a, b] = ends.map((e) => {
		const { p, n, run, spans } = e.frame;
		const [l, r] = [spans[0].left, spans.at(-1)!.right];
		const edges = [offsetPoint(p, n, l), offsetPoint(p, n, r)];
		const across = [l, ...spans.map((x) => x.right)].map((d) => offsetPoint(p, n, d));
		return { m: offsetPoint(p, n, (l + r) / 2), half: (r - l) / 2, run, edges, across };
	});
	const [wa, wb] = whole;
	// Each strip's own cross-sections from where it stops in to where the
	// turn begins, the turn's first left out; and the ends of the turn.
	const taken = turn < cut;
	const inward = (e: EndInfo) => {
		const n = Math.max(1, Math.ceil((cut - turn) / JOINT.STEP));
		return Array.from({ length: n }, (_, k) => sectionAt(e, cut - ((cut - turn) * k) / n)).slice(1);
	};
	const [ina, inb] = taken ? [inward(wa), inward(wb)] : [[], []];
	const [ta, tb] = taken ? [sectionAt(wa, turn), sectionAt(wb, turn)] : [a, b];
	const arc = curveBetween(ta.m, neg(ta.run), tb.m, tb.run, TAPER.STEPS);
	let length = 0;
	for (let i = 1; i < arc.length; i++) length += dist(arc[i], arc[i - 1]);
	let run = 0;
	const turning = arc.map((m, i) => {
		if (i > 0) run += dist(m, arc[i - 1]);
		const half = ta.half + (tb.half - ta.half) * TAPER.EASE(length ? run / length : 0);
		return { m, own: null as Pt[] | null, half };
	});
	// Every cross-section along the middle line: the strips' own (`own`, each
	// edge on the strip's ground) or the turn's (none), with its half width.
	const own = (x: { m: Pt; edges: Pt[]; half: number }) => ({ m: x.m, own: x.edges, half: x.half });
	const sections = taken
		? [own(a), ...ina.map(own), ...turning, ...[...inb].reverse().map(own), own(b)]
		: turning;
	const middle = sections.map((x) => x.m);
	const half = sections.map((x) => x.half);
	// Each cross-section, its left edge first looking from a to b; the first
	// and last the strips' own.
	const across = sections.map(({ m, own }, i) => {
		const t =
			i === 0 ? neg(a.run) : i === middle.length - 1 ? b.run : sub(middle[i + 1], middle[i - 1]);
		const l = Math.hypot(t.x, t.y) || 1;
		const left = ccw({ x: t.x / l, y: t.y / l });
		const edges = i === 0 ? a.edges : i === middle.length - 1 ? b.edges : own;
		if (edges) return dot(sub(edges[0], m), left) > 0 ? edges : [edges[1], edges[0]];
		return [offsetPoint(m, left, half[i]), offsetPoint(m, left, -half[i])];
	});
	// Where the bend takes the strips over, the ground between the two as
	// well, section by section, each strip's cross-sections at one distance
	// from the node side by side: they lap there, or lie too near to leave
	// ground between them (lapsFrom).
	const pairs = taken ? [[a, b], ...ina.map((x, k) => [x, inb[k]]), [ta, tb]] : [];
	const between = pairs
		.slice(1)
		.map((q, k) =>
			toPath(hullOf([...pairs[k].flatMap((x) => x.edges), ...q.flatMap((x) => x.edges)]))
		);
	const faults: Pt[] = [];
	const rings = toRings(
		union([...across.slice(1).map((q, k) => toPath(hullOf([...across[k], ...q]))), ...between]),
		faults,
		0,
		// Every lane edge where a strip stops, put on the bend's ring exactly,
		// so the strip's lanes meet it point for point.
		[...a.across, ...b.across]
	);
	// The walker's line: in along the first strip, round the bend, and out
	// along the second, as wide as the paving it runs down.
	const from = [wa, wb].map((e) => Math.max(cut, linkFrom(e.geo.path.length)));
	const walked = [
		...middleLine(wa, from[0], cut).map((p) => ({ p, w: 2 * a.half })),
		...middle.map((p, i) => ({ p, w: 2 * half[i] })),
		...middleLine(wb, cut, from[1]).map((p) => ({ p, w: 2 * b.half }))
	].filter((q, i, all) => i === 0 || dist(q.p, all[i - 1].p) > 0.01);
	const path: LanePath = {
		from: middleLane(wa),
		to: middleLane(wb),
		kind: 'walk',
		line: walked.map((q) => q.p),
		widths: walked.map((q) => q.w)
	};
	return { description: paved(ends, rings, [path], faults), middle };
}

// The way a footpath runs round a bend at one of its ends as drawn (Fill.
// middle): the bend's middle line from where its strip stops to halfway
// round, where the other footpath's does the same; null where no bend takes
// that end over. What reads where a footpath lies as drawn reads it so
// (core/runs.ts).
export function roundOf(fills: ReadonlyMap<string, Fill>, node: string, ref: EndRef) {
	const fill = fills.get(node);
	const middle = fill?.middle;
	const k = fill?.junction.ends.findIndex((e) => e.road === ref.road && e.end === ref.end) ?? -1;
	if (!middle || k < 0) return null;
	const line = k === 0 ? middle : [...middle].reverse();
	const at = [0];
	for (let i = 1; i < line.length; i++) at.push(at[i - 1] + dist(line[i], line[i - 1]));
	const half = at.at(-1)! / 2;
	const out: Pt[] = [];
	for (let i = 0; i < line.length; i++) {
		if (at[i] <= half) out.push(line[i]);
		else {
			const f = (half - at[i - 1]) / (at[i] - at[i - 1] || 1);
			out.push(mix(line[i - 1], line[i], f));
			break;
		}
	}
	return out.length > 1 ? out : null;
}

// A footpath's end at a joint, read along the middle of its cross-section:
// where that lies at the node (`p`), the way it leaves (`dir`), its half
// width (`half`), how far along it the joint may reach (`cap`) and how far
// along it runs straight on from the node (`straight`, within
// JOINT.STRAIGHT, no further than `cap`).
interface Arm {
	end: EndInfo;
	p: Pt;
	dir: Pt;
	half: number;
	cap: number;
	straight: number;
}

// How far along a footpath, up to `cap`, its middle runs straight on from
// `p` along `dir` (within JOINT.STRAIGHT), read every STEP.
function straightOn(end: EndInfo, p: Pt, dir: Pt, cap: number) {
	for (let s = JOINT.STEP; s < cap + JOINT.STEP; s += JOINT.STEP) {
		const q = sub(middleAt(end, Math.min(s, cap)).p, p);
		if (Math.abs(q.x * dir.y - q.y * dir.x) > JOINT.STRAIGHT) return s - JOINT.STEP;
	}
	return cap;
}

// Points round `c` from the direction `a` to the direction `b` the short
// way, `radius` out.
function arcOf(c: Pt, a: Pt, b: Pt, radius: number) {
	const from = Math.atan2(a.y, a.x);
	let turn = Math.atan2(b.y, b.x) - from;
	if (turn > Math.PI) turn -= 2 * Math.PI;
	if (turn < -Math.PI) turn += 2 * Math.PI;
	return Array.from({ length: JOINT.ARC + 1 }, (_, k) => {
		const t = from + (turn * k) / JOINT.ARC;
		return offsetPoint(c, { x: Math.cos(t), y: Math.sin(t) }, radius);
	});
}

// Two arms, `b` turned less than straight on anticlockwise from `a`, read
// toward the ground between them: each's normal toward it (`n`), the point
// lying `u` in from a's middle and `v` in from b's (`at`), and how far along
// each a point lies from its middle at the node (`along`). Null where they
// run straight on, or one along the other.
function between(a: Arm, b: Arm) {
	if (dot(a.dir, b.dir) < -TAPER.STRAIGHT) return null;
	const [na, nb] = [ccw(a.dir), cw(b.dir)];
	const det = na.x * nb.y - na.y * nb.x;
	if (Math.abs(det) < 1e-6) return null;
	const [ua, vb] = [dot(a.p, na), dot(b.p, nb)];
	const at = (u: number, v: number) => ({
		x: ((u + ua) * nb.y - (v + vb) * na.y) / det,
		y: (na.x * (v + vb) - nb.x * (u + ua)) / det
	});
	const along = (q: Pt): [number, number] => [dot(sub(q, a.p), a.dir), dot(sub(q, b.p), b.dir)];
	return { n: [na, nb] as const, at, along };
}

// The most a depth `d` (in from both arms' edges, `u` and `v` in from their
// middles) may grow by before the point it gives lies further along either
// arm than `cap`, or null where even `d` 0 lies past it or behind a node.
function room(
	w: NonNullable<ReturnType<typeof between>>,
	u: number,
	v: number,
	cap: [number, number]
) {
	const at0 = w.along(w.at(u, v));
	const at1 = w.along(w.at(u + 1, v + 1));
	if (Math.min(...at0) < -1e-6 || at0[0] > cap[0] || at0[1] > cap[1]) return null;
	return Math.min(...[0, 1].map((k) => (cap[k] - at0[k]) / Math.max(1e-9, at1[k] - at0[k])));
}

// A joint: the ground between three or more footpath ends meeting at a
// node, or those at a car road's dead end (`car`), and the line a walker
// follows from each to every other. Each strip is still paved right up to
// the node; the joint is paved over them there.
//
// The ground held is the smallest convex shape holding each one's cross-
// section at the node, and each corner's outside (the way round between
// two next to each other wider than straight on) paved round the node as
// far out as they are half wide. Each corner's inside (less than straight
// on) is rounded by a circle touching their edges, JOINT.RADIUS half widths
// of the wider across, or tighter where it would reach past JOINT.REACH of
// either's length or past where either runs straight on from the node (a
// curve's edge leaves the line the corner is read along), and sharp where
// tighter than JOINT.TIGHTEST (strips meeting at a shallow angle cover each
// other there).
//
// A walker's line from one footpath to another runs along the middle of
// each from JOINT.LINK along it (further where the turn begins further
// out), and turns between them on a circle touching both middles, halfway
// between the inside of their corner and the node, as far along each as it
// runs straight on from the node. Where they run straight on, or the circle
// would lie behind the node, it runs straight through their ends at the
// node.
//
// At each car road's dead end its ends join (`cars`) each of its sidewalks
// is carried on past the end as far as the widest footpath there is wide,
// so the ground held reaches each across its whole width; nothing there is
// rounded.
function fillOf(ends: EndInfo[], cars: FixedEnd[]): NodeDescription {
	const edges = (p: Pt, n: Pt, lanes: { left: number; right: number }[]) =>
		lanes.length ? [offsetPoint(p, n, lanes[0].left), offsetPoint(p, n, lanes.at(-1)!.right)] : [];
	const arms: Arm[] = ends
		.filter((e) => e.lanes.length)
		.map((end) => {
			const m = middleAt(end, 0);
			const cap = JOINT.REACH * end.geo.path.length;
			const dir = end.frame.run;
			const straight = straightOn(end, m.p, dir, cap);
			return { end, p: m.p, dir, half: m.half, cap, straight };
		})
		.sort((a, b) => Math.atan2(a.dir.y, a.dir.x) - Math.atan2(b.dir.y, b.dir.x));
	const rounded = !cars.length && arms.length > 1;
	const pts = arms.flatMap((a) => {
		const n = a.end.frame.n;
		return [offsetPoint(a.p, n, -a.half), offsetPoint(a.p, n, a.half)];
	});
	const wide = Math.max(0, ...ends.map((e) => e.lanes.reduce((w, l) => w + l.right - l.left, 0)));
	for (const car of cars) {
		const f = endFrame(car.geo.road, car.geo.path, car.end);
		const past = offsetPoint(f.p, f.out, -wide);
		for (const walk of f.spans.filter((s) => isWalk(s.lane) && s.right - s.left > 0.05))
			pts.push(...edges(f.p, f.n, [walk]), ...edges(past, f.n, [walk]));
	}
	// Each two next to each other going round, the second anticlockwise of
	// the first: the outside of their corner paved round, its inside rounded
	// (`radius`, by the pair, for the walker's line).
	const fillets: Paths = [];
	const radius = new Map<string, number>();
	const pair = (a: Arm, b: Arm) => `${a.end.key}|${b.end.key}`;
	for (const [i, a] of (rounded ? arms : []).entries()) {
		const b = arms[(i + 1) % arms.length];
		// The way round from a to b, anticlockwise: past straight on, the
		// outside of a corner.
		const turn = Math.atan2(a.dir.x * b.dir.y - a.dir.y * b.dir.x, dot(a.dir, b.dir));
		const gap = turn >= 0 ? turn : turn + 2 * Math.PI;
		if (gap > Math.PI) {
			const [na, nb] = [ccw(a.dir), cw(b.dir)];
			const [from, to] = [Math.atan2(na.y, na.x), Math.atan2(nb.y, nb.x)];
			const sweep = (to - from + 2 * Math.PI) % (2 * Math.PI);
			for (let k = 1; k < JOINT.ARC; k++) {
				const f = k / JOINT.ARC;
				const t = from + sweep * f;
				const r = a.half + (b.half - a.half) * f;
				pts.push(offsetPoint(mix(a.p, b.p, f), { x: Math.cos(t), y: Math.sin(t) }, r));
			}
			continue;
		}
		const w = between(a, b);
		const space = w && room(w, a.half, b.half, [a.straight, b.straight]);
		const r = Math.min(JOINT.RADIUS * Math.max(a.half, b.half), space ?? 0);
		if (!w || r < JOINT.TIGHTEST) continue;
		radius.set(pair(a, b), r);
		const c = w.at(a.half + r, b.half + r);
		const arc = arcOf(c, neg(w.n[0]), neg(w.n[1]), r);
		fillets.push(toPath([w.at(a.half, b.half), ...arc]));
	}
	const faults: Pt[] = [];
	const ground = union([...(pts.length > 2 ? [toPath(hullOf(pts))] : []), ...fillets]);
	return paved(ends, toRings(ground, faults), walkersOf(arms, radius), faults);
}

// The line a walker follows between each two arms of a joint (fillOf), from
// the first to the second as they go round, with the radius of each inside
// corner rounded between two next to each other (`radius`, by the pair).
function walkersOf(arms: Arm[], radius: Map<string, number>): LanePath[] {
	// Each pair's turn: the circle's centre, radius and where it touches each.
	const turns = arms.flatMap((a, i) =>
		arms.slice(i + 1).map((b) => {
			// Read with the second anticlockwise of the first, less than
			// straight on.
			const flip = a.dir.x * b.dir.y - a.dir.y * b.dir.x < 0;
			const [x, y] = flip ? [b, a] : [a, b];
			const w = between(x, y);
			const inside = Math.min(x.half, y.half) + (radius.get(`${x.end.key}|${y.end.key}`) ?? 0);
			const space = w && room(w, 0, 0, [x.straight, y.straight]);
			const d = space === null ? 0 : Math.min(inside / 2, space);
			const c = w && d > 0 ? w.at(d, d) : null;
			const touch = c ? w!.along(c) : null;
			const at = touch && (flip ? [touch[1], touch[0]] : touch);
			return { a, b, w, d, c, at, x };
		})
	);
	// Where each arm's lines start: past every turn on it.
	const from = new Map(arms.map((a) => [a, linkFrom(a.end.geo.path.length)]));
	for (const t of turns)
		if (t.at) {
			from.set(t.a, Math.max(from.get(t.a)!, t.at[0]));
			from.set(t.b, Math.max(from.get(t.b)!, t.at[1]));
		}
	return turns.map(({ a, b, w, d, c, at, x }) => {
		let line: Pt[];
		if (w && c && at) {
			const arc = arcOf(c, neg(w.n[0]), neg(w.n[1]), d);
			line = [
				...middleLine(a.end, from.get(a)!, at[0]),
				...(x === a ? arc : [...arc].reverse()),
				...middleLine(b.end, at[1], from.get(b)!)
			];
		} else line = [...middleLine(a.end, from.get(a)!, 0), ...middleLine(b.end, 0, from.get(b)!)];
		line = dedupe(line);
		return {
			from: middleLane(a.end),
			to: middleLane(b.end),
			kind: 'walk',
			line,
			widths: line.map(() => 2 * Math.min(a.half, b.half))
		};
	});
}

// The line a walker follows from a footpath onto the walkway its end lies
// on: along the footpath's middle from JOINT.LINK along it (from that end)
// to its end, then to `to`, the walkway's middle there.
export function walkOnto(geo: RoadGeo, end: End, to: Pt) {
	const info: EndInfo = {
		ref: { road: geo.road.id, end },
		key: '',
		geo,
		frame: endFrame(geo.road, geo.path, end),
		lanes: []
	};
	return dedupe([...middleLine(info, linkFrom(geo.path.length), 0), to]);
}
