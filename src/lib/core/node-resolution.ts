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
import type { Lane } from './types';
import {
	isRoadway,
	laneLayer,
	lanesStructureKey,
	surfaceClassOf,
	type LaneLayerId,
	type RoadLayerId,
	type SurfaceClass
} from './lane-types';
import { matchTransitionArm, type MatcherResult } from './lane-matcher';

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

function at(interval: Interval) {
	return { start: interval.start, end: interval.end };
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

function buildResolvedArm(
	self: ResolutionArmSource,
	resolved: MatcherResult | null,
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
		key: ''
	};
	arm.key = [
		arm.segmentId,
		arm.node.plateSpan.start,
		arm.node.plateSpan.end,
		arm.strips.map((strip) => (strip.node ? `${strip.node.start},${strip.node.end}` : 'x')).join(';'),
		arm.paintBoundaries
			.map((boundary) => (boundary.targetOffset === null ? 'x' : Math.round(boundary.targetOffset * 100)))
			.join(',')
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
			const resolvedTransition = other
				? matchTransitionArm(
						{ segmentId: arm.segment.id, lanes: arm.segment.lanes, startsHere: arm.startsHere },
						{ segmentId: other.segment.id, lanes: other.segment.lanes, startsHere: other.startsHere }
					)
				: null;
			return buildResolvedArm(arm, resolvedTransition, false);
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
