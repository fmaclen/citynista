import { Canvas, type TPointerEventInfo } from 'fabric';
import { setContext, getContext } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { Graph } from './graph.svelte';
import { setupDraw } from './modes/draw';
import { setupSelect } from './modes/select';
import type { Segment } from './segment.svelte';

type ModeHandlers = {
	onMouseDown: (e: TPointerEventInfo) => void;
	onMouseMove: (e: TPointerEventInfo) => void;
	onMouseUp: (e: TPointerEventInfo) => void;
	onKeyDown?: (e: KeyboardEvent) => void;
	cleanup: () => void;
};

export type Mode = 'draw' | 'select' | undefined;

export class Editor {
	graph: Graph;
	canvas: Canvas | null = null;

	mode = $state<Mode>(undefined);

	selectedSegments = new SvelteSet<string>();
	selectedNodes = new SvelteSet<string>();

	isDrafting = $state(false);
	draftSegment: Segment | null = null;

	private currentHandlers: ModeHandlers | null = null;

	constructor() {
		this.graph = new Graph();

		$effect(() => {
			if (this.mode && this.canvas) {
				this.setupModeHandlers();
			}
		});
	}

	initCanvas(canvasElement: HTMLCanvasElement) {
		this.canvas = new Canvas(canvasElement, {
			width: window.innerWidth,
			height: window.innerHeight,
			backgroundColor: '#2a2a2a',
			selection: false
		});

		this.graph.setCanvas(this.canvas);

		window.addEventListener('resize', () => {
			if (this.canvas) {
				this.canvas.setDimensions({
					width: window.innerWidth,
					height: window.innerHeight
				});
				this.canvas.renderAll();
			}
		});
	}

	async loadSavedData() {
		const saved = Graph.load();
		if (saved) {
			saved.nodes.forEach((nodeData) => this.graph.addNode(nodeData));
			saved.segments.forEach((segmentData) => this.graph.addSegment(segmentData));
		}
	}

	private setupModeHandlers() {
		if (!this.canvas) return;

		this.cleanupHandlers();

		if (this.mode === 'draw') {
			this.currentHandlers = setupDraw(this);
		} else if (this.mode === 'select') {
			this.currentHandlers = setupSelect(this);
		}

		if (this.currentHandlers) {
			this.canvas.on('mouse:down', this.currentHandlers.onMouseDown);
			this.canvas.on('mouse:move', this.currentHandlers.onMouseMove);
			this.canvas.on('mouse:up', this.currentHandlers.onMouseUp);

			if (this.currentHandlers.onKeyDown) {
				window.addEventListener('keydown', this.currentHandlers.onKeyDown);
			}
		}
	}

	private cleanupHandlers() {
		if (this.currentHandlers) {
			this.currentHandlers.cleanup();

			if (this.canvas) {
				this.canvas.off('mouse:down');
				this.canvas.off('mouse:move');
				this.canvas.off('mouse:up');
			}

			if (this.currentHandlers.onKeyDown) {
				window.removeEventListener('keydown', this.currentHandlers.onKeyDown);
			}

			this.currentHandlers = null;
		}
	}

	selectSegment(id: string) {
		this.selectedSegments.clear();
		this.selectedSegments.add(id);
		const segment = this.graph.segments.get(id);
		if (segment) segment.isSelected = true;
	}

	clearSelection() {
		this.selectedSegments.forEach((id) => {
			const segment = this.graph.segments.get(id);
			if (segment) segment.isSelected = false;
		});
		this.selectedSegments.clear();
		this.selectedNodes.clear();
	}

	deleteSelected() {
		this.selectedSegments.forEach((id) => {
			this.graph.deleteSegment(id);
		});
		this.clearSelection();
	}

	clearAll() {
		this.clearSelection();
		this.graph.clear();
	}
}

const EDITOR_CONTEXT_KEY = 'editor';

export function setEditorContext(): Editor {
	const editor = new Editor();
	setContext(EDITOR_CONTEXT_KEY, editor);
	return editor;
}

export function getEditorContext(): Editor {
	return getContext(EDITOR_CONTEXT_KEY);
}
