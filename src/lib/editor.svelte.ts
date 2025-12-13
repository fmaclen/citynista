import { getContext, setContext } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { Graph } from './core/graph.svelte';
import { SceneManager } from './rendering/scene.svelte';
import { NodeRenderer } from './rendering/node-renderer';
import { SegmentRenderer } from './rendering/segment-renderer';
import type { ModeHandlers, Mode } from './modes/types';
import { setupDrawMode } from './modes/draw';
import { setupSelectMode } from './modes/select';

const EDITOR_CONTEXT_KEY = Symbol('editor');

export class Editor {
	graph = new Graph();
	sceneManager!: SceneManager;
	nodeRenderer!: NodeRenderer;
	segmentRenderer!: SegmentRenderer;

	mode = $state<Mode | undefined>(undefined);
	selectedNodes = new SvelteSet<string>();
	selectedSegments = new SvelteSet<string>();

	private modeHandlers: ModeHandlers | null = null;
	private boundKeyDown: ((e: KeyboardEvent) => void) | null = null;

	constructor() {
		$effect(() => {
			this.setupMode(this.mode);
		});
	}

	private initialized = false;

	init(container: HTMLElement) {
		if (this.initialized) return;
		this.initialized = true;

		this.sceneManager = new SceneManager(container);
		this.nodeRenderer = new NodeRenderer(this.sceneManager.scene);
		this.segmentRenderer = new SegmentRenderer(this.sceneManager.scene);

		this.loadSavedData();
		this.setupCanvasEvents();
	}

	private loadSavedData() {
		if (this.graph.load()) {
			for (const node of this.graph.nodes.values()) {
				this.nodeRenderer.createNode(node);
			}
			for (const segment of this.graph.segments.values()) {
				const startNode = this.graph.nodes.get(segment.startNodeId);
				const endNode = this.graph.nodes.get(segment.endNodeId);
				if (startNode && endNode) {
					this.segmentRenderer.createSegment(segment, startNode, endNode);
				}
			}
		}
	}

	private setupCanvasEvents() {
		const canvas = this.sceneManager.getCanvas();

		canvas.addEventListener('mousedown', (e) => this.modeHandlers?.onMouseDown?.(e));
		canvas.addEventListener('mousemove', (e) => this.modeHandlers?.onMouseMove?.(e));
		canvas.addEventListener('mouseup', (e) => this.modeHandlers?.onMouseUp?.(e));
	}

	private setupMode(mode: Mode | undefined) {
		if (!this.sceneManager) return;

		if (this.modeHandlers?.cleanup) {
			this.modeHandlers.cleanup();
		}
		if (this.boundKeyDown) {
			window.removeEventListener('keydown', this.boundKeyDown);
			this.boundKeyDown = null;
		}

		this.clearSelection();
		this.modeHandlers = null;

		if (mode === 'draw') {
			this.modeHandlers = setupDrawMode(this);
		} else if (mode === 'select') {
			this.modeHandlers = setupSelectMode(this);
		}

		if (this.modeHandlers?.onKeyDown) {
			this.boundKeyDown = this.modeHandlers.onKeyDown;
			window.addEventListener('keydown', this.boundKeyDown);
		}
	}

	selectNode(nodeId: string) {
		this.selectedNodes.add(nodeId);
		this.nodeRenderer.setSelected(nodeId, true);
	}

	deselectNode(nodeId: string) {
		this.selectedNodes.delete(nodeId);
		this.nodeRenderer.setSelected(nodeId, false);
	}

	selectSegment(segmentId: string) {
		this.selectedSegments.add(segmentId);
		const segment = this.graph.segments.get(segmentId);
		if (segment) {
			const startNode = this.graph.nodes.get(segment.startNodeId);
			const endNode = this.graph.nodes.get(segment.endNodeId);
			if (startNode && endNode) {
				this.segmentRenderer.setSelected(segmentId, true, segment, startNode, endNode);
			}
		}
	}

	deselectSegment(segmentId: string) {
		this.selectedSegments.delete(segmentId);
		this.segmentRenderer.setSelected(segmentId, false);
	}

	clearSelection() {
		this.nodeRenderer.clearSelection();
		this.segmentRenderer.clearSelection();
		this.selectedNodes.clear();
		this.selectedSegments.clear();
	}

	deleteSelected() {
		const nodesToCheck = new Set<string>();
		const deletedSegments = new Set<string>();

		for (const segmentId of this.selectedSegments) {
			const segment = this.graph.segments.get(segmentId);
			if (segment) {
				nodesToCheck.add(segment.startNodeId);
				nodesToCheck.add(segment.endNodeId);
			}
			this.segmentRenderer.removeSegment(segmentId);
			this.graph.deleteSegment(segmentId);
			deletedSegments.add(segmentId);
		}

		for (const nodeId of this.selectedNodes) {
			if (nodesToCheck.has(nodeId)) {
				continue;
			}

			const node = this.graph.nodes.get(nodeId);
			if (node) {
				for (const segmentId of [...node.connectedSegments]) {
					if (deletedSegments.has(segmentId)) continue;

					const segment = this.graph.segments.get(segmentId);
					if (segment) {
						const otherNodeId =
							segment.startNodeId === nodeId ? segment.endNodeId : segment.startNodeId;
						nodesToCheck.add(otherNodeId);
					}
					this.segmentRenderer.removeSegment(segmentId);
					this.graph.deleteSegment(segmentId);
					deletedSegments.add(segmentId);
				}
				this.nodeRenderer.removeNode(nodeId);
				this.graph.deleteNode(nodeId);
				nodesToCheck.delete(nodeId);
			}
		}

		for (const nodeId of nodesToCheck) {
			const node = this.graph.nodes.get(nodeId);
			if (node && node.connectedSegments.length === 0) {
				this.nodeRenderer.removeNode(nodeId);
				this.graph.deleteNode(nodeId);
			}
		}

		this.selectedNodes.clear();
		this.selectedSegments.clear();
		this.graph.save();
	}

	clearAll() {
		this.clearSelection();
		this.nodeRenderer.clear();
		this.segmentRenderer.clear();
		this.graph.clear();
		this.graph.save();
	}

	dispose() {
		if (this.modeHandlers?.cleanup) {
			this.modeHandlers.cleanup();
		}
		if (this.boundKeyDown) {
			window.removeEventListener('keydown', this.boundKeyDown);
		}
		this.sceneManager?.dispose();
	}
}

export function setEditorContext() {
	const editor = new Editor();
	setContext(EDITOR_CONTEXT_KEY, editor);
	return editor;
}

export function getEditorContext(): Editor {
	return getContext(EDITOR_CONTEXT_KEY);
}
