import type { Graph } from './graph.svelte';
import { getTotalWidth } from './lane-template';
import {
	collectIntersectionArms,
	getLaneIntervals,
	nodeThroughPair,
	type CenterlineSample,
	type Point
} from './road-geometry';
import type { Node } from './node.svelte';
import type { Segment } from './segment.svelte';
import type { Lane, LaneDirection, LaneMaterial } from './types';
import {
	isIslandLike,
	isRoadway,
	laneLayer,
	lanePaintBetween,
	lanesStructureKey,
	surfaceClassOf,
	type LaneLayerId,
	type RoadLayerId,
	type SurfaceClass
} from './lane-types';

export interface Interval {
	start: number;
	end: number;
}

export interface NodeStripResolution {
	nodeId: string;
	kind: 'pair' | 'patch';
	arms: ResolvedNodeArm[];
	relations: StripRelation[];
	throughPairIds: [string, string] | null;
	signature: string;
}

export interface ResolvedNodeArm {
	segmentId: string;
	startsHere: boolean;
	frame: {
		stop: Point;
		into: Point;
		crossDir: Point;
		side: Point;
	};
	source: {
		lanesKey: string;
		structureKey: string;
		halfWidth: number;
		roadSpan: Interval;
		plateSpan: Interval;
	};
	node: {
		roadSpan: Interval;
		plateSpan: Interval;
	};
	strips: ResolvedNodeStrip[];
	paintBoundaries: ResolvedPaintBoundary[];
	centerNose: { intervalIndex: number; offset: number } | null;
	key: string;
}

export interface ResolvedNodeStrip {
	intervalIndex: number;
	laneRange: [number, number];
	laneType: LaneLayerId;
	surfaceClass: SurfaceClass;
	source: Interval;
	node: Interval | null;
	disposition: StripDisposition;
	roadwayUnderfill: { laneType: RoadLayerId; node: Interval } | null;
	severed: boolean;
}

export type StripDisposition =
	| {
			kind: 'continue';
			relationId: string;
			targetArmId: string;
			targetIntervalIndex: number;
			targetSource: Interval;
			shared: {
				lowEdgeId: string;
				highEdgeId: string;
				offsetsByArm: Record<string, Interval>;
			};
			anchor: 'self' | 'target' | 'none';
	  }
	| {
			kind: 'terminate';
			mode: 'taper' | 'patchStop';
			target: Interval | null;
			stopLine: Point | null;
	  };

export interface ResolvedPaintBoundary {
	boundaryIndex: number;
	sourceOffset: number;
	targetOffset: number | null;
	disposition: 'continue' | 'cutAtTaper' | 'stopAtPatch';
}

export interface StripRelation {
	id: string;
	sourceArmId: string;
	sourceIntervalIndex: number;
	targetArmId: string;
	targetIntervalIndex: number;
}

interface LaneInterval extends Interval {
	laneType: LaneLayerId;
}

interface IndexedInterval extends LaneInterval {
	index: number;
	laneRange: [number, number];
	surfaceClass: SurfaceClass;
}

interface ResolutionArmSource {
	segment: Segment;
	startsHere: boolean;
	frame: ResolvedNodeArm['frame'];
	intervals: IndexedInterval[];
	lanesKey: string;
	structureKey: string;
	halfWidth: number;
}

const resolutionCache = new Map<string, { signature: string; resolution: NodeStripResolution }>();

function roadwayLayer(material: LaneMaterial) {
	return `roadway:${material}` as const;
}

function at(interval: Interval) {
	return { start: interval.start, end: interval.end };
}

function center(interval: Interval) {
	return (interval.start + interval.end) / 2;
}

function width(interval: Interval) {
	return interval.end - interval.start;
}

