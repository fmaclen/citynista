import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Graph as GraphType } from '../src/lib/core/graph.svelte';
import type { Node } from '../src/lib/core/node.svelte';
import type { Segment } from '../src/lib/core/segment.svelte';
import type { GraphData } from '../src/lib/core/types';
import type { CenterlineSample, IntersectionArm, Point } from '../src/lib/core/road-geometry';
import type { ResolvedStrip } from '../src/lib/core/node-resolution';

const runeGlobals = globalThis as typeof globalThis & {
	$state: <T>(value: T) => T;
	$derived: <T>(value: T) => T;
};
runeGlobals.$state = (value) => value;
runeGlobals.$derived = (value) => value;

const { Graph } = await import('../src/lib/core/graph.svelte');
const {
	collectIntersectionArms,
	computeIntersectionTrims,
	getLaneIntervals,
	isContinuationNode,
	sampleTrimmedCenterline,
	transitionMorph,
	transitionStraddle
} = await import('../src/lib/core/road-geometry');
const { activeConnectionsAt } = await import('../src/lib/core/lane-connections');
const { isIslandLike, surfaceClassOf } = await import('../src/lib/core/lane-types');
const { resolveNodeStrips } = await import('../src/lib/core/node-resolution');

interface Decision {
	kind: 'continue' | 'terminate';
	targetArmId?: string;
	targetInterval?: { start: number; end: number };
	source: string;
}

interface StripRecord {
	segmentId: string;
	intervalIndex: number;
	surface: string;
	material: string;
	resolver: Decision;
	legacy: Decision;
	sources: Decision[];
}

const FIXTURE_DIR = join(process.cwd(), 'static/fixtures');
const CENTER_MEDIAN_PAIR_DOT = -0.85;
const CENTER_MEDIAN_MIN_WIDTH = 0.1;
const MEDIAN_BARRIER_REACH = 8;

function fixtureNames() {
	const names = new Set<string>();
	const files = readdirSync(FIXTURE_DIR).filter((file) => file.endsWith('.json'));
	if (files.includes('stress-test.json')) names.add('stress-test.json');
	for (const file of files) {
		const text = readFileSync(join(FIXTURE_DIR, file), 'utf8');
		if (
			/"raised"\s*:\s*true/.test(text) ||
			/"role"\s*:\s*"buffer"/.test(text) ||
			/"type"\s*:\s*"median"/.test(text) ||
			/"setback(Start|End)"/.test(text) ||
			/"material"\s*:\s*"concrete"/.test(text) ||
			/"type"\s*:\s*"concrete"/.test(text)
		) {
			names.add(file);
		}
	}
	return [...names].sort();
}

function loadGraph(file: string) {
	const graph: GraphType = new Graph();
	const data = JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) as GraphData;
	graph.fromJSON(data);
	return graph;
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

