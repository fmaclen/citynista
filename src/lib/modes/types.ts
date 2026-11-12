export interface ModeHandlers {
	onMouseDown?: (event: MouseEvent) => void;
	onMouseMove?: (event: MouseEvent) => void;
	onMouseUp?: (event: MouseEvent) => void;
	onDoubleClick?: (event: MouseEvent) => void;
	onKeyDown?: (event: KeyboardEvent) => void;
	// Redraws the preview after a setting it reads changes under it.
	refresh?: () => void;
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
