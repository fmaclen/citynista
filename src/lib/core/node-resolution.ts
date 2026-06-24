import type { Graph } from './graph.svelte';
import { getTotalWidth } from './lane-template';
import {
	collectIntersectionArms,
	computeIntersectionTrims,
	getLaneIntervals,
	nodeThroughPair,
	sampleTrimmedCenterline,
	transitionStraddle,
	type CenterlineSample,
	type IntersectionArm,
	type Point
} from './road-geometry';
import type { Node } from './node.svelte';
import type { Segment } from './segment.svelte';
import type { Lane, LaneDirection, LaneMaterial } from './types';
import {
	isIslandLike,
	isRoadway,
	laneLayer,
	lanesStructureKey,
	surfaceClassOf,
	type LaneLayerId,
	type SurfaceClass
} from './lane-types';
import { getQuadraticBezierTangent } from '../geometry/bezier';
import { activeConnectionsAt } from './lane-connections';

export interface Interval {
	start: number;
	end: number;
}

export type StripDisposition =
	| {
			kind: 'continue';
			targetArmId: string;
			targetInterval: Interval;
			seam: boolean;
	  }
	| {
			kind: 'terminate';
			cover: SurfaceClass;
	  };

export interface ResolvedStrip {
	laneRange: [number, number];
	intervalIndex: number;
	interval: Interval;
	surfaceClass: SurfaceClass;
	material: LaneMaterial;
	direction: LaneDirection;
	disposition: StripDisposition;
}

export interface ResolvedArm {
	segmentId: string;
	startsHere: boolean;
	outward: Point;
	strips: ResolvedStrip[];
}

export interface NodeResolution {
	arms: ResolvedArm[];
	throughPairIds: [string, string] | null;
}

interface LaneInterval extends Interval {
	laneType: LaneLayerId;
}

interface IndexedInterval extends LaneInterval {
	index: number;
	laneRange: [number, number];
	surfaceClass: SurfaceClass;
	material: LaneMaterial;
	direction: LaneDirection;
}

interface ResolutionArm {
	segment: Segment;
	startsHere: boolean;
	outward: Point;
	intervals: IndexedInterval[];
}

const CENTER_MEDIAN_PAIR_DOT = -0.85;
const CENTER_MEDIAN_MIN_WIDTH = 0.1;
const MEDIAN_BARRIER_REACH = 8;

function materialOf(laneType: LaneLayerId) {
	return laneType.split(':')[1] as LaneMaterial;
}

function segmentHasRoad(segment: Segment) {
	return segment.lanes.some((lane) => lane.role === 'vehicle');
}

function validNodeSegments(graph: Graph, node: Node) {
	const segments: Segment[] = [];
	for (const segmentId of node.connectedSegments) {
		const segment = graph.segments.get(segmentId);
		if (segment && segment.lanes.length > 0) segments.push(segment);
	}
	return segments;
}

function isPatchNode(graph: Graph, node: Node) {
	const segments = validNodeSegments(graph, node);
	const majors = segments.filter(segmentHasRoad);
	const counted = majors.length >= 2 ? majors : segments;
	return counted.length >= 3;
}

function getSegmentTangentAtNode(
	segment: Segment,
	startNode: Node,
	endNode: Node,
	atStart: boolean
) {
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
		const len = Math.hypot(tangent.x, tangent.y);
		if (len > 0.0001) return { x: tangent.x / len, y: tangent.y / len };
	}

	const dx = endNode.x - startNode.x;
	const dy = endNode.y - startNode.y;
	const len = Math.hypot(dx, dy);
	if (len > 0.0001) return { x: dx / len, y: dy / len };
	return { x: 1, y: 0 };
}

function segmentOutwardAtNode(graph: Graph, node: Node, segment: Segment) {
	const startNode = graph.nodes.get(segment.startNodeId);
	const endNode = graph.nodes.get(segment.endNodeId);
	if (!startNode || !endNode) return null;

	const isStart = segment.startNodeId === node.id;
	const tangent = getSegmentTangentAtNode(segment, startNode, endNode, isStart);
	return isStart ? tangent : { x: -tangent.x, y: -tangent.y };
}

function mirrorInterval<T extends LaneInterval>(interval: T) {
	return {
		...interval,
		start: -interval.end,
		end: -interval.start
	};
}

function mirrorIntervals<T extends LaneInterval>(intervals: T[]) {
	return intervals.map(mirrorInterval).reverse();
}

