import { Canvas } from 'fabric';
import type { Graph } from './graph/graph.svelte';
import type { Mode } from './types';
import { setupDrawMode } from './modes/draw-mode';
import { setupEditMode } from './modes/edit-mode';

let currentMode: Mode = 'edit';
let drawModeHandlers: ReturnType<typeof setupDrawMode> | null = null;
let editModeHandlers: ReturnType<typeof setupEditMode> | null = null;
let canvasInstance: Canvas | null = null;
let graphInstance: Graph | null = null;

export function setupCanvas(graph: Graph, canvasElement: HTMLCanvasElement): Canvas {
	const canvas = new Canvas(canvasElement, {
		width: window.innerWidth,
		height: window.innerHeight,
		backgroundColor: '#2a2a2a',
		selection: false
	});

	canvasInstance = canvas;
	graphInstance = graph;

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

export function setMode(mode: 'draw' | 'edit' | undefined): void {
	if (!canvasInstance || !graphInstance) return;

	if (currentMode === 'draw' && drawModeHandlers) {
		drawModeHandlers.cleanup();
		drawModeHandlers = null;
	} else if (currentMode === 'edit' && editModeHandlers) {
		editModeHandlers.cleanup();
		editModeHandlers = null;
	}

	if (mode === 'draw') {
		currentMode = 'draw';
		drawModeHandlers = setupDrawMode(canvasInstance, graphInstance);
	} else if (mode === 'edit') {
		currentMode = 'edit';
		editModeHandlers = setupEditMode(canvasInstance, graphInstance);
	}
}
