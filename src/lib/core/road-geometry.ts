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
		if (isPatchNode(graph, node)) {
			addIntersection(graph, node, centerlines, bandsByType);
		} else {
			addNodeJoins(graph, node, bandsByType);
		}
	}

	const medianBreakDiscs = buildMedianBreakDiscs(graph);
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
		let medianPaths = applyCurbRounding(unionPaths(medianBands), CURB_RADIUS.median, junctionDiscs);
		if (medianBreakDiscs.length > 0) {
			medianPaths = subtractPaths(medianPaths, medianBreakDiscs);
		}
		layerPaths.set('median', medianPaths);
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

function isPatchNode(graph: Graph, node: Node): boolean {
	if (node.connectedSegments.length >= 3) return true;
	if (node.connectedSegments.length !== 2) return false;

	const arms = collectNodeArms(graph, node);
	if (arms.length !== 2) return false;

	const dot = arms[0].outward.x * arms[1].outward.x + arms[0].outward.y * arms[1].outward.y;
	return dot > CORNER_PATCH_MIN_DOT;
}

// At patch nodes every road stops short of the node: far enough back to
// clear the widest crossing road, plus a fixed gap.
export function computeIntersectionTrims(graph: Graph): Map<string, SegmentTrim> {
	const trims = new Map<string, SegmentTrim>();

	for (const node of graph.nodes.values()) {
		if (!isPatchNode(graph, node)) continue;

		const halfWidths = new Map<string, number>();
		for (const segmentId of node.connectedSegments) {
			const segment = graph.segments.get(segmentId);
			if (!segment || segment.lanes.length === 0) continue;
			halfWidths.set(segmentId, segment.totalWidth / 2);
		}

		for (const segmentId of node.connectedSegments) {
			const segment = graph.segments.get(segmentId);
			if (!segment) continue;

			let maxOtherHalfWidth = 0;
			for (const [otherId, halfWidth] of halfWidths) {
				if (otherId === segmentId) continue;
				maxOtherHalfWidth = Math.max(maxOtherHalfWidth, halfWidth);
			}

			const trim = maxOtherHalfWidth + INTERSECTION_GAP;
			const existing = trims.get(segmentId) ?? { start: 0, end: 0 };
			if (segment.startNodeId === node.id) {
				existing.start = Math.max(existing.start, trim);
			}
			if (segment.endNodeId === node.id) {
				existing.end = Math.max(existing.end, trim);
			}
			trims.set(segmentId, existing);
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
	normal: Point;
	outward: Point;
	lanes: Lane[];
	lanesKey: string;
}

const MIN_JOIN_ANGLE = 0.05;
const WEDGE_ANGLE_STEP = Math.PI / 16;

// Bands butt-end exactly at their nodes, which leaves a wedge-shaped notch on
// the outer side of every bend. Fill each lane layer's swept cross-section
// between adjacent segments — the polygon equivalent of a round line join.
function addNodeJoins(graph: Graph, node: Node, bandsByType: Map<LaneType, Paths>) {
	const arms = collectNodeArms(graph, node);
	if (arms.length < 2) return;

	arms.sort((a, b) => Math.atan2(a.outward.y, a.outward.x) - Math.atan2(b.outward.y, b.outward.x));

	const center = { x: node.x, y: node.y };
	const pairCount = arms.length === 2 ? 1 : arms.length;

	for (let i = 0; i < pairCount; i++) {
		const armA = arms[i];
		const armB = arms[(i + 1) % arms.length];

		let normalB = armB.normal;
		if (armA.normal.x * normalB.x + armA.normal.y * normalB.y < 0) {
			normalB = { x: -normalB.x, y: -normalB.y };
		}

		const rotation = rotationBetween(armA.normal, normalB);
		if (Math.abs(rotation) < MIN_JOIN_ANGLE) continue;

		const dirs = sampleArcDirections(armA.normal, rotation);

		if (armA.lanesKey === armB.lanesKey) {
			const intervalsA = getLaneIntervals(armA.lanes);
			const intervalsB = getLaneIntervals(armB.lanes);
			for (let k = 0; k < intervalsA.length; k++) {
				const bands = getOrCreateBands(bandsByType, intervalsA[k].laneType);
				addWedgePieces(bands, center, dirs, intervalsA[k], intervalsB[k]);
			}
		} else {
			// Different cross-sections meeting: interpolate between the two
			// — pavement out to each side's sidewalk, and the sidewalk rings
			// joined to each other.
			const profileA = getJoinProfile(armA.lanes);
			const profileB = getJoinProfile(armB.lanes);

			const roadBands = getOrCreateBands(bandsByType, 'road');
			addWedgePieces(
				roadBands,
				center,
				dirs,
				{ start: -profileA.sidewalkInner, end: profileA.sidewalkInner },
				{ start: -profileB.sidewalkInner, end: profileB.sidewalkInner }
			);

			if (
				profileA.sidewalkOuter > profileA.sidewalkInner ||
				profileB.sidewalkOuter > profileB.sidewalkInner
			) {
				const sidewalkBands = getOrCreateBands(bandsByType, 'sidewalk');
				addWedgePieces(
					sidewalkBands,
					center,
					dirs,
					{ start: profileA.sidewalkInner, end: profileA.sidewalkOuter },
					{ start: profileB.sidewalkInner, end: profileB.sidewalkOuter }
				);
				addWedgePieces(
					sidewalkBands,
					center,
					dirs,
					{ start: -profileA.sidewalkOuter, end: -profileA.sidewalkInner },
					{ start: -profileB.sidewalkOuter, end: -profileB.sidewalkInner }
				);
			}
		}
	}
}

interface IntersectionArm {
	stop: Point;
	into: Point;
	halfWidth: number;
	roadHalf: number;
}

// A patch node is built explicitly: every road already stops at its trimmed
// stop line; a single pavement patch spans all the stop lines, and sidewalk
// bands curve around the corners between adjacent arms.
function addIntersection(
	graph: Graph,
	node: Node,
	centerlines: Map<string, CenterlineSample[]>,
	bandsByType: Map<LaneType, Paths>
) {
	const arms: IntersectionArm[] = [];

	for (const segmentId of node.connectedSegments) {
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

		const profile = getJoinProfile(segment.lanes);
		arms.push({
			stop: { x: stopSample.x, y: stopSample.y },
			into,
			halfWidth: segment.totalWidth / 2,
			roadHalf: profile.sidewalkInner
		});
	}

	if (arms.length < 2) return;

	arms.sort((a, b) => Math.atan2(-a.into.y, -a.into.x) - Math.atan2(-b.into.y, -b.into.x));

	const patch: Point[] = [];
	const roadBands = getOrCreateBands(bandsByType, 'road');
	const sidewalkBands = getOrCreateBands(bandsByType, 'sidewalk');

	for (let i = 0; i < arms.length; i++) {
		const armA = arms[i];
		const armB = arms[(i + 1) % arms.length];

		// perp(outward) — the side of each arm facing this corner.
		const sideA = { x: armA.into.y, y: -armA.into.x };
		const sideB = { x: armB.into.y, y: -armB.into.x };

		const innerA = {
			x: armA.stop.x + sideA.x * armA.roadHalf,
			y: armA.stop.y + sideA.y * armA.roadHalf
		};
		const innerB = {
			x: armB.stop.x - sideB.x * armB.roadHalf,
			y: armB.stop.y - sideB.y * armB.roadHalf
		};
		const innerCurve = sampleCornerCurve(innerA, armA.into, innerB, armB.into);

		if (armA.halfWidth - armA.roadHalf > 0.01 || armB.halfWidth - armB.roadHalf > 0.01) {
			const outerA = {
				x: armA.stop.x + sideA.x * armA.halfWidth,
				y: armA.stop.y + sideA.y * armA.halfWidth
			};
			const outerB = {
				x: armB.stop.x - sideB.x * armB.halfWidth,
				y: armB.stop.y - sideB.y * armB.halfWidth
			};
			const outerCurve = sampleCornerCurve(outerA, armA.into, outerB, armB.into);

			const band: Path = [];
			for (const point of outerCurve) {
				band.push(toClipperPoint(point.x, point.y));
			}
			for (let k = innerCurve.length - 1; k >= 0; k--) {
				band.push(toClipperPoint(innerCurve[k].x, innerCurve[k].y));
			}
			sidewalkBands.push(normalizeWinding(band));
		}

		// Stop-line edge of arm A, then the corner curve over to arm B.
		patch.push({
			x: armA.stop.x - sideA.x * armA.roadHalf,
			y: armA.stop.y - sideA.y * armA.roadHalf
		});
		patch.push(...innerCurve);
	}

	roadBands.push(normalizeWinding(patch.map((point) => toClipperPoint(point.x, point.y))));
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
		const limit = distance * 4;
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

function collectNodeArms(graph: Graph, node: Node): NodeArm[] {
	const arms: NodeArm[] = [];

	for (const segmentId of node.connectedSegments) {
		const segment = graph.segments.get(segmentId);
		if (!segment) continue;

		const startNode = graph.nodes.get(segment.startNodeId);
		const endNode = graph.nodes.get(segment.endNodeId);
		if (!startNode || !endNode) continue;

		if (segment.lanes.length === 0) continue;

		const isStart = segment.startNodeId === node.id;
		const tangent = getSegmentTangentAtNode(segment, startNode, endNode, isStart);

		arms.push({
			normal: { x: -tangent.y, y: tangent.x },
			outward: isStart ? tangent : { x: -tangent.x, y: -tangent.y },
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

// Radial extents used when joining two different cross-sections: everything
// inside the outermost sidewalk strip is treated as pavement.
function getJoinProfile(lanes: Lane[]): { sidewalkInner: number; sidewalkOuter: number } {
	const halfWidth = getTotalWidth(lanes) / 2;
	let sidewalkInner = halfWidth;

	for (const interval of getLaneIntervals(lanes)) {
		if (interval.laneType !== 'sidewalk') continue;
		const outerEdge = Math.max(Math.abs(interval.start), Math.abs(interval.end));
		if (Math.abs(outerEdge - halfWidth) < 0.01) {
			sidewalkInner = Math.min(Math.abs(interval.start), Math.abs(interval.end));
		}
	}

	return { sidewalkInner, sidewalkOuter: halfWidth };
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
	intervalA: OffsetInterval,
	intervalB: OffsetInterval
) {
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

// Medians (and grass verges) break where roads actually cross, but continue
// through simple corner/continuation nodes of the same road type.
function buildMedianBreakDiscs(graph: Graph): Paths {
	const discs: Paths = [];

	for (const node of graph.nodes.values()) {
		if (!isMedianBreakNode(graph, node)) continue;

		let maxRoadExtent = 0;
		for (const segmentId of node.connectedSegments) {
			const segment = graph.segments.get(segmentId);
			if (!segment) continue;

			for (const interval of getLaneIntervals(segment.lanes)) {
				if (interval.laneType !== 'road') continue;
				maxRoadExtent = Math.max(maxRoadExtent, Math.abs(interval.start), Math.abs(interval.end));
			}
		}

		if (maxRoadExtent > 0) {
			discs.push(buildDiscPath(node.x, node.y, maxRoadExtent + CURB_RADIUS.road));
		}
	}

	return discs;
}

// Intersection trims already stop medians short of 3+ way nodes; discs are
// only needed where two different cross-sections meet end-to-end.
function isMedianBreakNode(graph: Graph, node: Node): boolean {
	if (node.connectedSegments.length !== 2) return false;

	const keys = node.connectedSegments.map((segmentId) => graph.segments.get(segmentId)?.lanesKey);
	return keys[0] !== keys[1];
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

// Extra shortening applied to a segment's median band where it meets a node
// that breaks medians (two different road types meeting end-to-end).
export function getMedianBreakTrim(graph: Graph, node: Node): number {
	if (!isMedianBreakNode(graph, node)) return 0;

	let maxRoadExtent = 0;
	for (const segmentId of node.connectedSegments) {
		const segment = graph.segments.get(segmentId);
		if (!segment) continue;

		for (const interval of getLaneIntervals(segment.lanes)) {
			if (interval.laneType !== 'road') continue;
			maxRoadExtent = Math.max(maxRoadExtent, Math.abs(interval.start), Math.abs(interval.end));
		}
	}

	return maxRoadExtent > 0 ? maxRoadExtent + CURB_RADIUS.road : 0;
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
	if (isPatchNode(graph, node)) {
		addIntersection(graph, node, centerlines, bandsByType);
	} else {
		addNodeJoins(graph, node, bandsByType);
	}

	const allBands: Paths = [];
	for (const bands of bandsByType.values()) {
		allBands.push(...bands);
	}
	if (allBands.length === 0) return [];

	// The sidewalk layer doubles as the junction's full pavement plate — same
	// layering trick as segment ribbons.
	const plate = unionPaths(allBands);

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