function rendererCenterlines(graph: GraphType) {
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

function centerMedianInterval(lanes: Segment['lanes']) {
	const intervals = getLaneIntervals(lanes);
	for (let i = 0; i < intervals.length; i++) {
		if (!isIslandLike(intervals[i].laneType)) continue;
		const roadBefore = intervals
			.slice(0, i)
			.some((iv) => surfaceClassOf(iv.laneType) === 'roadway');
		const roadAfter = intervals
			.slice(i + 1)
			.some((iv) => surfaceClassOf(iv.laneType) === 'roadway');
		if (roadBefore && roadAfter) return intervals[i];
	}
	return null;
}

function mirrorInterval(interval: { start: number; end: number }) {
	return { start: -interval.end, end: -interval.start };
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
	return flipped ? { ...interval, ...mirrorInterval(interval) } : interval;
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

function overlap(a: { start: number; end: number }, b: { start: number; end: number }) {
	return Math.min(a.end, b.end) - Math.max(a.start, b.start);
}

function asDecision(strip: ResolvedStrip) {
	if (strip.disposition.kind === 'continue') {
		return {
			kind: 'continue',
			targetArmId: strip.disposition.targetArmId,
			targetInterval: strip.disposition.targetInterval,
			source: 'resolver'
		} satisfies Decision;
	}
	return { kind: 'terminate', source: 'resolver' } satisfies Decision;
}

function closeInterval(
	a: { start: number; end: number } | undefined,
	b: { start: number; end: number } | undefined
) {
	if (!a || !b) return a === b;
	return Math.abs(a.start - b.start) < 0.001 && Math.abs(a.end - b.end) < 0.001;
}

function sameDecision(a: Decision, b: Decision) {
	if (a.kind !== b.kind) return false;
	if (a.kind === 'terminate') return true;
	if (a.targetInterval && b.targetInterval)
		return closeInterval(a.targetInterval, b.targetInterval);
	return true;
}

function legacyTransitionDecision(
	graph: GraphType,
	node: Node,
	segment: Segment,
	intervalIndex: number
) {
	const morph = transitionMorph(graph, node, segment.id);
	if (!morph) return null;
	const interval = getLaneIntervals(segment.lanes)[intervalIndex];
	const target = morph.intervals[intervalIndex];
	if (
		!target ||
		(isIslandLike(interval.laneType) && Math.abs(target.end - target.start) <= 0.0001)
	) {
		return { kind: 'terminate', source: 'transitionMorph' } satisfies Decision;
	}
	return {
		kind: 'continue',
		targetArmId: 'transition-pair',
		targetInterval: { start: target.start, end: target.end },
		source: 'transitionMorph'
	} satisfies Decision;
}

function legacyContinuationDecision(graph: GraphType, node: Node, segment: Segment) {
	if (!isContinuationNode(graph, node, segment.id)) return null;
	return {
		kind: 'continue',
		targetArmId: 'connection-pair',
		source: 'isContinuationNode'
	} satisfies Decision;
}

function legacyCenterMedianDecisions(
	graph: GraphType,
	node: Node,
	centerlines: Map<string, CenterlineSample[]>
) {
	const decisions = new Map<string, Decision>();
	const arms = collectIntersectionArms(graph, node, centerlines).filter((arm) => arm.hasRoad);
	const crossingConnectors = activeConnectionsAt(graph, node, centerlines).map((connection) => ({
		a: connection.fromPoint,
		b: connection.toPoint
	}));
	const pairs = centerMedianPairs(node, arms, crossingConnectors);
	for (const arm of arms) {
		const center = centerMedianInterval(arm.lanes);
		if (!center) continue;
		const intervals = getLaneIntervals(arm.lanes);
		const index = intervals.findIndex(
			(interval) =>
				interval.laneType === center.laneType &&
				interval.start === center.start &&
				interval.end === center.end
		);
		if (index < 0) continue;
		const key = `${arm.segmentId}:${index}`;
		const pair = pairs.find(
			(candidate) =>
				(candidate.a.segmentId === arm.segmentId || candidate.b.segmentId === arm.segmentId) &&
				overlap(center, { start: candidate.start, end: candidate.end }) > CENTER_MEDIAN_MIN_WIDTH
		);
		if (pair) {
			const other = pair.a.segmentId === arm.segmentId ? pair.b : pair.a;
			decisions.set(key, {
				kind: 'continue',
				targetArmId: other.segmentId,
				targetInterval: { start: pair.start, end: pair.end },
				source: 'centerMedianContinuations'
			});
		} else {
			decisions.set(key, { kind: 'terminate', source: 'centerMedianContinuations' });
		}
	}
	return decisions;
}

function recordsForNode(
	graph: GraphType,
	node: Node,
	centerlines: Map<string, CenterlineSample[]>
) {
	const resolution = resolveNodeStrips(graph, node);
	const centerMedian = legacyCenterMedianDecisions(graph, node, centerlines);
	const records: StripRecord[] = [];
	for (const arm of resolution.arms) {
		const segment = graph.segments.get(arm.segmentId);
		if (!segment) continue;
		for (const strip of arm.strips) {
			const key = `${arm.segmentId}:${strip.intervalIndex}`;
			const sources = [
				legacyTransitionDecision(graph, node, segment, strip.intervalIndex),
				legacyContinuationDecision(graph, node, segment),
				centerMedian.get(key) ?? null
			].filter((decision) => decision !== null);
			const legacy =
				sources.find((decision) => decision.kind === 'continue') ??
				({ kind: 'terminate', source: 'implicitPatchOrCut' } satisfies Decision);
			records.push({
				segmentId: arm.segmentId,
				intervalIndex: strip.intervalIndex,
				surface: strip.surfaceClass,
				material: strip.material,
				resolver: asDecision(strip),
				legacy,
				sources
			});
		}
	}
	return records;
}

function explain(record: StripRecord) {
	const sources =
		record.sources.length === 0
			? 'none'
			: record.sources
					.map(
						(source) =>
							`${source.source}:${source.kind}${source.targetArmId ? `->${source.targetArmId}` : ''}`
					)
					.join(', ');
	return `${record.segmentId}#${record.intervalIndex} ${record.surface}:${record.material} resolver=${record.resolver.kind} legacy=${record.legacy.kind} sources=[${sources}]`;
}

function printFixture(file: string) {
	const graph = loadGraph(file);
	const centerlines = rendererCenterlines(graph);
	let agreements = 0;
	let resolverDivergences = 0;
	let legacyDisagreements = 0;
	const fixtureLegacyDisagreements: string[] = [];
	const fixtureResolverDivergences: string[] = [];

	console.log(`\n${basename(file)}`);
	for (const node of graph.nodes.values()) {
		const records = recordsForNode(graph, node, centerlines);
		const nodeResolverDivergences = records.filter(
			(record) => !sameDecision(record.resolver, record.legacy)
		);
		const nodeLegacyDisagreements = records.flatMap((record) => {
			const disagreements: string[] = [];
			for (let i = 0; i < record.sources.length; i++) {
				for (let j = i + 1; j < record.sources.length; j++) {
					if (!sameDecision(record.sources[i], record.sources[j])) {
						disagreements.push(
							`${node.id} ${record.segmentId}#${record.intervalIndex} ${record.sources[i].source}:${record.sources[i].kind} vs ${record.sources[j].source}:${record.sources[j].kind}`
						);
					}
				}
			}
			return disagreements;
		});
		agreements += records.length - nodeResolverDivergences.length;
		resolverDivergences += nodeResolverDivergences.length;
		legacyDisagreements += nodeLegacyDisagreements.length;
		if (nodeResolverDivergences.length > 0 || nodeLegacyDisagreements.length > 0) {
			console.log(
				`  ${node.id}: agreements=${records.length - nodeResolverDivergences.length}, resolver-vs-legacy=${nodeResolverDivergences.length}, legacy-vs-legacy=${nodeLegacyDisagreements.length}`
			);
			for (const record of nodeResolverDivergences) {
				const detail = `    resolver divergence: ${explain(record)}`;
				console.log(detail);
				fixtureResolverDivergences.push(`${node.id} ${explain(record)}`);
			}
			for (const disagreement of nodeLegacyDisagreements) {
				const detail = `    legacy disagreement: ${disagreement}`;
				console.log(detail);
				fixtureLegacyDisagreements.push(disagreement);
			}
		}
	}
	console.log(
		`  summary: agreements=${agreements}, resolver-vs-legacy=${resolverDivergences}, legacy-vs-legacy=${legacyDisagreements}`
	);
	return { fixtureLegacyDisagreements, fixtureResolverDivergences };
}

try {
	const totals = { resolver: 0, legacy: 0 };
	const stressLegacy: string[] = [];
	const stressResolver: string[] = [];
	for (const file of fixtureNames()) {
		const result = printFixture(file);
		totals.resolver += result.fixtureResolverDivergences.length;
		totals.legacy += result.fixtureLegacyDisagreements.length;
		if (file === 'stress-test.json') {
			stressLegacy.push(...result.fixtureLegacyDisagreements);
			stressResolver.push(...result.fixtureResolverDivergences);
		}
	}
	console.log('\nStress-test legacy-vs-legacy disagreements:');
	console.log(
		stressLegacy.length === 0 ? '  none' : stressLegacy.map((line) => `  ${line}`).join('\n')
	);
	console.log('\nStress-test resolver-vs-legacy divergences:');
	console.log(
		stressResolver.length === 0 ? '  none' : stressResolver.map((line) => `  ${line}`).join('\n')
	);
	console.log(`\nTotals: resolver-vs-legacy=${totals.resolver}, legacy-vs-legacy=${totals.legacy}`);
} catch (error) {
	console.error(error);
}
