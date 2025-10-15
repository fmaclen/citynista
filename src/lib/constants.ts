export const ROAD_WIDTH = 4;
export const NODE_RADIUS = 6;
export const SNAP_THRESHOLD = 15;

export function generateId(): string {
	return Math.random().toString(36).substring(2, 11);
}
