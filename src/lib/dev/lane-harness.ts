import type { Graph } from '$lib/core/graph.svelte';
import { activeConnectionsAt } from '$lib/core/lane-connections';
import { resolveNodeStrips } from '$lib/core/node-resolution';
import { buildNodeLayers, transitionMorph } from '$lib/core/road-geometry';
import { buildCenterlines } from '$lib/rendering/road-renderer';

export function dumpLaneCorrespondence(graph: Graph) {
	const centerlines = buildCenterlines(graph);
	const records = [];

	for (const node of graph.nodes.values()) {
		if (node.connectedSegments.length < 2) continue;

		const resolution = resolveNodeStrips(graph, node, centerlines);
		const connectors = activeConnectionsAt(graph, node, centerlines);
		const crossing = connectors.map((connection) => ({
			a: connection.fromPoint,
			b: connection.toPoint
		}));
		const layers = buildNodeLayers(graph, node, centerlines, crossing);
		const morphs: Record<
			string,
			{
				laneBoundaries: (number | null)[];
				anchor: boolean;
				intervals: ({ start: number; end: number } | null)[];
			}
		> = {};

		for (const segmentId of resolution.throughPairIds ?? []) {
			const morph = transitionMorph(graph, node, segmentId, centerlines);
			if (!morph) continue;
			morphs[segmentId] = {
				laneBoundaries: morph.laneBoundaries,
				anchor: morph.anchor,
				intervals: morph.intervals
			};
		}

		records.push({
			nodeId: node.id,
			kind: resolution.kind,
			arms: resolution.arms,
			morphs,
			layers: layers.map((layer) => ({ id: layer.id, polygons: layer.polygons })),
			connectors: connectors.map((connection) => ({
				from: connection.from,
				to: connection.to,
				active: connection.active,
				fromPoint: connection.fromPoint,
				toPoint: connection.toPoint
			}))
		});
	}

	return JSON.parse(JSON.stringify({ nodes: records }));
}
