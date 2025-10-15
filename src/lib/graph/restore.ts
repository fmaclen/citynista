import { Canvas } from 'fabric';
import type { ReactiveGraph, SerializedGraph } from './graph.svelte';
import { createCurvedPathData } from '../geometry/path-utils';
import { createSegmentPath } from '../canvas-utils';

export function restoreGraph(graph: ReactiveGraph, canvas: Canvas, data: SerializedGraph): void {
	graph.clear();
	canvas.clear();

	// First pass: add all nodes
	for (const nodeData of data.nodes) {
		graph.addNode({
			id: nodeData.id,
			x: nodeData.x,
			y: nodeData.y,
			connectedSegments: [...nodeData.connectedSegments]
		});
	}

	// Second pass: add all segments with their paths
	for (const segmentData of data.segments) {
		const startNode = graph.getNode(segmentData.startNodeId);
		const endNode = graph.getNode(segmentData.endNodeId);

		if (!startNode || !endNode) {
			console.warn(`Skipping segment ${segmentData.id}: missing nodes`);
			continue;
		}

		const pathData = createCurvedPathData(
			startNode.x,
			startNode.y,
			endNode.x,
			endNode.y,
			segmentData.controlX,
			segmentData.controlY
		);

		const path = createSegmentPath(pathData, canvas);

		graph.addSegment({
			id: segmentData.id,
			startNodeId: segmentData.startNodeId,
			endNodeId: segmentData.endNodeId,
			path: path,
			controlX: segmentData.controlX,
			controlY: segmentData.controlY
		});
	}

	canvas.renderAll();
	console.log(`Restored graph: ${data.nodes.length} nodes, ${data.segments.length} segments`);
}
