import { Canvas, Path } from 'fabric';
import type { RoadGraph, SerializedGraph } from './graph';
import { createCurvedPathData } from '../geometry/path-utils';
import { ROAD_WIDTH } from '../types';

export function restoreGraph(graph: RoadGraph, canvas: Canvas, data: SerializedGraph): void {
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

        const path = new Path(pathData);
        path.set({
            stroke: '#666666',
            strokeWidth: ROAD_WIDTH,
            fill: '',
            selectable: false,
            evented: true,
            strokeLineCap: 'round',
            hoverCursor: 'default',
            strokeUniform: true,
            objectCaching: false
        });

        canvas.add(path);

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
