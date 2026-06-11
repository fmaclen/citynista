import ClipperLib from 'clipper-lib';
import type { Path, Paths, PolyNode, PolyTree } from 'clipper-lib';
import type { Graph } from './graph.svelte';
import type { Node } from './node.svelte';
import type { Segment } from './segment.svelte';
import type { Lane, LaneType } from './types';
import { getTotalWidth } from './lane-template';
import { getQuadraticBezierPoint, getQuadraticBezierTangent } from '../geometry/bezier';

export interface Point {
	x: number;
	y: number;
}

export type RoadLayerId = LaneType;

export interface PolygonWithHoles {
	outer: Point[];
	holes: Point[][];
}

export interface RoadLayer {
	id: RoadLayerId;
	polygons: PolygonWithHoles[];
}

const CLIPPER_SCALE = 1000;
const CURVE_SAMPLES = 32;

// How far roads stop short of the crossing road's edge at an intersection.
const INTERSECTION_GAP = 4;
const CORNER_CURVE_SAMPLES = 12;

// Small dilate-erode pass that seals hairline cracks where generated pieces
// share an edge. Corner geometry is explicit, so this stays tiny.
const CURB_RADIUS: Record<RoadLayerId, number> = {
	sidewalk: 1.5,
	grass: 1,
	road: 1.5,
	median: 1
};

const JUNCTION_DISC_SCALE = 1.5;

// Bottom-to-top draw order. Road covers crossing sidewalk/grass strips inside
// junctions; median sits on the roadway.
export const LAYER_ORDER: RoadLayerId[] = ['sidewalk', 'grass', 'road', 'median'];

interface LaneInterval {
	laneType: LaneType;
	start: number;
	end: number;
}

export function buildRoadLayers(graph: Graph): RoadLayer[] {
	const bandsByType = new Map<LaneType, Paths>();
	const trims = computeIntersectionTrims(graph);
	const centerlines = new Map<string, CenterlineSample[]>();

	for (const segment of graph.segments.values()) {
		const startNode = graph.nodes.get(segment.startNodeId);
		const endNode = graph.nodes.get(segment.endNodeId);
		if (!startNode || !endNode) continue;

		if (segment.lanes.length === 0) continue;

		const trim = trims.get(segment.id);
		const centerline = sampleTrimmedCenterline(
			segment,
			startNode,
			endNode,
			trim?.start ?? 0,
			trim?.end ?? 0
		);
		if (centerline.length < 2) continue;
		centerlines.set(segment.id, centerline);

		for (const interval of getLaneIntervals(segment.lanes)) {
			const band = buildBandPath(centerline, interval.start, interval.end);
			const bands = bandsByType.get(interval.laneType);
			if (bands) {
				bands.push(band);
			} else {
				bandsByType.set(interval.laneType, [band]);
			}
		}
	}

	for (const node of graph.nodes.values()) {
		if (node.connectedSegments.length < 2) continue;
		addNodeGeometry(graph, node, centerlines, bandsByType);
	}

	const junctionDiscs = buildJunctionDiscs(graph);

	const allBands: Paths = [];
	for (const bands of bandsByType.values()) {
		allBands.push(...bands);
	}
	if (allBands.length === 0) return [];

	// The sidewalk layer is the full pavement plate: the solid union of every
	// band plus junction curb fillets. Road, grass, and median draw on top of
	// it, so it shows through only along edges and in junction pockets —
	// and no hairline crevice between layers can exist by construction.
	const plate = applyCurbRounding(unionPaths(allBands), CURB_RADIUS.sidewalk, junctionDiscs);

	const layerPaths = new Map<RoadLayerId, Paths>();
	layerPaths.set('sidewalk', plate);

	const roadBands = bandsByType.get('road');
	if (roadBands && roadBands.length > 0) {
		layerPaths.set(
			'road',
			applyCurbRounding(unionPaths(roadBands), CURB_RADIUS.road, junctionDiscs)
		);
	}

	const grassBands = bandsByType.get('grass');
	if (grassBands && grassBands.length > 0) {
		// Grass verges never cross a roadway or a crossing road's sidewalk.
		let grassPaths = applyCurbRounding(unionPaths(grassBands), CURB_RADIUS.grass, junctionDiscs);
		const pavement = [...(layerPaths.get('road') ?? []), ...(bandsByType.get('sidewalk') ?? [])];
		if (pavement.length > 0) {
			grassPaths = subtractPaths(grassPaths, pavement);
		}
		layerPaths.set('grass', grassPaths);
	}

	const medianBands = bandsByType.get('median');
	if (medianBands && medianBands.length > 0) {
		layerPaths.set(
			'median',
			applyCurbRounding(unionPaths(medianBands), CURB_RADIUS.median, junctionDiscs)
		);
	}

	const layers: RoadLayer[] = [];

	for (const layerId of LAYER_ORDER) {
		const paths = layerPaths.get(layerId);
		if (!paths) continue;

		const polygons = pathsToPolygons(paths);
		if (polygons.length > 0) {
			layers.push({ id: layerId, polygons });
		}
	}

	return layers;
}

export function getLaneIntervals(lanes: Lane[]): LaneInterval[] {
	const intervals: LaneInterval[] = [];
	let offset = -getTotalWidth(lanes) / 2;

	for (const lane of lanes) {
		const previous = intervals[intervals.length - 1];
		if (previous && previous.laneType === lane.type) {
			previous.end += lane.width;
		} else {
			intervals.push({ laneType: lane.type, start: offset, end: offset + lane.width });
		}
		offset += lane.width;
	}

	return intervals;
}

export interface CenterlineSample {
	x: number;
	y: number;
	normalX: number;
	normalY: number;
}

interface SegmentTrim {
	start: number;
	end: number;
}

// A node gets the intersection treatment (stop lines + pavement patch) when
// 3+ roads meet, or when two roads form a corner sharper than a gentle bend.
// Gentle two-segment bends keep their continuous swept join so polyline
// roads don't break their lane structure at every vertex.
const CORNER_PATCH_MIN_DOT = Math.cos((135 * Math.PI) / 180);

function segmentHasRoad(segment: Segment): boolean {
	return segment.lanes.some((lane) => lane.type === 'road');
}

function validNodeSegments(graph: Graph, node: Node): Segment[] {
	const segments: Segment[] = [];
	for (const segmentId of node.connectedSegments) {
		const segment = graph.segments.get(segmentId);
		if (segment && segment.lanes.length > 0) {
			segments.push(segment);
		}
	}
	return segments;
}

// The pair of segments that defines how a node connects. Road-bearing
// segments outrank paths: two roads continue through a node (median and
// verges included) no matter how many paths attach to it — the paths join
// with pavement aprons instead of forcing a junction.
function connectionPair(graph: Graph, node: Node): [Segment, Segment] | null {
	const segments = validNodeSegments(graph, node);
	const majors = segments.filter(segmentHasRoad);
	const counted = majors.length >= 2 ? majors : segments;
	return counted.length === 2 ? [counted[0], counted[1]] : null;
}

function segmentOutwardAtNode(graph: Graph, node: Node, segment: Segment): Point | null {
	const startNode = graph.nodes.get(segment.startNodeId);
	const endNode = graph.nodes.get(segment.endNodeId);
	if (!startNode || !endNode) return null;

	const isStart = segment.startNodeId === node.id;
	const tangent = getSegmentTangentAtNode(segment, startNode, endNode, isStart);
	return isStart ? tangent : { x: -tangent.x, y: -tangent.y };
}

