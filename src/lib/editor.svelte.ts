import { getContext, setContext } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { Graph } from './core/graph.svelte';
import { getDefaultTemplate } from './core/lane-template';
import { resolveCrossings } from './core/crossings';
import { SceneManager } from './rendering/scene.svelte';
import { NodeRenderer } from './rendering/node-renderer';
import { RoadRenderer } from './rendering/road-renderer';
import { SelectionRenderer } from './rendering/selection-renderer';
import type { ModeHandlers, Mode } from './modes/types';
import { setupDrawMode } from './modes/draw';
import { setupSelectMode } from './modes/select';

const EDITOR_CONTEXT_KEY = Symbol('editor');

export class Editor {
	graph = new Graph();
	sceneManager!: SceneManager;
	nodeRenderer!: NodeRenderer;
	roadRenderer!: RoadRenderer;
	selectionRenderer!: SelectionRenderer;

	mode = $state<Mode | undefined>(undefined);
	currentLaneTemplateId = $state(getDefaultTemplate().id);
	fps = $state(0);
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

		this.sceneManager = new SceneManager(container, (fps) => {
			this.fps = fps;
		});
		this.nodeRenderer = new NodeRenderer(this.sceneManager.scene);
		this.roadRenderer = new RoadRenderer(this.sceneManager.scene);
		this.selectionRenderer = new SelectionRenderer(this.sceneManager.scene);

		this.loadSavedData();
		this.setupCanvasEvents();
	}

	private loadSavedData() {
		if (this.graph.load()) {
			for (const node of this.graph.nodes.values()) {
				this.nodeRenderer.createNode(node);
			}
			this.rebuildRoads();
		}
	}

	rebuildRoads() {
		this.roadRenderer.update(this.graph);
	}

	// Turn any mid-span segment crossings into shared nodes, so overlapping
	// roads become real intersections.
	resolveSegmentCrossings() {
		if (!resolveCrossings(this.graph)) return;

		this.clearSelection();
		for (const node of this.graph.nodes.values()) {
			if (!this.nodeRenderer.getMesh(node.id)) {
				this.nodeRenderer.createNode(node);
			}
		}
		this.rebuildRoads();
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

		const showNodes = mode === 'draw' || mode === 'select';
		this.nodeRenderer.setAllVisible(showNodes);

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
		this.refreshSelectionVisuals();
	}

	deselectSegment(segmentId: string) {
		this.selectedSegments.delete(segmentId);
		this.selectionRenderer.hideSegment(segmentId);
	}

	clearSelection() {
		this.nodeRenderer.clearSelection();
		this.selectionRenderer.clear();
		this.selectedNodes.clear();
		this.selectedSegments.clear();
	}

	refreshSelectionVisuals() {
		for (const segmentId of this.selectedSegments) {
			const segment = this.graph.segments.get(segmentId);
			if (!segment) continue;

			const startNode = this.graph.nodes.get(segment.startNodeId);
			const endNode = this.graph.nodes.get(segment.endNodeId);
			if (!startNode || !endNode) continue;

			this.selectionRenderer.showSegment(segment, startNode, endNode);
		}
	}

	deleteSelected() {
		const nodesToCheck = new SvelteSet<string>();
		const deletedSegments = new SvelteSet<string>();

		for (const segmentId of this.selectedSegments) {
			const segment = this.graph.segments.get(segmentId);
			if (segment) {
				nodesToCheck.add(segment.startNodeId);
				nodesToCheck.add(segment.endNodeId);
			}
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
		this.rebuildRoads();
		this.graph.save();
	}

	clearAll() {
		this.clearSelection();
		this.nodeRenderer.clear();
		this.roadRenderer.clear();
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
