import type { NetworkNode, NetworkSegment } from './graph/graph';

export type Mode = 'draw' | 'edit';

export interface SnapResult {
    snappedX: number;
    snappedY: number;
    snappedNode: NetworkNode | null;
    snappedSegment: NetworkSegment | null;
}

export const ROAD_WIDTH = 8;
export const NODE_RADIUS = ROAD_WIDTH;
export const SNAP_THRESHOLD = 15;