function intervalLaneRanges(lanes: Lane[]) {
	const ranges: [number, number][] = [];
	let currentType: LaneLayerId | null = null;
	let start = 0;
	for (let i = 0; i < lanes.length; i++) {
		const laneType = laneLayer(lanes[i]);
		if (currentType !== null && laneType !== currentType) {
			ranges.push([start, i - 1]);
			start = i;
		}
		currentType = laneType;
	}
	if (currentType !== null) ranges.push([start, lanes.length - 1]);
	return ranges;
}

function laneDirection(lanes: Lane[], [start, end]: [number, number]) {
	const direction = lanes[start]?.direction ?? 'bidirectional';
	for (let i = start + 1; i <= end; i++) {
		if (lanes[i]?.direction !== direction) return 'bidirectional';
	}
	return direction;
}

function indexedIntervals(lanes: Lane[]) {
	const ranges = intervalLaneRanges(lanes);
	return getLaneIntervals(lanes).map((interval, index) => {
		const laneType = interval.laneType as LaneLayerId;
		const laneRange = ranges[index] ?? [0, 0];
		return {
			...interval,
			laneType,
			index,
			laneRange,
			surfaceClass: surfaceClassOf(laneType),
			material: materialOf(laneType),
			direction: laneDirection(lanes, laneRange)
		};
	});
}

function transformedIntervals(arm: ResolutionArm, inFrameOf: ResolutionArm) {
	const flipped = inFrameOf.startsHere === arm.startsHere;
	return flipped ? mirrorIntervals(arm.intervals) : arm.intervals;
}

function overlap(a: Interval, b: Interval) {
	return Math.min(a.end, b.end) - Math.max(a.start, b.start);
}

function center(interval: Interval) {
	return (interval.start + interval.end) / 2;
}

function width(interval: Interval) {
	return interval.end - interval.start;
}

function canMatchSurface(a: SurfaceClass, b: SurfaceClass) {
	if (a === 'roadway' || a === 'walkway') return a === b;
	if (a === 'island' || a === 'verge') return b === 'island' || b === 'verge';
	return false;
}

function bestStructuralCounterpart(interval: IndexedInterval, candidates: IndexedInterval[]) {
	const byClass = candidates.filter((candidate) =>
		canMatchSurface(interval.surfaceClass, candidate.surfaceClass)
	);
	let best: IndexedInterval | null = null;
	let bestOverlap = 0;
	for (const candidate of byClass) {
		const amount = overlap(interval, candidate);
		if (amount > bestOverlap) {
			best = candidate;
			bestOverlap = amount;
		}
	}
	if (best) return best;
	if (!isIslandLike(interval.laneType)) return null;

	let nearest: IndexedInterval | null = null;
	let nearestDistance = Infinity;
	for (const candidate of byClass) {
		const distance = Math.abs(center(candidate) - center(interval));
		if (distance < nearestDistance) {
			nearest = candidate;
			nearestDistance = distance;
		}
	}
	return nearest && nearestDistance <= width(interval) + width(nearest) ? nearest : null;
}

function roadwayTarget(interval: Interval, anchorRoadways: LaneInterval[]) {
	const boundStart = Math.min(...anchorRoadways.map((i) => i.start));
	const boundEnd = Math.max(...anchorRoadways.map((i) => i.end));
	const targetWidth = Math.min(width(interval), boundEnd - boundStart);
	const targetCenter = Math.min(
		boundEnd - targetWidth / 2,
		Math.max(boundStart + targetWidth / 2, center(interval))
	);
	return { start: targetCenter - targetWidth / 2, end: targetCenter + targetWidth / 2 };
}

