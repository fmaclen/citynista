import { Canvas } from 'fabric';
import type { ReactiveGraph } from './graph/graph.svelte';
import type { Mode } from './types';
import { setupDrawMode } from './modes/draw-mode';
import { setupEditMode } from './modes/edit-mode';

let currentMode: Mode = 'draw';
let drawModeHandlers: ReturnType<typeof setupDrawMode> | null = null;
let editModeHandlers: ReturnType<typeof setupEditMode> | null = null;
let canvasInstance: Canvas | null = null;
let graphInstance: ReactiveGraph | null = null;

export function setupCanvas(graph: ReactiveGraph): Canvas {
	const canvas = new Canvas('canvas', {
		width: window.innerWidth,
		height: window.innerHeight,
		backgroundColor: '#2a2a2a',
		selection: false
	});

	canvasInstance = canvas;
	graphInstance = graph;

	drawModeHandlers = setupDrawMode(canvas, graph);
	editModeHandlers = setupEditMode(canvas, graph);

	canvas.on('mouse:down', (options) => {
		if (currentMode === 'draw' && drawModeHandlers) {
			drawModeHandlers.onMouseDown(options);
		} else if (currentMode === 'edit' && editModeHandlers) {
			editModeHandlers.onMouseDown(options);
		}
	});

	canvas.on('mouse:move', (options) => {
		if (currentMode === 'draw' && drawModeHandlers) {
			drawModeHandlers.onMouseMove(options);
		} else if (currentMode === 'edit' && editModeHandlers) {
			editModeHandlers.onMouseMove(options);
		}
	});

	canvas.on('mouse:up', () => {
		if (currentMode === 'draw' && drawModeHandlers) {
			drawModeHandlers.onMouseUp();
		} else if (currentMode === 'edit' && editModeHandlers) {
			editModeHandlers.onMouseUp();
		}
	});

	canvas.on('object:moving', (options) => {
		if (currentMode === 'edit' && editModeHandlers) {
			editModeHandlers.onObjectMoving(options);
		}
	});

	canvas.on('object:modified', (options) => {
		if (currentMode === 'edit' && editModeHandlers) {
			editModeHandlers.onObjectModified(options);
		}
	});

	window.addEventListener('resize', () => {
		canvas.setDimensions({
			width: window.innerWidth,
			height: window.innerHeight
		});
		canvas.renderAll();
	});

	window.addEventListener('keydown', (event) => {
		if (currentMode === 'edit' && editModeHandlers) {
			editModeHandlers.onKeyDown(event);
		}
	});

	return canvas;
}

export function toggleMode(): void {
	if (!canvasInstance || !graphInstance) return;

	const newMode: Mode = currentMode === 'draw' ? 'edit' : 'draw';

	if (currentMode === 'draw' && drawModeHandlers) {
		drawModeHandlers.cleanup();
	} else if (currentMode === 'edit' && editModeHandlers) {
		editModeHandlers.cleanup();
	}

	currentMode = newMode;

	if (currentMode === 'draw') {
		drawModeHandlers = setupDrawMode(canvasInstance, graphInstance);
	} else {
		editModeHandlers = setupEditMode(canvasInstance, graphInstance);
	}
}
