export interface ModeHandlers {
	onMouseDown?: (event: MouseEvent) => void;
	onMouseMove?: (event: MouseEvent) => void;
	onMouseUp?: (event: MouseEvent) => void;
	onKeyDown?: (event: KeyboardEvent) => void;
	cleanup?: () => void;
}

export type Mode = 'draw' | 'select' | 'bulldoze';

// Cities-style drawing styles: straight click-click, curved as
// start/apex/end (the apex click is the quadratic control point), and
// smooth chaining where each segment's start tangent locks to the road it
// extends.
export type DrawStyle = 'straight' | 'curved' | 'smooth';
