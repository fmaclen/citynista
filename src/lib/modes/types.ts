export interface ModeHandlers {
	onMouseDown?: (event: MouseEvent) => void;
	onMouseMove?: (event: MouseEvent) => void;
	onMouseUp?: (event: MouseEvent) => void;
	onDoubleClick?: (event: MouseEvent) => void;
	onKeyDown?: (event: KeyboardEvent) => void;
	cleanup?: () => void;
}

// 'connector' and 'place' are transient editing modes; they are not toolbar
// modes.
export type Mode = 'draw' | 'select' | 'bulldoze' | 'split' | 'connector' | 'place';