function structuralTransitionTargets(self: ResolutionArm, other: ResolutionArm) {
	const halfSelf = getTotalWidth(self.segment.lanes) / 2;
	const halfOther = getTotalWidth(other.segment.lanes) / 2;
	const selfStructureKey = lanesStructureKey(self.segment.lanes);
	const otherStructureKey = lanesStructureKey(other.segment.lanes);
	const selfIsAnchor =
		halfSelf < halfOther - 0.01 ||
		(Math.abs(halfSelf - halfOther) <= 0.01 && selfStructureKey <= otherStructureKey);

	if (selfIsAnchor) {
		return self.intervals.map((interval) => ({ start: interval.start, end: interval.end }));
	}

	const anchorIntervals = transformedIntervals(other, self);
	const anchorRoadways = anchorIntervals.filter((interval) => isRoadway(interval.laneType));

	return self.intervals.map((interval) => {
		if (interval.surfaceClass === 'walkway') return { start: interval.start, end: interval.end };
		const own = self.intervals.filter((i) => i.surfaceClass === interval.surfaceClass);
		const counterparts = anchorIntervals.filter((i) =>
			canMatchSurface(interval.surfaceClass, i.surfaceClass)
		);
		if (interval.surfaceClass !== 'roadway' && own.length === counterparts.length) {
			return counterparts[own.indexOf(interval)] ?? null;
		}
		if (interval.surfaceClass === 'roadway') {
			if (anchorRoadways.length === 0) return { start: center(interval), end: center(interval) };
			return roadwayTarget(interval, anchorRoadways);
		}
		const match = bestStructuralCounterpart(interval, anchorIntervals);
		if (match) return { start: match.start, end: match.end };
		if (interval.surfaceClass === 'island') {
			if (anchorRoadways.length === 0) return null;
			const zoneStart = Math.min(...anchorRoadways.map((i) => i.start));
			const zoneEnd = Math.max(...anchorRoadways.map((i) => i.end));
			const targetCenter = Math.min(zoneEnd, Math.max(zoneStart, center(interval)));
			return { start: targetCenter, end: targetCenter };
		}
		return null;
	});
}

function seamFor(interval: IndexedInterval, target: Interval, candidates: IndexedInterval[]) {
	const counterpart = bestStructuralCounterpart(
		{ ...interval, start: target.start, end: target.end },
		candidates
	);
	return counterpart ? counterpart.material !== interval.material : false;
}

function sameSectionDisposition(
	arm: ResolutionArm,
	other: ResolutionArm,
	interval: IndexedInterval
) {
	const targets = transformedIntervals(other, arm);
	const target = targets[interval.index] ?? bestStructuralCounterpart(interval, targets);
	if (!target) return { kind: 'terminate', cover: 'roadway' } satisfies StripDisposition;
	return {
		kind: 'continue',
		targetArmId: other.segment.id,
		targetInterval: { start: target.start, end: target.end },
		seam: target.material !== interval.material
	} satisfies StripDisposition;
}

function transitionDisposition(
	arm: ResolutionArm,
	other: ResolutionArm,
	interval: IndexedInterval
) {
	const target = structuralTransitionTargets(arm, other)[interval.index];
	if (
		!target ||
		(isIslandLike(interval.laneType) && Math.abs(target.end - target.start) <= 0.0001)
	) {
		return { kind: 'terminate', cover: 'roadway' } satisfies StripDisposition;
	}
	return {
		kind: 'continue',
		targetArmId: other.segment.id,
		targetInterval: target,
		seam: seamFor(interval, target, transformedIntervals(other, arm))
	} satisfies StripDisposition;
}

function centerMedianInterval(lanes: Lane[]) {
	const intervals = getLaneIntervals(lanes);
	for (let i = 0; i < intervals.length; i++) {
		if (!isIslandLike(intervals[i].laneType)) continue;
		const roadBefore = intervals
			.slice(0, i)
			.some((iv) => surfaceClassOf(iv.laneType) === 'roadway');
		const roadAfter = intervals
			.slice(i + 1)
			.some((iv) => surfaceClassOf(iv.laneType) === 'roadway');
		if (roadBefore && roadAfter) return intervals[i] as LaneInterval;
	}
	return null;
}

function centerMedianAxisEnd(node: Node, arm: IntersectionArm) {
	const reach =
		Math.max(Math.hypot(arm.stop.x - node.x, arm.stop.y - node.y), MEDIAN_BARRIER_REACH) +
		MEDIAN_BARRIER_REACH;
	return {
		x: node.x - arm.into.x * reach,
		y: node.y - arm.into.y * reach
	};
}

function centerMedianIntervalInFrame(arm: IntersectionArm, flipped: boolean) {
	const interval = centerMedianInterval(arm.lanes);
	if (!interval) return null;
	return flipped ? mirrorInterval(interval) : interval;
}

function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point) {
	const side = (a: Point, b: Point, c: Point) =>
		Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
	const d1 = side(p3, p4, p1);
	const d2 = side(p3, p4, p2);
	const d3 = side(p1, p2, p3);
	const d4 = side(p1, p2, p4);
	return d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}