function pairIsSharp(graph: Graph, node: Node, a: Segment, b: Segment): boolean {
	const outwardA = segmentOutwardAtNode(graph, node, a);
	const outwardB = segmentOutwardAtNode(graph, node, b);
	if (!outwardA || !outwardB) return false;
	return outwardA.x * outwardB.x + outwardA.y * outwardB.y > CORNER_PATCH_MIN_DOT;
}

function isPatchNode(graph: Graph, node: Node): boolean {
	const segments = validNodeSegments(graph, node);
	const majors = segments.filter(segmentHasRoad);
	const counted = majors.length >= 2 ? majors : segments;

	if (counted.length >= 3) return true;
	if (counted.length !== 2) return false;
	// Only same-type sharp corners take the junction treatment (corner
	// bands). Different cross-sections always morph, whatever the angle —
	// otherwise the rendering would flip between two looks the moment a
	// dragged bend crosses the sharpness threshold.
	if (counted[0].lanesKey !== counted[1].lanesKey) return false;
	return pairIsSharp(graph, node, counted[0], counted[1]);
}

// Shallowest crossing angle the trim math uses: anything flatter is treated
// as this, so near-tangent arms don't trim back across the whole map.
const MIN_CROSSING_SIN = 0.15;

// Where two different cross-sections continue into each other, each segment
// morphs its own strips toward a blended cross-section over this length, so
// both sides arrive at the node with identical offsets. The taper length
// scales with how much the width changes.
const TRANSITION_TAPER = 10;
const TRANSITION_MIN_LENGTH = 8;
const TRANSITION_MAX_LENGTH = 60;

// A continuation node whose connection pair joins two different
// cross-sections — rendered by morphing both segments' ribbons.
function isTransitionNode(graph: Graph, node: Node): boolean {
	const pair = connectionPair(graph, node);
	if (!pair || isPatchNode(graph, node)) return false;
	return pair[0].lanesKey !== pair[1].lanesKey;
}

function mirrorIntervals(intervals: LaneInterval[]): LaneInterval[] {
	return intervals
		.map((interval) => ({
			laneType: interval.laneType,
			start: -interval.end,
			end: -interval.start
		}))
		.reverse();
}

// Islands (grass and median strips) connect across types: a median flows
// into a grass strip and vice versa, centered or not. Best same-type overlap
// wins; otherwise the nearest island within reach (center distance no more
// than the two widths combined, so verges never grab a far-away center
// strip). Null means the strip has nothing to flow into and ends instead.
function islandMatch(interval: LaneInterval, candidates: LaneInterval[]): LaneInterval | null {
	const center = (i: { start: number; end: number }) => (i.start + i.end) / 2;
	const width = (i: { start: number; end: number }) => i.end - i.start;

	let best: LaneInterval | null = null;
	let bestOverlap = 0;
	for (const candidate of candidates) {
		if (candidate.laneType !== interval.laneType) continue;
		const overlap =
			Math.min(interval.end, candidate.end) - Math.max(interval.start, candidate.start);
		if (overlap > bestOverlap) {
			bestOverlap = overlap;
			best = candidate;
		}
	}
	if (best) return best;

	let nearest: LaneInterval | null = null;
	let nearestDistance = Infinity;
	for (const candidate of candidates) {
		if (candidate.laneType !== 'grass' && candidate.laneType !== 'median') continue;
		const distance = Math.abs(center(candidate) - center(interval));
		if (distance < nearestDistance) {
			nearest = candidate;
			nearestDistance = distance;
		}
	}
	if (nearest && nearestDistance <= width(interval) + width(nearest)) {
		return nearest;
	}
	return null;
}

export interface TransitionMorph {
	// Target offsets at the node for each of the segment's own lane
	// intervals (indexed like getLaneIntervals). Null means the strip has no
	// counterpart at all — it ends in a square cut where the morph begins
	// instead of pinching into a sliver.
	intervals: ({ start: number; end: number } | null)[];
	halfWidth: number;
	length: number;
	// Compact form for piece hashes.
	key: string;
}

// How a segment's cross-section morphs into the other side of a transition
// node. The NARROWER side anchors the node: its own cross-section is the
// shared target, it stays untouched (identity morph), and only the wider
// side necks down to meet it — one monotone taper, no waviness. Matched
// strips morph to the anchor strip's offsets, the roadway falls back to the
// anchor's bounding span when the carriageway count changes, center strips
// match across types (a grass center tapers to a median's width), and
// unmatched strips end in a square cut.
export function transitionMorph(
	graph: Graph,
	node: Node,
	segmentId: string
): TransitionMorph | null {
	if (!isTransitionNode(graph, node)) return null;

	const pair = connectionPair(graph, node)!;
	if (pair[0].id !== segmentId && pair[1].id !== segmentId) return null;

	const self = pair[0].id === segmentId ? pair[0] : pair[1];
	const other = pair[0].id === segmentId ? pair[1] : pair[0];

	const halfSelf = getTotalWidth(self.lanes) / 2;
	const halfOther = getTotalWidth(other.lanes) / 2;

	const selfIntervals = getLaneIntervals(self.lanes);

	// Deterministic from both sides: the narrower segment anchors; equal
	// widths fall back to the lane-stack key.
	const selfIsAnchor =
		halfSelf < halfOther - 0.01 ||
		(Math.abs(halfSelf - halfOther) <= 0.01 && self.lanesKey <= other.lanesKey);

	if (selfIsAnchor) {
		// The anchor never morphs, so its length is only carried for the
		// piece hash.
		const length = Math.min(
			TRANSITION_MAX_LENGTH,
			Math.max(TRANSITION_MIN_LENGTH, Math.abs(halfSelf - halfOther) * TRANSITION_TAPER)
		);
		return {
			intervals: selfIntervals.map((interval) => ({ start: interval.start, end: interval.end })),
			halfWidth: halfSelf,
			length,
			key: `${length}:${halfSelf}:anchor`
		};
	}

	// Frames continue head-to-tail only when one segment ends here and the
	// other starts here; otherwise the anchor's frame is mirrored.
	const flipped = (self.startNodeId === node.id) === (other.startNodeId === node.id);
	let anchorIntervals = getLaneIntervals(other.lanes);
	if (flipped) anchorIntervals = mirrorIntervals(anchorIntervals);

	const at = (interval: { start: number; end: number }) => ({
		start: interval.start,
		end: interval.end
	});
	const bounding = (intervals: LaneInterval[]) => ({
		start: Math.min(...intervals.map((i) => i.start)),
		end: Math.max(...intervals.map((i) => i.end))
	});

	const targets = selfIntervals.map((interval) => {
		if (interval.laneType === 'sidewalk') {
			// Sidewalk renders via the full-width plate; per-strip targets
			// are unused but kept index-aligned.
			return at(interval);
		}

		const own = selfIntervals.filter((i) => i.laneType === interval.laneType);
		const counterparts = anchorIntervals.filter((i) => i.laneType === interval.laneType);

		if (own.length === counterparts.length && counterparts.length > 0) {
			return at(counterparts[own.indexOf(interval)]);
		}

		if (interval.laneType === 'road') {
			const anchorRoads = anchorIntervals.filter((i) => i.laneType === 'road');
			if (anchorRoads.length > 0) {
				return at(bounding(anchorRoads));
			}
			return {
				start: (interval.start + interval.end) / 2,
				end: (interval.start + interval.end) / 2
			};
		}

		const match = islandMatch(interval, anchorIntervals);
		return match ? at(match) : null;
	});

	// The taper length scales with the largest edge displacement any strip
	// undergoes — lateral shifts (off-center medians, turning-lane stacks)
	// need just as much easing room as width changes, which this subsumes:
	// the plate's outer edges displace by exactly the half-width difference.
	let maxShift = Math.abs(halfSelf - halfOther);
	for (let k = 0; k < targets.length; k++) {
		const target = targets[k];
		if (!target) continue;
		maxShift = Math.max(
			maxShift,
			Math.abs(target.start - selfIntervals[k].start),
			Math.abs(target.end - selfIntervals[k].end)
		);
	}
	const length = Math.min(
		TRANSITION_MAX_LENGTH,
		Math.max(TRANSITION_MIN_LENGTH, maxShift * TRANSITION_TAPER)
	);

	return {
		intervals: targets,
		halfWidth: halfOther,
		length,
		key: `${length}:${halfOther}:${targets.map((t) => (t ? `${t.start},${t.end}` : 'x')).join(';')}`
	};
}

