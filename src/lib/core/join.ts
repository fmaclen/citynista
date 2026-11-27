// Dissolving a node back into one road: a node that only passes through two
// segments whose cross-sections and offsets match, once read in the same flow
// direction through it, can be joined.

import type { Graph } from './graph.svelte';
import { cloneLanes, reverseLanes, serializeLanes } from './lane-template';
import { mapJunction } from './junction-data';
import { drawnCurve, offsetOutOf } from './road-line';
import { joinCurves } from './segment-curve';
import type { Segment } from './segment.svelte';
import type { Lane } from './types';
import { carries } from './lane-types';
import { carryControls, joinedControls } from './crossing-controls';

// What joining a node would do, or null when it can't be joined: the two
// segments and their far nodes, and each segment's lanes read in the flow
// from A through the node to B.
export function joinPlan(graph: Graph, nodeId: string) {
	const node = graph.nodes.get(nodeId);
	if (!node || node.connectedSegments.length !== 2) return null;
	const pair = node.connectedSegments.map((id) => graph.segments.get(id));
	// The one ending at the node first, where one does, so a road cut in two
	// is joined the way it ran.
	const [segA, segB] = pair[1]?.endNodeId === nodeId ? [pair[1], pair[0]] : pair;
	if (!segA || !segB) return null;
	const farA = graph.nodes.get(segA.startNodeId === nodeId ? segA.endNodeId : segA.startNodeId);
	const farB = graph.nodes.get(segB.startNodeId === nodeId ? segB.endNodeId : segB.startNodeId);
	if (!farA || !farB || farA === farB) return null;
	const flowA = segA.endNodeId === nodeId ? segA.lanes : reverseLanes(segA.lanes);
	const flowB = segB.startNodeId === nodeId ? segB.lanes : reverseLanes(segB.lanes);
	// Each read to the right of the flow through the node.
	const offsetA = -offsetOutOf(segA, nodeId);
	const offsetB = offsetOutOf(segB, nodeId);
	if (serializeLanes(flowA) !== serializeLanes(flowB) || Math.abs(offsetA - offsetB) >= 1e-6)
		return null;
	return { node, segA, segB, farA, farB, flowA, flowB };
}

type JoinPlan = NonNullable<ReturnType<typeof joinPlan>>;

// Joins the node: one road from A's far node to B's replaces the two, and the
// node goes. Returns the merged road.
export function join(graph: Graph, { node, segA, segB, farA, farB, flowA, flowB }: JoinPlan) {
	// Read before the two go: whether they are one curve cut in two
	// (splitSegment in core/crossings.ts), and where each was listed.
	const whole = cutFrom(graph, segA, segB, node.id);
	const slot = graph.slotOf(segA.id);
	const lengthA = drawnCurve(graph, segA)?.length ?? 0;
	const merged = graph.createSegment(farA.id, farB.id, cloneLanes(flowA));
	merged.offsetStart = offsetOutOf(segA, farA.id);
	merged.offsetEnd = -offsetOutOf(segB, farB.id);
	if (whole) {
		// The curve it was cut from, exactly.
		if (whole.c) merged.setControlPoint(whole.c.x, whole.c.y);
	} else {
		// Keep the shape: bow the merged road through where the node sat unless
		// the three points were already collinear, in which case it stays
		// straight.
		const ax = farB.x - farA.x;
		const ay = farB.y - farA.y;
		const cross = ax * (node.y - farA.y) - ay * (node.x - farA.x);
		const lengthSq = ax * ax + ay * ay;
		if (lengthSq > 1e-6 && (cross * cross) / lengthSq > 0.25) {
			merged.setControlPoint(
				2 * node.x - (farA.x + farB.x) / 2,
				2 * node.y - (farA.y + farB.y) / 2
			);
		}
	}

	// The far nodes' junction edits move onto the merged road: A's end at
	// its far node is the merged start, B's the merged end, and B's lanes
	// are the merged lanes in the same order.
	const laneOfB: Record<string, string | undefined> = Object.fromEntries(
		flowB.map((l, i) => [l.id ?? '', merged.lanes[i]?.id])
	);
	const onMerged = (road: string, end: 'start' | 'end') => {
		if (road === segA.id)
			return end === (segA.startNodeId === node.id ? 'end' : 'start')
				? { road: merged.id, end: 'start' as const }
				: null;
		if (road === segB.id)
			return end === (segB.startNodeId === node.id ? 'end' : 'start')
				? { road: merged.id, end: 'end' as const }
				: null;
		return { road, end };
	};
	const laneOnMerged = (road: string, lane: string) =>
		road === segB.id ? (laneOfB[lane] ?? null) : lane;
	for (const far of [farA, farB]) {
		if (far.junction) far.junction = mapJunction(far.junction, onMerged, laneOnMerged);
	}
	// Crossings kept on the joined node move to the merged road's start,
	// measured from there.
	const moved = (node.junction?.crossings ?? []).flatMap((c) => {
		const onA = c.road === segA.id;
		const at = c.at === undefined ? undefined : onA ? lengthA - c.at : lengthA + c.at;
		const lanes = c.lanes.map((l) => (onA ? l : laneOfB[l])) as [string, string];
		return lanes[0] && lanes[1]
			? [{ ...c, road: merged.id, end: 'start' as const, at, lanes }]
			: [];
	});
	if (moved.length)
		farA.junction = {
			...farA.junction,
			crossings: [...(farA.junction?.crossings ?? []), ...moved]
		};

	// Crossing controls: both footpaths' carried onto the joined one, the
	// stronger where they name one carriageway; those naming a car road
	// joined name the joined road's carriageway holding the lanes theirs
	// named, each of A's lanes and B's the joined road's lane in its place in
	// the flow through the node (core/crossing-controls.ts).
	const inFlow = (flow: readonly Lane[]) =>
		new Map(
			flow.flatMap((l, i) => {
				const to = merged.lanes[i]?.id;
				return l.id && to ? [[l.id, to] as const] : [];
			})
		);
	if (carries(merged.lanes))
		carryControls(graph, [
			{ from: segA, to: [{ id: merged.id, lanes: merged.lanes, same: inFlow(flowA) }] },
			{ from: segB, to: [{ id: merged.id, lanes: merged.lanes, same: inFlow(flowB) }] }
		]);
	else merged.controls = joinedControls(segA.controls, segB.controls);

	graph.deleteSegment(segA.id);
	graph.deleteSegment(segB.id);
	graph.deleteNode(node.id);
	// Listed where the first was, so a road cut in two and joined again reads
	// at its nodes as it did (core/attach.ts).
	graph.putAt(slot, [merged.id]);
	return merged;
}

// The one curve two segments meeting at a node, the first ending there and
// the second starting there, were cut from (joinCurves), or null.
function cutFrom(graph: Graph, a: Segment, b: Segment, nodeId: string) {
	if (a.endNodeId !== nodeId || b.startNodeId !== nodeId) return null;
	const [ca, cb] = [drawnCurve(graph, a), drawnCurve(graph, b)];
	if (!ca || !cb) return null;
	const whole = joinCurves([ca, cb]);
	return whole.parts ? null : whole;
}
