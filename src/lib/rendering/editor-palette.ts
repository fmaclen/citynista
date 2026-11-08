// Single source of truth for how the editor's overlays look: the selection
// palette, and the colour and on-screen size of every kind of handle. Change a
// colour or a size HERE and it updates everywhere — never redefine these per
// renderer.

// What is picked: hover, selection and delete tint node rings, road
// highlights and the marquee.
export const HOVER_COLOR = 0x67e8f9; // cyan — hover / active / marquee
export const SELECT_COLOR = 0xfacc15; // yellow — selected / committed
export const DANGER_COLOR = 0xef4444; // red — delete, an invalid drop
export const VALID_COLOR = 0x22c55e; // green — a valid drop

// World-unit stroke width of editor rings and the marquee frame.
export const RING_THICKNESS = 0.6;

// Handles: each kind has its own colour and shape, drawn at a fixed size on
// screen with a dark outline so it reads over asphalt, grass and paving alike.
// Sizes are half extents in screen pixels: `along` follows the handle's own
// axis (see handle-shapes.ts), `across` is perpendicular to it.
export const HANDLE_OUTLINE_COLOR = 0x111827;
export const HANDLE_OUTLINE_PX = 1.5;
// How far past a handle's drawn shape a press still picks it.
export const HANDLE_HIT_SLACK_PX = 4;

export interface HandleLook {
	color: number;
	along: number;
	across: number;
}

// A road's curvature: a square on the control point.
export const CURVE_HANDLE: HandleLook = { color: 0xe879f9, along: 7, across: 7 };
// A road's sideways offset: a two-headed arrow across the road.
export const OFFSET_HANDLE: HandleLook = { color: 0xfb923c, along: 14, across: 7 };
// Where a two-road node's taper ends: a triangle pointing along the road.
export const TAPER_HANDLE: HandleLook = { color: 0xa78bfa, along: 9, across: 8 };
// A crossing in the lane connector: a zebra bar across its road.
export const CROSSING_HANDLE: HandleLook = { color: 0x3b82f6, along: 14, across: 6 };
export const ZEBRA_STRIPE_COLOR = 0xffffff;

// Lane connector dots and the movements between them. Dots are sized on
// screen but never wider than LANE_DOT_MAX_RADIUS world units, so zoomed out
// the dots of neighbouring lanes stay apart.
export const LANE_COLOR = 0xffffff;
export const LANE_DOT_PX = 6;
export const LANE_DOT_MAX_RADIUS = 1.2;