// At patch nodes every road stops short of the node: far enough back that
// its mouth clears every crossing road's edge, plus a fixed gap. For arms
// meeting at a shallow angle the pullback grows with 1/sin so the mouth
// actually exits the other road's corridor — but only for arms no wider
// than the one they're clearing, so a major road never yields to a narrow
// shallow ramp or path.
export function computeIntersectionTrims(graph: Graph): Map<string, SegmentTrim> {
	const trims = new Map<string, SegmentTrim>();

	const applyTrim = (segmentId: string, atNode: Node, trim: number) => {
		const segment = graph.segments.get(segmentId);
		if (!segment) return;

		const existing = trims.get(segmentId) ?? { start: 0, end: 0 };
		if (segment.startNodeId === atNode.id) {
			existing.start = Math.max(existing.start, trim);
		}
		if (segment.endNodeId === atNode.id) {
			existing.end = Math.max(existing.end, trim);
		}
		trims.set(segmentId, existing);
	};

	for (const node of graph.nodes.values()) {
		interface TrimArm {
			segmentId: string;
			halfWidth: number;
			hasRoad: boolean;
			lanesKey: string;
			outward: Point;
		}
		const arms: TrimArm[] = [];
		for (const segment of validNodeSegments(graph, node)) {
			const outward = segmentOutwardAtNode(graph, node, segment);
			if (!outward) continue;

			arms.push({
				segmentId: segment.id,
				halfWidth: segment.totalWidth / 2,
				hasRoad: segmentHasRoad(segment),
				lanesKey: segment.lanesKey,
				outward
			});
		}
		if (arms.length < 2) continue;

		// Which arm pairs actually clear each other: roads only at real
		// junctions (a continuing or transitioning road is never cut), paths
		// always pull back from roads, roads never yield to paths, and paths
		// clear each other unless they continue one another.
		const majorJunction = isPatchNode(graph, node);
		// A continuing or transitioning pair never clears itself — only the
		// transition trims above apply between its two members.
		const pair = !majorJunction ? connectionPair(graph, node) : null;
		const pairIds = pair ? new Set([pair[0].id, pair[1].id]) : null;
		const majors = arms.filter((arm) => arm.hasRoad);
		const minors = arms.filter((arm) => !arm.hasRoad);
		let minorJunction = majorJunction;
		if (majors.length >= 2) {
			minorJunction =
				minors.length >= 3 ||
				(minors.length === 2 &&
					(minors[0].lanesKey !== minors[1].lanesKey ||
						minors[0].outward.x * minors[1].outward.x + minors[0].outward.y * minors[1].outward.y >
							CORNER_PATCH_MIN_DOT));
		}

		for (const arm of arms) {
			let trim = 0;
			for (const other of arms) {
				if (other.segmentId === arm.segmentId) continue;
				if (pairIds?.has(arm.segmentId) && pairIds.has(other.segmentId)) continue;

				let applies: boolean;
				if (arm.hasRoad) {
					applies = other.hasRoad && majorJunction;
				} else {
					applies = other.hasRoad || minorJunction;
				}
				if (!applies) continue;

				const cos = arm.outward.x * other.outward.x + arm.outward.y * other.outward.y;
				let required = other.halfWidth + INTERSECTION_GAP;
				if (cos > 0 && arm.halfWidth <= other.halfWidth + 0.01) {
					const sin = Math.max(
						Math.abs(arm.outward.x * other.outward.y - arm.outward.y * other.outward.x),
						MIN_CROSSING_SIN
					);
					required = (other.halfWidth + INTERSECTION_GAP + arm.halfWidth * cos) / sin;
				}
				trim = Math.max(trim, required);
			}

			if (trim > 0) {
				applyTrim(arm.segmentId, node, trim);
			}
		}
	}

	return trims;
}

export function sampleTrimmedCenterline(
	segment: Segment,
	startNode: Node,
	endNode: Node,
	trimStart: number,
	trimEnd: number
): CenterlineSample[] {
	const base = sampleCenterline(segment, startNode, endNode);
	return trimCenterline(base, trimStart, trimEnd);
}

export function trimCenterline(
	base: CenterlineSample[],
	trimStart: number,
	trimEnd: number
): CenterlineSample[] {
	if (base.length < 2 || (trimStart <= 0 && trimEnd <= 0)) return base;

	const cumulative: number[] = [0];
	for (let i = 1; i < base.length; i++) {
		const dx = base[i].x - base[i - 1].x;
		const dy = base[i].y - base[i - 1].y;
		cumulative.push(cumulative[i - 1] + Math.sqrt(dx * dx + dy * dy));
	}
	const total = cumulative[cumulative.length - 1];

	// Keep at least a sliver of road between two close intersections.
	const maxTrim = total * 0.45;
	const from = Math.min(trimStart, maxTrim);
	const to = total - Math.min(trimEnd, maxTrim);
	if (to - from < 0.1) return [];

	const samples: CenterlineSample[] = [sampleAtDistance(base, cumulative, from)];
	for (let i = 0; i < base.length; i++) {
		if (cumulative[i] > from && cumulative[i] < to) {
			samples.push(base[i]);
		}
	}
	samples.push(sampleAtDistance(base, cumulative, to));
	return samples;
}

function sampleAtDistance(
	base: CenterlineSample[],
	cumulative: number[],
	distance: number
): CenterlineSample {
	for (let i = 1; i < base.length; i++) {
		if (cumulative[i] < distance) continue;

		const spanLength = cumulative[i] - cumulative[i - 1];
		const t = spanLength > 0.0001 ? (distance - cumulative[i - 1]) / spanLength : 0;
		const a = base[i - 1];
		const b = base[i];

		let normalX = a.normalX + (b.normalX - a.normalX) * t;
		let normalY = a.normalY + (b.normalY - a.normalY) * t;
		const len = Math.sqrt(normalX * normalX + normalY * normalY);
		if (len > 0.0001) {
			normalX /= len;
			normalY /= len;
		}

		return {
			x: a.x + (b.x - a.x) * t,
			y: a.y + (b.y - a.y) * t,
			normalX,
			normalY
		};
	}
	return base[base.length - 1];
}

function sampleCenterline(segment: Segment, startNode: Node, endNode: Node): CenterlineSample[] {
	const samples: CenterlineSample[] = [];
	const numSamples = segment.hasControlPoint ? CURVE_SAMPLES : 1;

	for (let i = 0; i <= numSamples; i++) {
		const t = i / numSamples;
		let px: number, py: number, tx: number, ty: number;

		if (segment.hasControlPoint) {
			const point = getQuadraticBezierPoint(
				startNode.x,
				startNode.y,
				segment.controlX!,
				segment.controlY!,
				endNode.x,
				endNode.y,
				t
			);
			const tangent = getQuadraticBezierTangent(
				startNode.x,
				startNode.y,
				segment.controlX!,
				segment.controlY!,
				endNode.x,
				endNode.y,
				t
			);
			px = point.x;
			py = point.y;
			tx = tangent.x;
			ty = tangent.y;
		} else {
			px = startNode.x + t * (endNode.x - startNode.x);
			py = startNode.y + t * (endNode.y - startNode.y);
			tx = endNode.x - startNode.x;
			ty = endNode.y - startNode.y;
		}

		const len = Math.sqrt(tx * tx + ty * ty);
		if (len < 0.0001) continue;

		samples.push({ x: px, y: py, normalX: -ty / len, normalY: tx / len });
	}

	return samples;
}

