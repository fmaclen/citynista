import { attachShift } from '../src/lib/core/attach';
import type { GraphData, Lane } from '../src/lib/core/types';

// Where a road's end at `nodeId` shows: the node, moved to the edge it is
// attached at (core/attach.ts), read off a plain saved graph.
export function attachedEnd(data: GraphData, segmentId: string, nodeId: string) {
	const segments = new Map(
		data.segments.map((s) => [
			s.id,
			{
				...s,
				offsetStart: s.offsetStart ?? 0,
				offsetEnd: s.offsetEnd ?? 0,
				lanes: s.lanes as Lane[]
			}
		])
	);
	const nodes = new Map(
		data.nodes.map((n) => [
			n.id,
			{
				...n,
				connectedSegments: data.segments
					.filter((s) => s.startNodeId === n.id || s.endNodeId === n.id)
					.map((s) => s.id)
			}
		])
	);
	const graph = { nodes, segments } as unknown as Parameters<typeof attachShift>[0];
	const node = nodes.get(nodeId)!;
	const shift = attachShift(graph, segments.get(segmentId)!, nodeId);
	return { x: node.x + shift.x, y: node.y + shift.y };
}
