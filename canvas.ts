import { Canvas } from 'fabric';
import type { RoadGraph } from './graph/graph';
import type { Mode } from './types';
import { setupDrawMode } from './modes/draw-mode';
import { setupEditMode } from './modes/edit-mode';

let currentMode: Mode = 'draw';
let drawModeHandlers: ReturnType<typeof setupDrawMode> | null = null;
let editModeHandlers: ReturnType<typeof setupEditMode> | null = null;

export function setupCanvas(graph: RoadGraph): Canvas {
    const canvas = new Canvas('canvas', {
        width: window.innerWidth,
        height: window.innerHeight,
        backgroundColor: '#2a2a2a',
        selection: false
    });

    const drawBtn = document.getElementById('draw-btn');
    const clearBtn = document.getElementById('clear-btn');

    drawModeHandlers = setupDrawMode(canvas, graph);
    editModeHandlers = setupEditMode(canvas, graph);

    function toggleMode(): void {
        const newMode: Mode = currentMode === 'draw' ? 'edit' : 'draw';

        if (currentMode === 'draw' && drawModeHandlers) {
            drawModeHandlers.cleanup();
        } else if (currentMode === 'edit' && editModeHandlers) {
            editModeHandlers.cleanup();
        }

        currentMode = newMode;

        if (currentMode === 'draw') {
            drawBtn?.classList.add('active');
            drawModeHandlers = setupDrawMode(canvas, graph);
        } else {
            drawBtn?.classList.remove('active');
            editModeHandlers = setupEditMode(canvas, graph);
        }
    }

    drawBtn?.addEventListener('click', toggleMode);

    clearBtn?.addEventListener('click', () => {
        if (confirm('Are you sure you want to clear all segments? This cannot be undone.')) {
            graph.clear();
            canvas.clear();
            canvas.backgroundColor = '#2a2a2a';
            canvas.renderAll();
        }
    });

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