function buildBandPath(centerline: CenterlineSample[], start: number, end: number): Path {
	const path: Path = [];

	for (const sample of centerline) {
		path.push(toClipperPoint(sample.x + sample.normalX * start, sample.y + sample.normalY * start));
	}
	for (let i = centerline.length - 1; i >= 0; i--) {
		const sample = centerline[i];
		path.push(toClipperPoint(sample.x + sample.normalX * end, sample.y + sample.normalY * end));
	}

	return normalizeWinding(path);
}

interface NodeArm {
	segmentId: string;
	normal: Point;
	outward: Point;
	startsHere: boolean;
	lanes: Lane[];
	lanesKey: string;
}

const MIN_JOIN_ANGLE = 0.05;
const WEDGE_ANGLE_STEP = Math.PI / 16;

// How a node renders, driven by its connection pair: two roads continue,
// corner, or transition into each other regardless of attached paths (which
// get pavement aprons); everything else is a junction patch or a plain join.
function addNodeGeometry(
	graph: Graph,
	node: Node,
	centerlines: Map<string, CenterlineSample[]>,
	bandsByType: Map<LaneType, Paths>
) {
	const segments = validNodeSegments(graph, node);
	if (segments.length < 2) return;

	const pair = connectionPair(graph, node);
	if (pair && segments.length > 2) {
		const [pa, pb] = pair;
		const sameKey = pa.lanesKey === pb.lanesKey;
		const sharp = pairIsSharp(graph, node, pa, pb);

		const pairIds = new Set([pa.id, pb.id]);
		if (!sameKey) {
			addTransitionJoin(graph, node, bandsByType, pairIds);
		} else if (sharp) {
			const arms = collectIntersectionArms(graph, node, centerlines, pairIds);
			if (arms.length === 2) {
				addCornerBands(arms[0], arms[1], bandsByType);
			}
		} else {
			addNodeJoins(graph, node, centerlines, bandsByType, pairIds);
		}

		for (const segment of segments) {
			if (!pairIds.has(segment.id)) {
				addApron(graph, node, segment, centerlines, bandsByType);
			}
		}
		return;
	}

	if (isPatchNode(graph, node)) {
		addIntersection(graph, node, centerlines, bandsByType);
	} else {
		addNodeJoins(graph, node, centerlines, bandsByType);
	}
}

// Pavement apron connecting a path's mouth to the roadway it attaches to: a
// straight plate band from the mouth to the node, sitting under the road.
function addApron(
	graph: Graph,
	node: Node,
	segment: Segment,
	centerlines: Map<string, CenterlineSample[]>,
	bandsByType: Map<LaneType, Paths>
) {
	const centerline = centerlines.get(segment.id);
	if (!centerline || centerline.length < 2) return;

	const isStart = segment.startNodeId === node.id;
	const stop = isStart ? centerline[0] : centerline[centerline.length - 1];
	const inner = isStart ? centerline[1] : centerline[centerline.length - 2];

	const into = normalizeVector({ x: stop.x - inner.x, y: stop.y - inner.y });
	if (!into) return;

	const reach = Math.hypot(node.x - stop.x, node.y - stop.y);
	const halfWidth = segment.totalWidth / 2;

	const band: Path = [
		toClipperPoint(stop.x - stop.normalX * halfWidth, stop.y - stop.normalY * halfWidth),
		toClipperPoint(stop.x + stop.normalX * halfWidth, stop.y + stop.normalY * halfWidth),
		toClipperPoint(
			stop.x + into.x * reach + stop.normalX * halfWidth,
			stop.y + into.y * reach + stop.normalY * halfWidth
		),
		toClipperPoint(
			stop.x + into.x * reach - stop.normalX * halfWidth,
			stop.y + into.y * reach - stop.normalY * halfWidth
		)
	];
	getOrCreateBands(bandsByType, 'sidewalk').push(normalizeWinding(band));
}

// Bands butt-end exactly at their nodes, which leaves a wedge-shaped notch on
// the outer side of every bend. Fill each lane layer's swept cross-section
// between adjacent segments — the polygon equivalent of a round line join.
// Nodes joining two different cross-sections get a tapered transition piece
// between the trimmed mouths instead.
function addNodeJoins(
	graph: Graph,
	node: Node,
	centerlines: Map<string, CenterlineSample[]>,
	bandsByType: Map<LaneType, Paths>,
	only?: Set<string>
) {
	if (!only && isTransitionNode(graph, node)) {
		addTransitionJoin(graph, node, bandsByType);
		return;
	}

	const arms = collectNodeArms(graph, node, only);
	if (arms.length < 2) return;

	arms.sort((a, b) => Math.atan2(a.outward.y, a.outward.x) - Math.atan2(b.outward.y, b.outward.x));

	const center = { x: node.x, y: node.y };
	const pairCount = arms.length === 2 ? 1 : arms.length;

	for (let i = 0; i < pairCount; i++) {
		const armA = arms[i];
		const armB = arms[(i + 1) % arms.length];

		// Frames continue head-to-tail only when one segment ends here and the
		// other starts here; otherwise armB's frame is mirrored, so both its
		// normal and its interval list flip.
		const flipped = armA.startsHere === armB.startsHere;
		const normalB = flipped ? { x: -armB.normal.x, y: -armB.normal.y } : armB.normal;

		const rotation = rotationBetween(armA.normal, normalB);
		if (Math.abs(rotation) < MIN_JOIN_ANGLE) continue;

		const dirs = sampleArcDirections(armA.normal, rotation);

		const intervalsA = getLaneIntervals(armA.lanes);
		const intervalsB = getLaneIntervals(armB.lanes);
		for (let k = 0; k < intervalsA.length; k++) {
			const raw = flipped ? intervalsB[intervalsB.length - 1 - k] : intervalsB[k];
			const counterpart = flipped
				? { laneType: raw.laneType, start: -raw.end, end: -raw.start }
				: raw;
			const bands = getOrCreateBands(bandsByType, intervalsA[k].laneType);
			addWedgePieces(bands, center, dirs, intervalsA[k], counterpart);
		}
	}
}