function centerMedianPairs(
	node: Node,
	arms: IntersectionArm[],
	crossingConnectors: { a: Point; b: Point }[] = []
) {
	const candidates: {
		a: IntersectionArm;
		b: IntersectionArm;
		start: number;
		end: number;
		axisA: Point;
		axisB: Point;
	}[] = [];

	for (let i = 0; i < arms.length; i++) {
		for (let j = i + 1; j < arms.length; j++) {
			const a = arms[i];
			const b = arms[j];
			if (a.into.x * b.into.x + a.into.y * b.into.y >= CENTER_MEDIAN_PAIR_DOT) continue;

			const intervalA = centerMedianIntervalInFrame(a, false);
			if (!intervalA) continue;

			const flipped = a.startsHere === b.startsHere;
			const intervalB = centerMedianIntervalInFrame(b, flipped);
			if (!intervalB) continue;

			const start = Math.max(intervalA.start, intervalB.start);
			const end = Math.min(intervalA.end, intervalB.end);
			if (end - start <= CENTER_MEDIAN_MIN_WIDTH) continue;

			candidates.push({
				a,
				b,
				start,
				end,
				axisA: centerMedianAxisEnd(node, a),
				axisB: centerMedianAxisEnd(node, b)
			});
		}
	}

	const armUseCounts = new Map<IntersectionArm, number>();
	for (const pair of candidates) {
		armUseCounts.set(pair.a, (armUseCounts.get(pair.a) ?? 0) + 1);
		armUseCounts.set(pair.b, (armUseCounts.get(pair.b) ?? 0) + 1);
	}

	const disjoint = candidates.filter(
		(pair) => armUseCounts.get(pair.a) === 1 && armUseCounts.get(pair.b) === 1
	);
	return disjoint.filter((pair) => {
		const crossedByDividedPair = disjoint.some(
			(other) => other !== pair && segmentsCross(pair.axisA, pair.axisB, other.axisA, other.axisB)
		);
		if (crossedByDividedPair) return false;
		return !crossingConnectors.some((connector) =>
			segmentsCross(connector.a, connector.b, pair.axisA, pair.axisB)
		);
	});
}

function extendCenterline(samples: CenterlineSample[], atStart: boolean, distance: number) {
	if (samples.length < 2 || distance <= 0.01) return samples;
	const b = atStart ? samples[0] : samples[samples.length - 1];
	const a = atStart ? samples[1] : samples[samples.length - 2];
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = Math.hypot(dx, dy);
	if (len < 0.0001) return samples;
	const ux = dx / len;
	const uy = dy / len;
	const extra: CenterlineSample[] = [];
	const step = 1.5;
	for (let d = step; d < distance; d += step) {
		extra.push({ x: b.x + ux * d, y: b.y + uy * d, normalX: b.normalX, normalY: b.normalY });
	}
	extra.push({
		x: b.x + ux * distance,
		y: b.y + uy * distance,
		normalX: b.normalX,
		normalY: b.normalY
	});
	return atStart ? [...extra.reverse(), ...samples] : [...samples, ...extra];
}

function nodeCenterlines(graph: Graph) {
	const trims = computeIntersectionTrims(graph);
	const straddleTrim = new Map<string, { start: number; end: number }>();
	const straddleExtend = new Map<string, { start: number; end: number }>();
	for (const node of graph.nodes.values()) {
		const straddle = transitionStraddle(graph, node);
		if (!straddle) continue;
		const trim = straddleTrim.get(straddle.narrowId) ?? { start: 0, end: 0 };
		if (straddle.narrowAtStart) trim.start += straddle.half;
		else trim.end += straddle.half;
		straddleTrim.set(straddle.narrowId, trim);
		const extend = straddleExtend.get(straddle.wideId) ?? { start: 0, end: 0 };
		if (straddle.wideAtStart) extend.start += straddle.half;
		else extend.end += straddle.half;
		straddleExtend.set(straddle.wideId, extend);
	}

	const centerlines = new Map<string, CenterlineSample[]>();
	for (const segment of graph.segments.values()) {
		const startNode = graph.nodes.get(segment.startNodeId);
		const endNode = graph.nodes.get(segment.endNodeId);
		if (!startNode || !endNode) continue;
		const trim = trims.get(segment.id);
		const extra = straddleTrim.get(segment.id);
		let samples = sampleTrimmedCenterline(
			segment,
			startNode,
			endNode,
			(trim?.start ?? 0) + (extra?.start ?? 0),
			(trim?.end ?? 0) + (extra?.end ?? 0)
		);
		const extend = straddleExtend.get(segment.id);
		if (extend && samples.length >= 2) {
			if (extend.start > 0) samples = extendCenterline(samples, true, extend.start);
			if (extend.end > 0) samples = extendCenterline(samples, false, extend.end);
		}
		if (samples.length >= 2) centerlines.set(segment.id, samples);
	}
	return centerlines;
}