function roadSpan(intervals: LaneInterval[]) {
	const roadways = intervals.filter((interval) => isRoadway(interval.laneType));
	if (roadways.length === 0) return { start: 0, end: 0 };
	return {
		start: Math.min(...roadways.map((interval) => interval.start)),
		end: Math.max(...roadways.map((interval) => interval.end))
	};
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

function laneBoundaryOffsets(lanes: Lane[]) {
	const bounds = [-getTotalWidth(lanes) / 2];
	for (const lane of lanes) {
		bounds.push(bounds[bounds.length - 1] + lane.width);
	}
	return bounds;
}

function paintDirection(lane: Lane, flipDirections: boolean) {
	if (!flipDirections || lane.direction === 'bidirectional') return lane.direction;
	return lane.direction === 'forward' ? 'backward' : 'forward';
}

function markingStructure(lanes: Lane[], flipDirections: boolean) {
	const bounds = laneBoundaryOffsets(lanes);
	const forwardDashes: { index: number; offset: number }[] = [];
	const backwardDashes: { index: number; offset: number }[] = [];
	let centerLine: { index: number; offset: number } | null = null;

	for (let k = 0; k + 1 < lanes.length; k++) {
		const leftDir = paintDirection(lanes[k], flipDirections);
		const rightDir = paintDirection(lanes[k + 1], flipDirections);
		const left = { ...lanes[k], direction: leftDir };
		const right = { ...lanes[k + 1], direction: rightDir };
		const paint = lanePaintBetween(left, right);
		if (!paint) continue;
		const offset = bounds[k + 1];
		if (paint.color === 'center') centerLine = { index: k, offset };
		else if (leftDir === 'forward') forwardDashes.push({ index: k, offset });
		else backwardDashes.push({ index: k, offset });
	}

	const forwardLanes: number[] = [];
	const backwardLanes: number[] = [];
	for (let i = 0; i < lanes.length; i++) {
		if (lanes[i].role !== 'vehicle') continue;
		const dir = paintDirection(lanes[i], flipDirections);
		if (dir === 'forward') forwardLanes.push(i);
		else if (dir === 'backward') backwardLanes.push(i);
	}
	let divider: { offset: number } | null = null;
	if (forwardLanes.length > 0 && backwardLanes.length > 0) {
		const maxB = Math.max(...backwardLanes);
		const minF = Math.min(...forwardLanes);
		const maxF = Math.max(...forwardLanes);
		const minB = Math.min(...backwardLanes);
		const offset =
			maxB < minF
				? (bounds[maxB + 1] + bounds[minF]) / 2
				: (bounds[maxF + 1] + bounds[minB]) / 2;
		divider = { offset };
	}

	const ref = divider ? divider.offset : 0;
	const centreOut = (a: { offset: number }, b: { offset: number }) =>
		Math.abs(a.offset - ref) - Math.abs(b.offset - ref) || a.offset - b.offset;
	forwardDashes.sort(centreOut);
	backwardDashes.sort(centreOut);

	return { forwardDashes, backwardDashes, centerLine, divider };
}

function laneBoundaryTargets(
	selfLanes: Lane[],
	anchorLanes: Lane[],
	flipDirections: boolean,
	keepOwnOffsets: boolean
) {
	const result: (number | null)[] = selfLanes.slice(1).map(() => null);
	const self = markingStructure(selfLanes, false);
	const anchor = markingStructure(anchorLanes, flipDirections);

	const pairDashes = (
		selfDashes: { index: number; offset: number }[],
		anchorDashes: { index: number; offset: number }[]
	) => {
		for (let i = 0; i < selfDashes.length; i++) {
			const counterpart = anchorDashes[i];
			if (!counterpart) continue;
			result[selfDashes[i].index] = keepOwnOffsets ? selfDashes[i].offset : counterpart.offset;
		}
	};
	pairDashes(self.forwardDashes, anchor.forwardDashes);
	pairDashes(self.backwardDashes, anchor.backwardDashes);

	if (self.centerLine && anchor.divider) {
		result[self.centerLine.index] = keepOwnOffsets ? self.centerLine.offset : anchor.divider.offset;
	}

	return result;
}

function mirrorIntervals(intervals: LaneInterval[]) {
	return intervals
		.map((interval) => ({
			laneType: interval.laneType,
			start: -interval.end,
			end: -interval.start
		}))
		.reverse();
}

function islandMatch(interval: LaneInterval, candidates: LaneInterval[]) {
	let best: LaneInterval | null = null;
	let bestOverlap = 0;
	for (const candidate of candidates) {
		if (candidate.laneType !== interval.laneType) continue;
		const amount = Math.min(interval.end, candidate.end) - Math.max(interval.start, candidate.start);
		if (amount > bestOverlap) {
			bestOverlap = amount;
			best = candidate;
		}
	}
	if (best) return best;

	let nearest: LaneInterval | null = null;
	let nearestDistance = Infinity;
	for (const candidate of candidates) {
		if (!isIslandLike(candidate.laneType)) continue;
		const distance = Math.abs(center(candidate) - center(interval));
		if (distance < nearestDistance) {
			nearest = candidate;
			nearestDistance = distance;
		}
	}
	if (nearest && nearestDistance <= width(interval) + width(nearest)) return nearest;
	return null;
}

function roadwayTarget(interval: Interval, anchorRoadways: LaneInterval[]) {
	const boundStart = Math.min(...anchorRoadways.map((i) => i.start));
	const boundEnd = Math.max(...anchorRoadways.map((i) => i.end));
	const targetWidth = Math.min(interval.end - interval.start, boundEnd - boundStart);
	const targetCenter = Math.min(
		boundEnd - targetWidth / 2,
		Math.max(boundStart + targetWidth / 2, (interval.start + interval.end) / 2)
	);
	return { start: targetCenter - targetWidth / 2, end: targetCenter + targetWidth / 2 };
}

function roadwayUnderfillLayer(selfIntervals: LaneInterval[], index: number) {
	const adjacent = [selfIntervals[index - 1], selfIntervals[index + 1]]
		.filter((interval) => interval && isRoadway(interval.laneType))
		.map((interval) => interval.laneType);
	return adjacent.length > 0 && adjacent.every((laneType) => laneType === 'roadway:concrete')
		? roadwayLayer('concrete')
		: roadwayLayer('asphalt');
}

function laneRanges(lanes: Lane[]) {
	const ranges: [number, number][] = [];
	let currentType: LaneLayerId | null = null;
	let start = 0;
	for (let i = 0; i < lanes.length; i++) {
		const laneType = laneLayer(lanes, i);
		if (currentType !== null && laneType !== currentType) {
			ranges.push([start, i - 1]);
			start = i;
		}
		currentType = laneType;
	}
	if (currentType !== null) ranges.push([start, lanes.length - 1]);
	return ranges;
}

function indexedIntervals(lanes: Lane[]) {
	const ranges = laneRanges(lanes);
	return getLaneIntervals(lanes).map((interval, index) => ({
		...interval,
		index,
		laneRange: ranges[index] ?? [0, 0],
		surfaceClass: surfaceClassOf(interval.laneType)
	}));
}

function paintBoundaries(
	lanes: Lane[],
	targets: (number | null)[],
	disposition: ResolvedPaintBoundary['disposition']
) {
	const offsets = laneBoundaryOffsets(lanes);
	return targets.map((targetOffset, boundaryIndex) => ({
		boundaryIndex,
		sourceOffset: offsets[boundaryIndex + 1],
		targetOffset,
		disposition: targetOffset === null ? disposition : 'continue'
	}));
}

function connectionSignature(refs: Node['disabledConnections']) {
	return (refs ?? [])
		.map((ref) => `${ref.from.segmentId}.${ref.from.laneIndex}>${ref.to.segmentId}.${ref.to.laneIndex}`)
		.sort()
		.join(',');
}

function resolutionSignature(
	graph: Graph,
	node: Node,
	arms: ResolutionArmSource[],
	kind: NodeStripResolution['kind']
) {
	const parts = [
		node.id,
		kind,
		`${node.x},${node.y}`,
		`dc:${connectionSignature(node.disabledConnections)}`,
		`ec:${connectionSignature(node.enabledConnections)}`
	];
	for (const segmentId of [...node.connectedSegments].sort()) {
		const segment = graph.segments.get(segmentId);
		if (!segment) continue;
		const isStart = segment.startNodeId === node.id;
		const far = graph.nodes.get(isStart ? segment.endNodeId : segment.startNodeId);
		const arm = arms.find((candidate) => candidate.segment.id === segmentId);
		const frame = arm
			? `${arm.frame.stop.x},${arm.frame.stop.y},${arm.frame.into.x},${arm.frame.into.y},${arm.frame.crossDir.x},${arm.frame.crossDir.y}`
			: '_';
		parts.push(
			[
				segmentId,
				segment.lanesKey,
				lanesStructureKey(segment.lanes),
				isStart ? 's' : 'e',
				isStart ? segment.setbackStart : segment.setbackEnd,
				segment.controlX ?? '_',
				segment.controlY ?? '_',
				far?.x ?? '_',
				far?.y ?? '_',
				frame
			].join(':')
		);
	}
	return parts.join('|');
}

function sourceArmFromIntersection(graph: Graph, arm: ReturnType<typeof collectIntersectionArms>[number]) {
	const segment = graph.segments.get(arm.segmentId);
	if (!segment) return null;
	return {
		segment,
		startsHere: arm.startsHere,
		frame: {
			stop: arm.stop,
			into: arm.into,
			crossDir: arm.crossDir,
			side: arm.side
		},
		intervals: indexedIntervals(segment.lanes),
		lanesKey: segment.lanesKey,
		structureKey: lanesStructureKey(segment.lanes),
		halfWidth: getTotalWidth(segment.lanes) / 2
	};
}

function relationFor(
	self: ResolutionArmSource,
	other: ResolutionArmSource,
	interval: IndexedInterval,
	target: Interval,
	anchor: StripDisposition extends infer D
		? D extends { kind: 'continue'; anchor: infer A }
			? A
			: never
		: never,
	targetIntervalIndex: number
) {
	const relationId = `${self.segment.id}:${interval.index}->${other.segment.id}:${targetIntervalIndex}`;
	return {
		kind: 'continue',
		relationId,
		targetArmId: other.segment.id,
		targetIntervalIndex,
		targetSource: target,
		shared: {
			lowEdgeId: `${relationId}:low`,
			highEdgeId: `${relationId}:high`,
			offsetsByArm: {
				[self.segment.id]: target,
				[other.segment.id]: target
			}
		},
		anchor
	} satisfies StripDisposition;
}

function targetIntervalIndex(target: Interval | null, candidates: LaneInterval[]) {
	if (!target) return -1;
	const exact = candidates.findIndex(
		(candidate) => candidate.start === target.start && candidate.end === target.end
	);
	if (exact >= 0) return exact;
	let best = -1;
	let bestOverlap = 0;
	for (let i = 0; i < candidates.length; i++) {
		const amount = Math.min(target.end, candidates[i].end) - Math.max(target.start, candidates[i].start);
		if (amount > bestOverlap) {
			bestOverlap = amount;
			best = i;
		}
	}
	return best;
}

function resolveTransitionArm(self: ResolutionArmSource, other: ResolutionArmSource) {
	const halfSelf = getTotalWidth(self.segment.lanes) / 2;
	const halfOther = getTotalWidth(other.segment.lanes) / 2;
	const selfIntervals = getLaneIntervals(self.segment.lanes);
	const flipped = self.startsHere === other.startsHere;
	const otherLanesInSelfFrame = flipped ? [...other.segment.lanes].reverse() : other.segment.lanes;
	const selfStructureKey = lanesStructureKey(self.segment.lanes);
	const otherStructureKey = lanesStructureKey(other.segment.lanes);
	const selfIsAnchor =
		halfSelf < halfOther - 0.01 ||
		(Math.abs(halfSelf - halfOther) <= 0.01 && selfStructureKey <= otherStructureKey);

	if (selfIsAnchor) {
		const laneBoundaries = laneBoundaryTargets(
			self.segment.lanes,
			otherLanesInSelfFrame,
			flipped,
			true
		);
		const targets = selfIntervals.map((interval) => at(interval));
		return {
			targets,
			roadwayUnderfills: selfIntervals.map(() => null),
			laneBoundaries,
			centerNose: null,
			anchor: true,
			anchorHalfWidth: halfSelf,
			anchorPlateSpan: { start: -halfSelf, end: halfSelf },
			dispositions: targets.map((target, index) =>
				relationFor(self, other, self.intervals[index], target, 'self', index)
			)
		};
	}

	let anchorIntervals = getLaneIntervals(other.segment.lanes);
	if (flipped) anchorIntervals = mirrorIntervals(anchorIntervals);

	const roadwayUnderfills: ({ laneType: RoadLayerId; node: Interval } | null)[] = selfIntervals.map(
		() => null
	);

	const targets = selfIntervals.map((interval) => {
		const index = selfIntervals.indexOf(interval);
		const surface = surfaceClassOf(interval.laneType);
		if (surface === 'walkway') return at(interval);

		const own = selfIntervals.filter((i) => i.laneType === interval.laneType);
		const counterparts = anchorIntervals.filter((i) => i.laneType === interval.laneType);

		if (own.length === counterparts.length && counterparts.length > 0) {
			return at(counterparts[own.indexOf(interval)]);
		}

		if (surface === 'roadway') {
			const anchorRoadways = anchorIntervals.filter((i) => isRoadway(i.laneType));
			if (anchorRoadways.length === 0) return { start: center(interval), end: center(interval) };
			return roadwayTarget(interval, anchorRoadways);
		}

		const match = islandMatch(interval, anchorIntervals);
		if (match) return at(match);

		const ownCenter = center(interval);
		const anchorRoadways = anchorIntervals.filter((i) => isRoadway(i.laneType));
		const noseTarget = () => {
			const targetCenter =
				anchorRoadways.length === 0
					? ownCenter
					: Math.min(
							Math.max(...anchorRoadways.map((i) => i.end)),
							Math.max(Math.min(...anchorRoadways.map((i) => i.start)), ownCenter)
						);
			roadwayUnderfills[index] = {
				laneType: roadwayUnderfillLayer(selfIntervals, index),
				node:
					anchorRoadways.length === 0
						? { start: targetCenter, end: targetCenter }
						: roadwayTarget(interval, anchorRoadways)
			};
			return { start: targetCenter, end: targetCenter };
		};

		if (surface === 'island') return noseTarget();
		return noseTarget();
	});

	const laneBoundaries = laneBoundaryTargets(
		self.segment.lanes,
		otherLanesInSelfFrame,
		flipped,
		false
	);
	const selfDivider = markingStructure(self.segment.lanes, false).divider;
	const anchorCenter = markingStructure(otherLanesInSelfFrame, flipped).centerLine;
	let centerNose: { intervalIndex: number; offset: number } | null = null;
	if (selfDivider && anchorCenter) {
		for (let i = 0; i < selfIntervals.length; i++) {
			const iv = selfIntervals[i];
			if (surfaceClassOf(iv.laneType) !== 'island') continue;
			if (iv.start - 0.01 <= selfDivider.offset && selfDivider.offset <= iv.end + 0.01) {
				const t = targets[i];
				if (t && Math.abs(t.end - t.start) < 1e-3) {
					centerNose = { intervalIndex: i, offset: anchorCenter.offset };
				}
				break;
			}
		}
	}

	return {
		targets,
		roadwayUnderfills,
		laneBoundaries,
		centerNose,
		anchor: false,
		anchorHalfWidth: halfOther,
		anchorPlateSpan: { start: -halfOther, end: halfOther },
		dispositions: targets.map((target, index) => {
			const interval = self.intervals[index];
			if (
				!target ||
				(isIslandLike(interval.laneType) && Math.abs(target.end - target.start) <= 0.0001)
			) {
				return {
					kind: 'terminate',
					mode: 'taper',
					target,
					stopLine: null
				} satisfies StripDisposition;
			}
			return relationFor(
				self,
				other,
				interval,
				target,
				'target',
				targetIntervalIndex(target, anchorIntervals)
			);
		})
	};
}

function buildResolvedArm(
	self: ResolutionArmSource,
	resolved: ReturnType<typeof resolveTransitionArm> | null,
	patchStop: boolean
) {
	const selfIntervals = getLaneIntervals(self.segment.lanes);
	const targets = resolved?.targets ?? selfIntervals.map((interval) => at(interval));
	const roadwayUnderfills = resolved?.roadwayUnderfills ?? selfIntervals.map(() => null);
	const laneBoundaries =
		resolved?.laneBoundaries ?? self.segment.lanes.slice(1).map(() => null as number | null);
	const sourceRoadSpan = roadSpan(selfIntervals);
	const plateSpan = { start: -self.halfWidth, end: self.halfWidth };
	const nodePlateSpan = resolved?.anchorPlateSpan ?? plateSpan;
	const nodeIntervals = targets.filter((target) => target !== null);
	const nodeRoadSpan = roadSpan(
		selfIntervals.flatMap((interval, index) => {
			const target = targets[index];
			return target && isRoadway(interval.laneType) ? [{ ...target, laneType: interval.laneType }] : [];
		})
	);
	const fallbackRoadSpan = nodeIntervals.length > 0 ? nodeRoadSpan : sourceRoadSpan;
	const strips = self.intervals.map((interval, index) => {
		const nodeTarget = patchStop ? null : targets[index];
		const disposition =
			resolved?.dispositions[index] ??
			({
				kind: 'terminate',
				mode: patchStop ? 'patchStop' : 'taper',
				target: nodeTarget,
				stopLine: patchStop ? self.frame.stop : null
			} satisfies StripDisposition);
		return {
			intervalIndex: interval.index,
			laneRange: interval.laneRange,
			laneType: interval.laneType,
			surfaceClass: interval.surfaceClass,
			source: at(interval),
			node: nodeTarget,
			disposition,
			roadwayUnderfill: roadwayUnderfills[index],
			severed: false
		};
	});
	const paintDisposition = patchStop ? 'stopAtPatch' : 'cutAtTaper';
	const arm = {
		segmentId: self.segment.id,
		startsHere: self.startsHere,
		frame: self.frame,
		source: {
			lanesKey: self.lanesKey,
			structureKey: self.structureKey,
			halfWidth: self.halfWidth,
			roadSpan: sourceRoadSpan,
			plateSpan
		},
		node: {
			roadSpan: fallbackRoadSpan,
			plateSpan: nodePlateSpan
		},
		strips,
		paintBoundaries: paintBoundaries(self.segment.lanes, laneBoundaries, paintDisposition),
		centerNose: resolved?.centerNose ?? null,
		key: ''
	};
	arm.key = [
		arm.segmentId,
		arm.node.plateSpan.start,
		arm.node.plateSpan.end,
		arm.strips.map((strip) => (strip.node ? `${strip.node.start},${strip.node.end}` : 'x')).join(';'),
		arm.paintBoundaries
			.map((boundary) =>
				boundary.targetOffset === null ? 'x' : Math.round(boundary.targetOffset * 100)
			)
			.join(','),
		arm.centerNose
			? `${arm.centerNose.intervalIndex},${Math.round(arm.centerNose.offset * 100)}`
			: 'x'
	].join('|');
	return arm;
}

export function resolveNodeStrips(
	graph: Graph,
	node: Node,
	centerlines: Map<string, CenterlineSample[]>
) {
	if (resolutionCache.size > 4096) resolutionCache.clear();
	const through = nodeThroughPair(graph, node);
	const kind = isPatchNode(graph, node) ? 'patch' : 'pair';
	const arms = collectIntersectionArms(graph, node, centerlines)
		.map((arm) => sourceArmFromIntersection(graph, arm))
		.filter((arm) => arm !== null);
	const signature = resolutionSignature(graph, node, arms, kind);
	const cached = resolutionCache.get(node.id);
	if (cached?.signature === signature) return cached.resolution;

	const throughPairIds = through ? ([through[0].id, through[1].id] as [string, string]) : null;
	const throughIds = through ? new Set(through.map((segment) => segment.id)) : new Set<string>();
	const transitionPair =
		through && lanesStructureKey(through[0].lanes) !== lanesStructureKey(through[1].lanes)
			? through
			: null;
	const transitionIds = transitionPair
		? new Set(transitionPair.map((segment) => segment.id))
		: new Set<string>();

	const resolvedArms = arms.map((arm) => {
		if (transitionPair && transitionIds.has(arm.segment.id)) {
			const other = arms.find(
				(candidate) => transitionIds.has(candidate.segment.id) && candidate.segment.id !== arm.segment.id
			);
			return buildResolvedArm(arm, other ? resolveTransitionArm(arm, other) : null, false);
		}
		return buildResolvedArm(arm, null, kind === 'patch' || (through ? !throughIds.has(arm.segment.id) : true));
	});

	const relations: StripRelation[] = [];
	for (const arm of resolvedArms) {
		for (const strip of arm.strips) {
			if (strip.disposition.kind !== 'continue') continue;
			relations.push({
				id: strip.disposition.relationId,
				sourceArmId: arm.segmentId,
				sourceIntervalIndex: strip.intervalIndex,
				targetArmId: strip.disposition.targetArmId,
				targetIntervalIndex: strip.disposition.targetIntervalIndex
			});
		}
	}

	const resolution = {
		nodeId: node.id,
		kind,
		arms: resolvedArms,
		relations,
		throughPairIds,
		signature
	} satisfies NodeStripResolution;
	resolutionCache.set(node.id, { signature, resolution });
	return resolution;
}