// At a transition node both ribbons have already morphed to the same
// blended cross-section (see transitionMorph), so the node is locally a
// continuation: fill the bend notch with swept wedges over the blended
// strips, exactly like a same-key join. Straight transitions need nothing.
function addTransitionJoin(
	graph: Graph,
	node: Node,
	bandsByType: Map<LaneType, Paths>,
	only?: Set<string>
) {
	const pair = connectionPair(graph, node);
	if (!pair) return;

	const morph = transitionMorph(graph, node, pair[0].id);
	if (!morph) return;

	const arms = collectNodeArms(graph, node, only ?? new Set([pair[0].id, pair[1].id]));
	if (arms.length !== 2) return;

	// The morph targets live in pair[0]'s frame; sweep from that arm.
	const armA = arms[0].segmentId === pair[0].id ? arms[0] : arms[1];
	const armB = armA === arms[0] ? arms[1] : arms[0];

	const flipped = armA.startsHere === armB.startsHere;
	const normalB = flipped ? { x: -armB.normal.x, y: -armB.normal.y } : armB.normal;
	const rotation = rotationBetween(armA.normal, normalB);
	if (Math.abs(rotation) < MIN_JOIN_ANGLE) return;

	// Sweep slightly past both mouths so the wedge overlaps the ribbons
	// instead of meeting them edge-to-edge.
	const sweep = Math.sign(rotation) * 0.06;
	const cos = Math.cos(-sweep);
	const sin = Math.sin(-sweep);
	const from = {
		x: armA.normal.x * cos - armA.normal.y * sin,
		y: armA.normal.x * sin + armA.normal.y * cos
	};
	const dirs = sampleArcDirections(from, rotation + 2 * sweep);
	const center = { x: node.x, y: node.y };

	const plate = { laneType: 'sidewalk' as LaneType, start: -morph.halfWidth, end: morph.halfWidth };
	addWedgePieces(getOrCreateBands(bandsByType, 'sidewalk'), center, dirs, plate, plate);

	const intervals = getLaneIntervals(pair[0].lanes);
	const targetFor = (k: number) => {
		const target = morph.intervals[k];
		if (!target || target.end - target.start < BAND_EPSILON) return null;
		return { laneType: intervals[k].laneType, start: target.start, end: target.end };
	};

	// Grass renders under asphalt, so a continuing grass center needs the
	// roadway split around it; otherwise the roadway spans its bounding
	// width — a nosed median's column stays asphalt through the bend.
	const grassCenterContinues = intervals.some((interval, k) => {
		const target = targetFor(k);
		return (
			interval.laneType === 'grass' &&
			target !== null &&
			target.start < BAND_EPSILON &&
			target.end > -BAND_EPSILON
		);
	});

	const roadTargets: { laneType: LaneType; start: number; end: number }[] = [];
	for (let k = 0; k < intervals.length; k++) {
		if (intervals[k].laneType === 'sidewalk') continue;

		const piece = targetFor(k);
		if (!piece) continue;

		if (piece.laneType === 'road') {
			roadTargets.push(piece);
			continue;
		}
		addWedgePieces(getOrCreateBands(bandsByType, piece.laneType), center, dirs, piece, piece);
	}

	if (roadTargets.length > 0) {
		const roadPieces = grassCenterContinues
			? roadTargets
			: [
					{
						laneType: 'road' as LaneType,
						start: Math.min(...roadTargets.map((p) => p.start)),
						end: Math.max(...roadTargets.map((p) => p.end))
					}
				];
		for (const piece of roadPieces) {
			addWedgePieces(getOrCreateBands(bandsByType, 'road'), center, dirs, piece, piece);
		}
	}
}

interface IntersectionArm {
	stop: Point;
	into: Point;
	// perp(into) — points toward the corner shared with the next arm in the
	// sorted order; the previous arm's corner sits at -side.
	side: Point;
	// World direction of the segment's positive-offset side.
	crossDir: Point;
	startsHere: boolean;
	lanes: Lane[];
	lanesKey: string;
	halfWidth: number;
	hasRoad: boolean;
	toward: SideProfile;
	away: SideProfile;
}

function collectIntersectionArms(
	graph: Graph,
	node: Node,
	centerlines: Map<string, CenterlineSample[]>,
	only?: Set<string>
): IntersectionArm[] {
	const arms: IntersectionArm[] = [];

	for (const segmentId of node.connectedSegments) {
		if (only && !only.has(segmentId)) continue;

		const segment = graph.segments.get(segmentId);
		if (!segment) continue;

		const centerline = centerlines.get(segmentId);
		if (!centerline || centerline.length < 2) continue;

		if (segment.lanes.length === 0) continue;

		const isStart = segment.startNodeId === node.id;
		const stopSample = isStart ? centerline[0] : centerline[centerline.length - 1];
		const innerSample = isStart ? centerline[1] : centerline[centerline.length - 2];

		const into = normalizeVector({
			x: stopSample.x - innerSample.x,
			y: stopSample.y - innerSample.y
		});
		if (!into) continue;

		// perp(into) lands on the segment's positive-offset side when the
		// segment starts here, on the negative side when it ends here.
		const profile = getArmProfile(segment.lanes);
		const side = { x: into.y, y: -into.x };
		arms.push({
			stop: { x: stopSample.x, y: stopSample.y },
			into,
			side,
			crossDir: isStart ? side : { x: -side.x, y: -side.y },
			startsHere: isStart,
			lanes: segment.lanes,
			lanesKey: segment.lanesKey,
			halfWidth: profile.halfWidth,
			hasRoad: profile.hasRoad,
			toward: isStart ? profile.positive : profile.negative,
			away: isStart ? profile.negative : profile.positive
		});
	}

	return arms;
}

// A patch node is built explicitly: every road already stops at its trimmed
// stop line; an asphalt patch connects the road-bearing mouths, and sidewalk
// bands wrap every corner between adjacent arms, blending between their real
// sidewalk widths. Path arms join the junction through the sidewalk ring
// rather than the asphalt patch.
function addIntersection(
	graph: Graph,
	node: Node,
	centerlines: Map<string, CenterlineSample[]>,
	bandsByType: Map<LaneType, Paths>
) {
	const arms = collectIntersectionArms(graph, node, centerlines);
	if (arms.length < 2) return;

	// A sharp corner of one road type keeps its full cross-section: every
	// lane turns the corner instead of stopping at a junction patch.
	if (arms.length === 2 && arms[0].lanesKey === arms[1].lanesKey) {
		addCornerBands(arms[0], arms[1], bandsByType);
		return;
	}

	arms.sort((a, b) => Math.atan2(-a.into.y, -a.into.x) - Math.atan2(-b.into.y, -b.into.x));

	// Full pavement plate: every arm's stop-line mouth connected by the outer
	// corner curves. One solid polygon seals the junction interior gray by
	// construction, whatever mix of roads and paths meets here; the asphalt
	// patch and medians draw on top of it. Grass never enters a junction —
	// verges stop square at their stop lines and the corners are pavement.
	const sidewalkBands = getOrCreateBands(bandsByType, 'sidewalk');
	const plate: Point[] = [];
	for (let i = 0; i < arms.length; i++) {
		const armA = arms[i];
		const armB = arms[(i + 1) % arms.length];

		plate.push(offsetPoint(armA.stop, armA.side, -armA.halfWidth));
		plate.push(
			...sampleCornerCurve(
				offsetPoint(armA.stop, armA.side, armA.halfWidth),
				armA.into,
				offsetPoint(armB.stop, armB.side, -armB.halfWidth),
				armB.into
			)
		);
	}
	sidewalkBands.push(normalizeWinding(plate.map((point) => toClipperPoint(point.x, point.y))));

	const roadArms = arms.filter((arm) => arm.hasRoad);
	if (roadArms.length < 2) return;

	const patch: Point[] = [];
	for (let i = 0; i < roadArms.length; i++) {
		const armA = roadArms[i];
		const armB = roadArms[(i + 1) % roadArms.length];

		// Stop-line edge of arm A, then the corner curve over to arm B.
		patch.push(offsetPoint(armA.stop, armA.side, -armA.away.roadEdge));
		patch.push(
			...sampleCornerCurve(
				offsetPoint(armA.stop, armA.side, armA.toward.roadEdge),
				armA.into,
				offsetPoint(armB.stop, armB.side, -armB.away.roadEdge),
				armB.into
			)
		);
	}

	const roadBands = getOrCreateBands(bandsByType, 'road');
	roadBands.push(normalizeWinding(patch.map((point) => toClipperPoint(point.x, point.y))));
}

