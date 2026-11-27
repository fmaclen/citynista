// How far, in screen pixels, a press may wander from where it went down and
// still be a click: past it the press has moved. A crossing handle slides
// only past it, and a command given while a press is in hand settles the
// press as a release only past it (Editor.settlePress).
export const CLICK_SLOP_PX = 3;

export interface ModeHandlers {
	onMouseDown?: (event: MouseEvent) => void;
	onMouseMove?: (event: MouseEvent) => void;
	// A mode that takes the release holds the press until it comes. Before a
	// command the editor gives a press that has moved its release early,
	// where the pointer last was, and takes back one that has not
	// (Editor.settlePress); Escape takes the press back either way
	// (Editor.cancelPress).
	onMouseUp?: (event: MouseEvent) => void;
	onDoubleClick?: (event: MouseEvent) => void;
	onKeyDown?: (event: KeyboardEvent) => void;
	onKeyUp?: (event: KeyboardEvent) => void;
	// Redraws the preview after a setting it reads changes under it.
	refresh?: () => void;
	// Takes back a step the mode holds that is not in the history yet,
	// before Undo reaches the history; false if it holds none.
	undo?: () => boolean;
	cleanup?: () => void;
}

// 'connector' and 'place' are transient editing modes; they are not toolbar
// modes.
export type Mode = 'draw' | 'circle' | 'select' | 'bulldoze' | 'split' | 'connector' | 'place';

// How an armed preset lays roads, in the order Tab cycles them. Straight and
// curve are draw mode (curve bends a road on from the one it continues);
// circle is circle mode.
export const DRAW_STYLES = ['straight', 'curve', 'circle'] as const;
export type DrawStyle = (typeof DRAW_STYLES)[number];