function resolvedArms(graph: Graph, node: Node) {
	const arms: ResolutionArm[] = [];
	for (const segment of validNodeSegments(graph, node)) {
		const outward = segmentOutwardAtNode(graph, node, segment);
		if (!outward) continue;
		arms.push({
			segment,
			startsHere: segment.startNodeId === node.id,
			outward,
			intervals: indexedIntervals(segment.lanes)
		});
	}
	return arms;
}

function centerMedianDisposition(
	arm: ResolutionArm,
	interval: IndexedInterval,
	pairs: ReturnType<typeof centerMedianPairs>
) {
	if (!isIslandLike(interval.laneType)) return null;
	const pair = pairs.find((candidate) => {
		if (candidate.a.segmentId !== arm.segment.id && candidate.b.segmentId !== arm.segment.id) {
			return false;
		}
		return (
			overlap(interval, { start: candidate.start, end: candidate.end }) > CENTER_MEDIAN_MIN_WIDTH
		);
	});
	if (!pair) return null;

	const isA = pair.a.segmentId === arm.segment.id;
	const other = isA ? pair.b : pair.a;
	const flipped = pair.a.startsHere === pair.b.startsHere;
	const target =
		isA || !flipped ? { start: pair.start, end: pair.end } : { start: -pair.end, end: -pair.start };
	return {
		kind: 'continue',
		targetArmId: other.segmentId,
		targetInterval: target,
		seam: false
	} satisfies StripDisposition;
}

export function resolveNodeStrips(graph: Graph, node: Node) {
	const arms = resolvedArms(graph, node);
	const through = nodeThroughPair(graph, node);
	const throughIds = through ? new Set([through[0].id, through[1].id]) : new Set<string>();
	const structuralPair =
		through ??
		(() => {
			const centerlines = nodeCenterlines(graph);
			const roadArms = collectIntersectionArms(graph, node, centerlines).filter(
				(arm) => arm.hasRoad
			);
			const crossingConnectors = activeConnectionsAt(graph, node, centerlines).map(
				(connection) => ({
					a: connection.fromPoint,
					b: connection.toPoint
				})
			);
			const pairs = centerMedianPairs(node, roadArms, crossingConnectors);
			return pairs.length === 1
				? ([
						graph.segments.get(pairs[0].a.segmentId),
						graph.segments.get(pairs[0].b.segmentId)
					].filter((segment) => segment !== undefined) as Segment[])
				: null;
		})();
	const throughPairIds =
		structuralPair && structuralPair.length === 2
			? ([structuralPair[0].id, structuralPair[1].id] as [string, string])
			: null;

	const centerlines = isPatchNode(graph, node) ? nodeCenterlines(graph) : null;
	const crossingConnectors = centerlines
		? activeConnectionsAt(graph, node, centerlines).map((connection) => ({
				a: connection.fromPoint,
				b: connection.toPoint
			}))
		: [];
	const roadArms = centerlines
		? collectIntersectionArms(graph, node, centerlines).filter((arm) => arm.hasRoad)
		: [];
	const medianPairs = centerlines ? centerMedianPairs(node, roadArms, crossingConnectors) : [];

	return {
		arms: arms.map((arm) => {
			const other =
				through && throughIds.has(arm.segment.id)
					? arms.find((candidate) => throughIds.has(candidate.segment.id) && candidate !== arm)
					: null;
			const sameSection =
				other && lanesStructureKey(arm.segment.lanes) === lanesStructureKey(other.segment.lanes);

			return {
				segmentId: arm.segment.id,
				startsHere: arm.startsHere,
				outward: arm.outward,
				strips: arm.intervals.map((interval) => {
					let disposition: StripDisposition = { kind: 'terminate', cover: 'roadway' };
					if (other && sameSection) {
						disposition = sameSectionDisposition(arm, other, interval);
					} else if (other) {
						disposition = transitionDisposition(arm, other, interval);
					} else {
						disposition = centerMedianDisposition(arm, interval, medianPairs) ?? disposition;
					}

					return {
						laneRange: interval.laneRange,
						intervalIndex: interval.index,
						interval: { start: interval.start, end: interval.end },
						surfaceClass: interval.surfaceClass,
						material: interval.material,
						direction: interval.direction,
						disposition
					};
				})
			};
		}),
		throughPairIds
	};
}