// Two arms of the same road type meeting at a sharp corner: every lane
// interval crosses the corner as its own band between matched edge curves,
// so the full cross-section (median and verges included) turns the bend.
// Adjacent intervals share edge curves, so the bands tile without gaps.
function addCornerBands(
	armA: IntersectionArm,
	armB: IntersectionArm,
	bandsByType: Map<LaneType, Paths>
) {
	// Frames continue head-to-tail only when one segment ends here and the
	// other starts here; otherwise mirror armB so world sides match up. This
	// is topological on purpose — at a right angle the two positive sides
	// are perpendicular and no geometric test can tell the cases apart.
	const flipped = armA.startsHere === armB.startsHere;
	const dirB = flipped ? { x: -armB.crossDir.x, y: -armB.crossDir.y } : armB.crossDir;

	// Bands reach slightly past both stop lines into the segments, so no
	// antialiasing hairline can open along the mouths; adjacent intervals
	// still share these extended edges exactly.
	const overlap = 0.5;
	const edgeCurve = (offset: number) => {
		const curve = sampleCornerCurve(
			offsetPoint(armA.stop, armA.crossDir, offset),
			armA.into,
			offsetPoint(armB.stop, dirB, offset),
			armB.into
		);
		curve.unshift(offsetPoint(offsetPoint(armA.stop, armA.into, -overlap), armA.crossDir, offset));
		curve.push(offsetPoint(offsetPoint(armB.stop, armB.into, -overlap), dirB, offset));
		return curve;
	};

	for (const interval of getLaneIntervals(armA.lanes)) {
		const low = edgeCurve(interval.start - BAND_PAD);
		const high = edgeCurve(interval.end + BAND_PAD);

		const band: Path = [];
		for (const point of high) {
			band.push(toClipperPoint(point.x, point.y));
		}
		for (let k = low.length - 1; k >= 0; k--) {
			band.push(toClipperPoint(low[k].x, low[k].y));
		}
		getOrCreateBands(bandsByType, interval.laneType).push(normalizeWinding(band));
	}
}

// Corner between two stop-line edge points: a quadratic curve whose control
// point is where the two road edges would meet if extended into the
// intersection. Near-parallel edges degrade to a straight connection.
function sampleCornerCurve(from: Point, intoA: Point, to: Point, intoB: Point): Point[] {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const distance = Math.sqrt(dx * dx + dy * dy);

	let control = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
	const cross = intoA.x * intoB.y - intoA.y * intoB.x;
	if (Math.abs(cross) > 0.001) {
		const t = (dx * intoB.y - dy * intoB.x) / cross;
		const u = (dx * intoA.y - dy * intoA.x) / cross;
		// Keep the control point near the chord: shallow-angle arms put the
		// edge intersection far away, which balloons the curve across the map.
		const limit = distance * 1.5;
		if (t > 0 && u > 0 && t < limit && u < limit) {
			control = { x: from.x + intoA.x * t, y: from.y + intoA.y * t };
		}
	}

	const points: Point[] = [];
	for (let i = 0; i <= CORNER_CURVE_SAMPLES; i++) {
		const t = i / CORNER_CURVE_SAMPLES;
		const mt = 1 - t;
		points.push({
			x: mt * mt * from.x + 2 * mt * t * control.x + t * t * to.x,
			y: mt * mt * from.y + 2 * mt * t * control.y + t * t * to.y
		});
	}
	return points;
}

function normalizeVector(v: Point): Point | null {
	const len = Math.sqrt(v.x * v.x + v.y * v.y);
	if (len < 0.0001) return null;
	return { x: v.x / len, y: v.y / len };
}

function collectNodeArms(graph: Graph, node: Node, only?: Set<string>): NodeArm[] {
	const arms: NodeArm[] = [];

	for (const segmentId of node.connectedSegments) {
		if (only && !only.has(segmentId)) continue;

		const segment = graph.segments.get(segmentId);
		if (!segment) continue;

		const startNode = graph.nodes.get(segment.startNodeId);
		const endNode = graph.nodes.get(segment.endNodeId);
		if (!startNode || !endNode) continue;

		if (segment.lanes.length === 0) continue;

		const isStart = segment.startNodeId === node.id;
		const tangent = getSegmentTangentAtNode(segment, startNode, endNode, isStart);

		arms.push({
			segmentId: segment.id,
			normal: { x: -tangent.y, y: tangent.x },
			outward: isStart ? tangent : { x: -tangent.x, y: -tangent.y },
			startsHere: isStart,
			lanes: segment.lanes,
			lanesKey: segment.lanesKey
		});
	}

	return arms;
}

function getSegmentTangentAtNode(
	segment: Segment,
	startNode: Node,
	endNode: Node,
	atStart: boolean
): Point {
	if (segment.hasControlPoint) {
		const tangent = getQuadraticBezierTangent(
			startNode.x,
			startNode.y,
			segment.controlX!,
			segment.controlY!,
			endNode.x,
			endNode.y,
			atStart ? 0 : 1
		);
		const len = Math.sqrt(tangent.x * tangent.x + tangent.y * tangent.y);
		if (len > 0.0001) {
			return { x: tangent.x / len, y: tangent.y / len };
		}
	}

	const dx = endNode.x - startNode.x;
	const dy = endNode.y - startNode.y;
	const len = Math.sqrt(dx * dx + dy * dy);
	if (len > 0.0001) {
		return { x: dx / len, y: dy / len };
	}
	return { x: 1, y: 0 };
}

// Per-side cross-section summary used to join arms at nodes: how far the
// roadway reaches and where the outermost sidewalk and grass strips sit,
// independently for each side of the centerline (one-way ramps and paths
// are asymmetric or have no roadway at all).
interface SideBand {
	inner: number;
	outer: number;
}

interface SideProfile {
	roadEdge: number;
	sidewalk: SideBand;
	grass: SideBand;
	median: SideBand;
}

interface ArmProfile {
	halfWidth: number;
	hasRoad: boolean;
	positive: SideProfile;
	negative: SideProfile;
}

const BAND_EPSILON = 0.01;
// Node-piece bands are padded a hair wider than the triangulation epsilon
// shrink (see pathsToPolygons), so layers tiling edge-to-edge overlap
// rather than exposing the plate between them.
const BAND_PAD = 0.08;

function hasBand(band: SideBand): boolean {
	return band.outer - band.inner > BAND_EPSILON;
}

function getArmProfile(lanes: Lane[]): ArmProfile {
	const halfWidth = getTotalWidth(lanes) / 2;
	const positive: SideProfile = {
		roadEdge: 0,
		sidewalk: { inner: 0, outer: 0 },
		grass: { inner: 0, outer: 0 },
		median: { inner: 0, outer: 0 }
	};
	const negative: SideProfile = {
		roadEdge: 0,
		sidewalk: { inner: 0, outer: 0 },
		grass: { inner: 0, outer: 0 },
		median: { inner: 0, outer: 0 }
	};
	let hasRoad = false;

	for (const interval of getLaneIntervals(lanes)) {
		if (interval.laneType === 'road') hasRoad = true;
		applyIntervalToSide(
			positive,
			interval.laneType,
			Math.max(0, interval.start),
			Math.max(0, interval.end)
		);
		applyIntervalToSide(
			negative,
			interval.laneType,
			Math.max(0, -interval.end),
			Math.max(0, -interval.start)
		);
	}

	// Absent strips collapse to a zero-width band at the outer edge, which is
	// where joins taper the other arm's strip out.
	for (const side of [positive, negative]) {
		if (!hasBand(side.sidewalk)) side.sidewalk = { inner: halfWidth, outer: halfWidth };
		if (!hasBand(side.grass)) side.grass = { inner: halfWidth, outer: halfWidth };
		if (!hasBand(side.median)) side.median = { inner: halfWidth, outer: halfWidth };
	}

	return { halfWidth, hasRoad, positive, negative };
}

