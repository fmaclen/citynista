import type { NetworkNode, NetworkSegment } from './graph/graph.svelte';

export type Mode = 'draw' | 'edit';

export interface SnapResult {
	snappedX: number;
	snappedY: number;
	snappedNode: NetworkNode | null;
	snappedSegment: NetworkSegment | null;
}

export const ROAD_WIDTH = 4;
export const NODE_RADIUS = 6;
export const SNAP_THRESHOLD = 15;
