import { Canvas } from 'fabric';
import type { RoadGraph } from '../graph/graph';
import { generateId } from '../graph/graph';
import type { OSMData } from './import';
import { latLonToCanvas } from './import';
import { createCurvedPathData } from '../geometry/path-utils';
import { createSegmentPath } from '../canvas-utils';

export function importOSMToGraph(osmData: OSMData, graph: RoadGraph, canvas: Canvas): void {
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

			const startNode = graph.getNode(startNodeId);
			const endNode = graph.getNode(endNodeId);

			if (!startNode || !endNode) continue;

			const controlX = (startNode.x + endNode.x) / 2;
			const controlY = (startNode.y + endNode.y) / 2;

			const pathData = createCurvedPathData(
				startNode.x,
				startNode.y,
				endNode.x,
				endNode.y,
				controlX,
				controlY
			);

			const path = createSegmentPath(pathData, canvas);

			const segmentId = generateId();

			startNode.connectedSegments.push(segmentId);
			endNode.connectedSegments.push(segmentId);

			graph.addSegment({
				id: segmentId,
				startNodeId: startNodeId,
				endNodeId: endNodeId,
				path: path,
				controlX: controlX,
				controlY: controlY
			});
		}
	});

	canvas.renderAll();
	console.log(`Imported OSM data: ${osmData.ways.length} ways`);
}