function applyIntervalToSide(side: SideProfile, laneType: LaneType, inner: number, outer: number) {
	if (outer - inner < BAND_EPSILON) return;

	if (laneType === 'road') {
		side.roadEdge = Math.max(side.roadEdge, outer);
	} else if (laneType === 'sidewalk' && outer > side.sidewalk.outer) {
		side.sidewalk = { inner, outer };
	} else if (laneType === 'grass' && outer > side.grass.outer) {
		side.grass = { inner, outer };
	} else if (laneType === 'median' && outer > side.median.outer) {
		side.median = { inner, outer };
	}
}

function offsetPoint(origin: Point, dir: Point, distance: number): Point {
	return { x: origin.x + dir.x * distance, y: origin.y + dir.y * distance };
}

function getOrCreateBands(bandsByType: Map<LaneType, Paths>, laneType: LaneType): Paths {
	const existing = bandsByType.get(laneType);
	if (existing) return existing;
	const created: Paths = [];
	bandsByType.set(laneType, created);
	return created;
}

function rotationBetween(a: Point, b: Point): number {
	return Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
}

function sampleArcDirections(from: Point, rotation: number): Point[] {
	const steps = Math.max(1, Math.ceil(Math.abs(rotation) / WEDGE_ANGLE_STEP));
	const startAngle = Math.atan2(from.y, from.x);
	const dirs: Point[] = [];
	for (let i = 0; i <= steps; i++) {
		const angle = startAngle + (rotation * i) / steps;
		dirs.push({ x: Math.cos(angle), y: Math.sin(angle) });
	}
	return dirs;
}

interface OffsetInterval {
	start: number;
	end: number;
}

// The swept region of a cross-section interval splits at the centerline: the
// positive side sweeps along the arc directions, the negative side along the
// opposite directions.
function addWedgePieces(
	bands: Paths,
	center: Point,
	dirs: Point[],
	rawA: OffsetInterval,
	rawB: OffsetInterval
) {
	// Pad past the triangulation shrink so adjacent layers overlap instead
	// of opening hairline slots (layer order keeps the visible boundary).
	const intervalA = { start: rawA.start - BAND_PAD, end: rawA.end + BAND_PAD };
	const intervalB = { start: rawB.start - BAND_PAD, end: rawB.end + BAND_PAD };
	addWedgePiece(
		bands,
		center,
		dirs,
		1,
		{ inner: Math.max(0, intervalA.start), outer: Math.max(0, intervalA.end) },
		{ inner: Math.max(0, intervalB.start), outer: Math.max(0, intervalB.end) }
	);
	addWedgePiece(
		bands,
		center,
		dirs,
		-1,
		{ inner: Math.max(0, -intervalA.end), outer: Math.max(0, -intervalA.start) },
		{ inner: Math.max(0, -intervalB.end), outer: Math.max(0, -intervalB.start) }
	);
}

interface RadialRange {
	inner: number;
	outer: number;
}

function addWedgePiece(
	bands: Paths,
	center: Point,
	dirs: Point[],
	side: 1 | -1,
	rangeA: RadialRange,
	rangeB: RadialRange
) {
	if (rangeA.outer - rangeA.inner < 0.01 && rangeB.outer - rangeB.inner < 0.01) return;

	const last = dirs.length - 1;
	const path: Path = [];

	for (let i = 0; i <= last; i++) {
		const t = i / last;
		const radius = rangeA.outer + (rangeB.outer - rangeA.outer) * t;
		path.push(
			toClipperPoint(center.x + dirs[i].x * radius * side, center.y + dirs[i].y * radius * side)
		);
	}

	if (rangeA.inner < 0.01 && rangeB.inner < 0.01) {
		path.push(toClipperPoint(center.x, center.y));
	} else {
		for (let i = last; i >= 0; i--) {
			const t = i / last;
			const radius = rangeA.inner + (rangeB.inner - rangeA.inner) * t;
			path.push(
				toClipperPoint(center.x + dirs[i].x * radius * side, center.y + dirs[i].y * radius * side)
			);
		}
	}

	bands.push(normalizeWinding(path));
}

// All paths fed into a nonzero-fill union must share a winding direction, or
// overlapping regions cancel into holes.
function normalizeWinding(path: Path): Path {
	let area = 0;
	for (let i = 0; i < path.length; i++) {
		const a = path[i];
		const b = path[(i + 1) % path.length];
		area += a.X * b.Y - b.X * a.Y;
	}
	return area < 0 ? path.reverse() : path;
}

function buildDiscPath(cx: number, cy: number, radius: number): Path {
	const path: Path = [];
	const segments = 32;
	for (let i = 0; i < segments; i++) {
		const angle = (i / segments) * Math.PI * 2;
		path.push(toClipperPoint(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius));
	}
	return normalizeWinding(path);
}

function toClipperPoint(x: number, y: number) {
	return { X: Math.round(x * CLIPPER_SCALE), Y: Math.round(y * CLIPPER_SCALE) };
}

function executeBoolean(clipType: number, subject: Paths, clip: Paths): Paths {
	const clipper = new ClipperLib.Clipper();
	clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
	if (clip.length > 0) {
		clipper.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
	}

	const solution: Paths = [];
	clipper.Execute(
		clipType,
		solution,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);
	return solution;
}

function unionPaths(paths: Paths): Paths {
	return executeBoolean(ClipperLib.ClipType.ctUnion, paths, []);
}

function subtractPaths(subject: Paths, clip: Paths): Paths {
	return executeBoolean(ClipperLib.ClipType.ctDifference, subject, clip);
}

// Junction areas where curb rounding is allowed to add material.
function buildJunctionDiscs(graph: Graph): Paths {
	const discs: Paths = [];

	for (const node of graph.nodes.values()) {
		if (node.connectedSegments.length < 2) continue;

		let maxWidth = 0;
		for (const segmentId of node.connectedSegments) {
			const segment = graph.segments.get(segmentId);
			if (!segment) continue;
			maxWidth = Math.max(maxWidth, segment.totalWidth);
		}

		if (maxWidth > 0) {
			discs.push(buildDiscPath(node.x, node.y, maxWidth * JUNCTION_DISC_SCALE));
		}
	}

	return discs;
}

// Material added by a dilate-erode closing, kept only near junctions — an
// unrestricted closing also welds shut any narrow gap between unrelated
// nearby roads (e.g. inside a hairpin bend).
function computeCurbFillets(paths: Paths, radius: number, junctionDiscs: Paths): Paths {
	if (radius <= 0.001 || paths.length === 0 || junctionDiscs.length === 0) return [];

	const expanded = offsetPaths(paths, radius);
	if (expanded.length === 0) return [];

	const closed = offsetPaths(expanded, -radius);
	return executeBoolean(
		ClipperLib.ClipType.ctIntersection,
		subtractPaths(closed, paths),
		junctionDiscs
	);
}

// Round concave curb corners where bands meet at a junction.
function applyCurbRounding(paths: Paths, radius: number, junctionDiscs: Paths): Paths {
	const fillets = computeCurbFillets(paths, radius, junctionDiscs);
	if (fillets.length === 0) return paths;

	return unionPaths([...paths, ...fillets]);
}

