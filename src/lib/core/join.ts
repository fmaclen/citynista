// Dissolving a node back into one road: a node that only passes through two
// segments whose cross-sections and offsets match, once read in the same flow
// direction through it, can be joined.

import type { Graph } from './graph.svelte';
import { cloneLanes, reverseLanes, serializeLanes } from './lane-template';
import { mapJunction } from './junction-data';
import { offsetOutOf } from './road-line';

// What joining a node would do, or null when it can't be joined: the two
// segments and their far nodes, and each segment's lanes read in the flow
// from A through the node to B.
export function joinPlan(graph: Graph, nodeId: string) {
	const node = graph.nodes.get(nodeId);
	if (!node || node.connectedSegments.length !== 2) return null;
	const segA = graph.segments.get(node.connectedSegments[0]);
	const segB = graph.segments.get(node.connectedSegments[1]);
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
	const merged = graph.createSegment(farA.id, farB.id, cloneLanes(flowA));
	merged.offsetStart = offsetOutOf(segA, farA.id);
	merged.offsetEnd = -offsetOutOf(segB, farB.id);
	// Keep the shape: bow the merged road through where the node sat unless the
	// three points were already collinear, in which case it stays straight.
	const ax = farB.x - farA.x;
	const ay = farB.y - farA.y;
	const cross = ax * (node.y - farA.y) - ay * (node.x - farA.x);
	const lengthSq = ax * ax + ay * ay;
	if (lengthSq > 1e-6 && (cross * cross) / lengthSq > 0.25) {
		merged.setControlPoint(2 * node.x - (farA.x + farB.x) / 2, 2 * node.y - (farA.y + farB.y) / 2);
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
	const lengthA = Math.hypot(node.x - farA.x, node.y - farA.y);
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

	graph.deleteSegment(segA.id);
	graph.deleteSegment(segB.id);
	graph.deleteNode(node.id);
	return merged;
}
