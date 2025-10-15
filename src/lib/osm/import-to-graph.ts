import { Canvas } from 'fabric';
import type { Graph } from '../graph.svelte';
import { generateId } from '../constants';
import type { OSMData } from './import';
import { latLonToCanvas } from './import';
import { getDefaultControlPoint } from '../path-utils';

export function importOSMToGraph(osmData: OSMData, graph: Graph, canvas: Canvas): void {
	const osmNodeIdToGraphNodeId = new Map<string, string>();

	osmData.ways.forEach((way) => {
		const highwayType = way.tags['highway'];
		if (!highwayType) return;

		for (let i = 0; i < way.nodes.length; i++) {
			const osmNode = way.nodes[i]!;

			if (!osmNodeIdToGraphNodeId.has(osmNode.id)) {
				const canvasPos = latLonToCanvas(
					osmNode.lat,
					osmNode.lon,
					osmData.bounds,
					canvas.getWidth(),
					canvas.getHeight()
				);

				const existingNode = graph.findNearbyNode(canvasPos.x, canvasPos.y, 5);

				if (existingNode) {
					osmNodeIdToGraphNodeId.set(osmNode.id, existingNode.id);
				} else {
					const newNodeId = generateId();
					osmNodeIdToGraphNodeId.set(osmNode.id, newNodeId);

					graph.addNode({
						id: newNodeId,
						x: canvasPos.x,
						y: canvasPos.y,
						connectedSegments: []
					});
				}
			}
		}

		for (let i = 0; i < way.nodes.length - 1; i++) {
			const startOsmNode = way.nodes[i]!;
			const endOsmNode = way.nodes[i + 1]!;

			const startNodeId = osmNodeIdToGraphNodeId.get(startOsmNode.id);
			const endNodeId = osmNodeIdToGraphNodeId.get(endOsmNode.id);

			if (!startNodeId || !endNodeId) continue;

			const startNode = graph.nodes.get(startNodeId);
			const endNode = graph.nodes.get(endNodeId);

			if (!startNode || !endNode) continue;

			const controlPoint = getDefaultControlPoint(startNode.x, startNode.y, endNode.x, endNode.y);

			const segmentId = generateId();

			graph.addSegment({
				id: segmentId,
				startNodeId: startNodeId,
				endNodeId: endNodeId,
				controlX: controlPoint.x,
				controlY: controlPoint.y
			});
		}
	});

	canvas.renderAll();
	console.log(`Imported OSM data: ${osmData.ways.length} ways`);
}
