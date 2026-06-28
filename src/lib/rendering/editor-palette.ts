// Single source of truth for the editor's selection/hover palette and the shared
// stroke thickness of every editor ring/frame (node rings, connector dots, the
// selection marquee). Change a colour or the thickness HERE and it updates
// everywhere — never redefine these per renderer.
export const HOVER_COLOR = 0x67e8f9; // cyan — hover / active / marquee
export const SELECT_COLOR = 0xfacc15; // yellow — selected / committed
export const DANGER_COLOR = 0xef4444; // red — delete

// World-unit stroke width of editor rings and the marquee frame.
export const RING_THICKNESS = 0.6;
