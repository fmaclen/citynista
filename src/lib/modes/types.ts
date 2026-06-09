export interface ModeHandlers {
	onMouseDown?: (event: MouseEvent) => void;
	onMouseMove?: (event: MouseEvent) => void;
	onMouseUp?: (event: MouseEvent) => void;
	onKeyDown?: (event: KeyboardEvent) => void;
	cleanup?: () => void;
}

export type Mode = 'draw' | 'select';
