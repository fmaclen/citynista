import { getContext, setContext, untrack } from 'svelte';
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

	mode = $state<Mode>('select');
	currentLaneTemplateId = $state(getDefaultTemplate().id);
	fps = $state(0);
	selectedNodes = new SvelteSet<string>();
	selectedSegments = new SvelteSet<string>();

	private modeHandlers: ModeHandlers | null = null;
	private boundKeyDown: ((e: KeyboardEvent) => void) | null = null;
	private hoveredNodeId: string | null = null;
	private hoveredSegmentId: string | null = null;

	constructor() {
		// Track only the mode itself: setupMode reads selection state internally
		// and must not re-run when that state changes.
		$effect(() => {
			const mode = this.mode;
			untrack(() => this.setupMode(mode));
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
		// The mode effect already ran before init; install the default mode now.
		this.setupMode(this.mode);
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
		for (const node of this.graph.nodes.values()) {
			this.nodeRenderer.setRadius(node.id, this.nodeRingRadius(node));
		}
	}

	// Node rings hug the widest road meeting at the node.
	private nodeRingRadius(node: { connectedSegments: string[] }) {
		let maxHalfWidth = 0;
		for (const segmentId of node.connectedSegments) {
			const segment = this.graph.segments.get(segmentId);
			if (segment) {
				maxHalfWidth = Math.max(maxHalfWidth, segment.totalWidth / 2);
			}
		}
		return (maxHalfWidth || 4) + 2;
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

		// SceneManager's own listeners run first; while it pans the camera
		// (space/alt/middle drag) the modes must not see the same gestures.
		canvas.addEventListener('mousedown', (e) => {
			if (this.sceneManager.isCameraPanning()) return;
			this.modeHandlers?.onMouseDown?.(e);
		});
		canvas.addEventListener('mousemove', (e) => {
			if (this.sceneManager.isCameraPanning()) return;
			this.modeHandlers?.onMouseMove?.(e);
		});
		canvas.addEventListener('mouseup', (e) => this.modeHandlers?.onMouseUp?.(e));
	}

	private setupMode(mode: Mode) {
		if (!this.sceneManager) return;

		if (this.modeHandlers?.cleanup) {
			this.modeHandlers.cleanup();
		}
		if (this.boundKeyDown) {
			window.removeEventListener('keydown', this.boundKeyDown);
			this.boundKeyDown = null;
		}

		this.clearSelection();
		this.setHoveredNode(null);
		this.setHoveredSegment(null);
		this.modeHandlers = null;

		if (mode === 'draw') {
			this.modeHandlers = setupDrawMode(this);
		} else {
			this.modeHandlers = setupSelectMode(this);
		}

		if (this.modeHandlers?.onKeyDown) {
			const handler = this.modeHandlers.onKeyDown;
			// Mode shortcuts (Delete, Escape...) must not fire while typing in
			// the lane panel or other UI controls.
			this.boundKeyDown = (e) => {
				const target = e.target;
				if (target instanceof HTMLElement && target.tagName !== 'BODY') return;
				handler(e);
			};
			window.addEventListener('keydown', this.boundKeyDown);
		}
	}

	selectNode(nodeId: string) {
		this.selectedNodes.add(nodeId);
		this.nodeRenderer.setSelected(nodeId, true);
		this.refreshRevealedNodes();
	}

	deselectNode(nodeId: string) {
		this.selectedNodes.delete(nodeId);
		this.nodeRenderer.setSelected(nodeId, false);
		this.refreshRevealedNodes();
	}

	selectSegment(segmentId: string) {
		this.selectedSegments.add(segmentId);
		this.refreshSelectionVisuals();
		this.refreshRevealedNodes();
	}

	deselectSegment(segmentId: string) {
		this.selectedSegments.delete(segmentId);
		this.selectionRenderer.hideSegment(segmentId);
		this.refreshRevealedNodes();
	}

	clearSelection() {
		this.nodeRenderer.clearSelection();
		this.selectionRenderer.clear();
		this.selectedNodes.clear();
		this.selectedSegments.clear();
		this.refreshRevealedNodes();
	}

	setHoveredNode(nodeId: string | null) {
		if (this.hoveredNodeId === nodeId) return;
		this.hoveredNodeId = nodeId;
		this.nodeRenderer.setHovered(nodeId);
		this.refreshRevealedNodes();
	}

	setHoveredSegment(segmentId: string | null) {
		if (this.hoveredSegmentId === segmentId) return;
		this.hoveredSegmentId = segmentId;

		// Selected segments already show their full selection visuals.
		const segment =
			segmentId && !this.selectedSegments.has(segmentId)
				? this.graph.segments.get(segmentId)
				: undefined;
		const startNode = segment && this.graph.nodes.get(segment.startNodeId);
		const endNode = segment && this.graph.nodes.get(segment.endNodeId);

		if (segment && startNode && endNode) {
			this.selectionRenderer.showHover(segment, startNode, endNode);
		} else {
			this.selectionRenderer.hideHover();
		}
		this.refreshRevealedNodes();
	}

	// Nodes shown despite the base visibility being off: selection endpoints
	// and the node under the cursor.
	private refreshRevealedNodes() {
		const revealed = new SvelteSet(this.selectedNodes);
		for (const segmentId of this.selectedSegments) {
			const segment = this.graph.segments.get(segmentId);
			if (segment) {
				revealed.add(segment.startNodeId);
				revealed.add(segment.endNodeId);
			}
		}
		if (this.hoveredNodeId) {
			revealed.add(this.hoveredNodeId);
		}
		if (this.hoveredSegmentId) {
			const segment = this.graph.segments.get(this.hoveredSegmentId);
			if (segment) {
				revealed.add(segment.startNodeId);
				revealed.add(segment.endNodeId);
			}
		}
		this.nodeRenderer.setRevealed(revealed);
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
		this.setHoveredNode(null);
		this.refreshRevealedNodes();
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