function offsetPaths(paths: Paths, delta: number): Paths {
	const offsetter = new ClipperLib.ClipperOffset(2, 0.25 * CLIPPER_SCALE);
	offsetter.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);

	const output: Paths = [];
	offsetter.Execute(output, delta * CLIPPER_SCALE);
	return output;
}

// Earcut (inside THREE.ShapeGeometry) intermittently mis-triangulates
// polygons with holes — bridge edges across a hole fill parts of it. The
// epsilon shrink resolves ring pinch points, and any polygon that still has
// holes gets decomposed into hole-free pieces, which earcut handles reliably.
const TRIANGULATION_EPSILON = 0.05;
const MAX_DECOMPOSE_DEPTH = 4;

function pathsToPolygons(paths: Paths): PolygonWithHoles[] {
	if (paths.length === 0) return [];

	const shrunk = offsetPaths(paths, -TRIANGULATION_EPSILON);
	const source = shrunk.length > 0 ? shrunk : paths;

	const result: PolygonWithHoles[] = [];
	for (const polygon of extractPolygons(source)) {
		decomposeWithoutHoles(polygon, 0, result);
	}
	return result;
}

function extractPolygons(paths: Paths): PolygonWithHoles[] {
	const clipper = new ClipperLib.Clipper();
	clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);

	const tree: PolyTree = new ClipperLib.PolyTree();
	clipper.Execute(
		ClipperLib.ClipType.ctUnion,
		tree,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);

	const polygons: PolygonWithHoles[] = [];
	const visitOuter = (outer: PolyNode) => {
		const polygon: PolygonWithHoles = { outer: toPoints(outer.Contour()), holes: [] };
		for (const hole of outer.Childs()) {
			polygon.holes.push(toPoints(hole.Contour()));
			for (const island of hole.Childs()) {
				visitOuter(island);
			}
		}
		polygons.push(polygon);
	};

	for (const child of tree.Childs()) {
		visitOuter(child);
	}

	return polygons;
}

// Slice a polygon horizontally at each hole's centroid: every hole is cut
// open into boundary notches, leaving only simply-connected pieces.
function decomposeWithoutHoles(
	polygon: PolygonWithHoles,
	depth: number,
	result: PolygonWithHoles[]
) {
	if (polygon.holes.length === 0 || depth >= MAX_DECOMPOSE_DEPTH) {
		result.push(polygon);
		return;
	}

	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const point of polygon.outer) {
		minX = Math.min(minX, point.x);
		maxX = Math.max(maxX, point.x);
		minY = Math.min(minY, point.y);
		maxY = Math.max(maxY, point.y);
	}

	const cutLevels = [...new Set(polygon.holes.map(centroidY))].sort((a, b) => a - b);
	const bounds = [minY - 1, ...cutLevels, maxY + 1];

	const polygonPaths: Paths = [
		toClipperPath(polygon.outer),
		...polygon.holes.map((hole) => toClipperPath(hole))
	];

	for (let i = 0; i < bounds.length - 1; i++) {
		if (bounds[i + 1] - bounds[i] < 0.001) continue;

		const slab: Path = [
			toClipperPoint(minX - 1, bounds[i]),
			toClipperPoint(maxX + 1, bounds[i]),
			toClipperPoint(maxX + 1, bounds[i + 1]),
			toClipperPoint(minX - 1, bounds[i + 1])
		];

		const pieces = executeBoolean(ClipperLib.ClipType.ctIntersection, polygonPaths, [
			normalizeWinding(slab)
		]);
		for (const piece of extractPolygons(pieces)) {
			decomposeWithoutHoles(piece, depth + 1, result);
		}
	}
}

function centroidY(points: Point[]): number {
	let sum = 0;
	for (const point of points) {
		sum += point.y;
	}
	return points.length > 0 ? sum / points.length : 0;
}

function toClipperPath(points: Point[]): Path {
	return points.map((point) => toClipperPoint(point.x, point.y));
}

function toPoints(contour: Path): Point[] {
	return contour.map((point) => ({ x: point.X / CLIPPER_SCALE, y: point.Y / CLIPPER_SCALE }));
}

// True where a node's connection pair continues the same cross-section, so
// the node piece carries every strip through (bend wedges or corner bands)
// and segment strips can safely overlap into it. Attached paths don't break
// continuity — the pair outranks them.
export function isContinuationNode(graph: Graph, node: Node): boolean {
	const pair = connectionPair(graph, node);
	return pair !== null && pair[0].lanesKey === pair[1].lanesKey;
}

// True where a segment's median strip terminates at this node — against a
// junction's stop line or a transition whose other side has no island it can
// flow into — so the strip should end in a rounded nose. Where the median
// continues (continuation nodes, transitions onto another median or grass
// island) or the road just dead-ends, it keeps its plain end.
export function medianEndsAtNode(graph: Graph, node: Node, segmentId: string): boolean {
	if (validNodeSegments(graph, node).length < 2) return false;

	const pair = connectionPair(graph, node);
	if (pair && (pair[0].id === segmentId || pair[1].id === segmentId)) {
		if (pair[0].lanesKey === pair[1].lanesKey) return false;
		if (isPatchNode(graph, node)) return true;

		const self = pair[0].id === segmentId ? pair[0] : pair[1];
		const other = pair[0].id === segmentId ? pair[1] : pair[0];

		const flipped = (self.startNodeId === node.id) === (other.startNodeId === node.id);
		let otherIntervals = getLaneIntervals(other.lanes);
		if (flipped) otherIntervals = mirrorIntervals(otherIntervals);

		return getLaneIntervals(self.lanes).some(
			(interval) => interval.laneType === 'median' && !islandMatch(interval, otherIntervals)
		);
	}

	return true;
}

// Geometry for a single node: the join wedges of a gentle bend or the
// pavement patch and sidewalk corners of an intersection. Inputs are only
// the node's own arms, so this stays cheap regardless of map size.
export function buildNodeLayers(
	graph: Graph,
	node: Node,
	centerlines: Map<string, CenterlineSample[]>
): RoadLayer[] {
	if (node.connectedSegments.length < 2) return [];

	const bandsByType = new Map<LaneType, Paths>();
	addNodeGeometry(graph, node, centerlines, bandsByType);

	const allBands: Paths = [];
	for (const bands of bandsByType.values()) {
		allBands.push(...bands);
	}
	if (allBands.length === 0) return [];

	// Dilate-erode sealing applies only to the pavement plate, where added
	// gray is invisible against the sidewalk bands — without it, slivers
	// between the patch, corner bands, and arm mouths leak the ground color.
	// The upper layers are exact shapes; closing them would weld separate
	// roadways across narrow center strips.
	let maxWidth = 0;
	for (const segmentId of node.connectedSegments) {
		const segment = graph.segments.get(segmentId);
		if (!segment) continue;
		maxWidth = Math.max(maxWidth, segment.totalWidth);
	}
	const discs: Paths =
		maxWidth > 0 ? [buildDiscPath(node.x, node.y, maxWidth * JUNCTION_DISC_SCALE)] : [];

	// The sidewalk layer doubles as the junction's full pavement plate — same
	// layering trick as segment ribbons.
	const plate = applyCurbRounding(unionPaths(allBands), CURB_RADIUS.sidewalk, discs);

	const layers: RoadLayer[] = [];

	for (const layerId of LAYER_ORDER) {
		let paths: Paths;
		if (layerId === 'sidewalk') {
			paths = plate;
		} else {
			const bands = bandsByType.get(layerId);
			if (!bands || bands.length === 0) continue;
			paths = unionPaths(bands);
		}

		const polygons = pathsToPolygons(paths);
		if (polygons.length > 0) {
			layers.push({ id: layerId, polygons });
		}
	}

	return layers;
}
