// Single source of truth for how the editor's overlays look: the selection
// palette, node rings, and the colours every handle shares. Change a value
// HERE and it updates everywhere — never redefine these per renderer.

// What is picked: hover, selection and delete tint node rings, road
// highlights, the marquee and handles.
export const HOVER_COLOR = 0x67e8f9; // cyan — hover / active / marquee
export const SELECT_COLOR = 0xfacc15; // yellow — selected / committed
export const DANGER_COLOR = 0xef4444; // red — delete, an invalid drop
export const VALID_COLOR = 0x22c55e; // green — a valid drop

// Node rings are a fixed size on screen, and the ring is the node's click
// area: zoomed in, the roads between close nodes come clear of their rings.
// The ring's stroke, and the marquee frame's, are screen pixels too.
export const NODE_RING_PX = 20;
export const RING_THICKNESS_PX = 3;

// Handles: shape says what a handle does, colour says its state. No handle
// has a colour of its own. Every one rests in HANDLE_FILL, white, which reads
// on asphalt, grass, paving and the yellow selected-road highlight; under the
// pointer, in hand (being dragged), or as a drop target it takes the
// selection palette's tint. Every one has the same dark outline,
// HANDLE_OUTLINE_PX wide on screen. Shapes, sizes and corner rounding are in
// handle-shapes.ts. Editor lines (handle guides, connector movements; see
// editor-line.ts) are drawn in the handle fill too.
export const HANDLE_FILL = 0xffffff;
export type HandleState = 'rest' | 'hover' | 'active' | 'valid' | 'danger';
export const HANDLE_STATE_COLOR: Record<HandleState, number> = {
	rest: HANDLE_FILL,
	hover: HOVER_COLOR,
	active: SELECT_COLOR,
	valid: VALID_COLOR,
	danger: DANGER_COLOR
};
export const HANDLE_OUTLINE_COLOR = 0x111827;
export const HANDLE_OUTLINE_PX = 1.5;
// How far past a handle's drawn shape a press still picks it.
export const HANDLE_HIT_SLACK_PX = 4;

// Lane connector dots are sized on screen but never wider than
// LANE_DOT_MAX_RADIUS world units, so zoomed out the dots of neighbouring
// lanes stay apart.
export const LANE_DOT_PX = 6;
export const LANE_DOT_MAX_RADIUS = 1.2;
