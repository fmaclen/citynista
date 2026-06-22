import { getContext, setContext, untrack } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { Graph } from './core/graph.svelte';
import type { GraphData } from './core/types';
import { getDefaultTemplate } from './core/lane-template';
import { resolveCrossings } from './core/crossings';
import { computeIntersectionTrims, sampleTrimmedCenterline } from './core/road-geometry';
import type { CenterlineSample, Point } from './core/road-geometry';
import { nodeConnectivity, sameConnectionRef } from './core/lane-connections';
import type { LaneEndpoint, LaneConnection } from './core/lane-connections';
import type { LaneRef } from './core/types';
import { SceneManager } from './rendering/scene.svelte';
import { NodeRenderer, type NodeTone } from './rendering/node-renderer';
import { RoadRenderer } from './rendering/road-renderer';
import { BlockRenderer } from './rendering/block-renderer';
import { SelectionRenderer } from './rendering/selection-renderer';
import { SetbackRenderer, type SetbackHandle } from './rendering/setback-renderer';
import { ConnectionRenderer } from './rendering/connection-renderer';

// A draggable per-arm setback handle on a selected junction.
export interface SetbackHandleInfo {
	segmentId: string;
	atStart: boolean;
	node: Point;
	handle: Point;
	// Full (untrimmed) centerline, oriented node-side first, for projecting
	// the drag to an arc-length setback.
	centerline: CenterlineSample[];
}
import type { ModeHandlers, Mode, DrawStyle } from './modes/types';
import { setupDrawMode } from './modes/draw';
import { setupSelectMode } from './modes/select';
import { setupBulldozeMode } from './modes/bulldoze';
import { setupConnectorMode } from './modes/connector';

// Setback handles seat at least this far out from the node along their arm, so
// the two stops of a straight through-road don't land on the node together.
const SETBACK_HANDLE_MIN_OFFSET = 5;

function pointAtArcLength(points: Point[], target: number): Point {
	let acc = 0;
	for (let i = 1; i < points.length; i++) {
		const seg = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
		if (acc + seg >= target) {
			const t = seg > 0 ? (target - acc) / seg : 0;
			return {
				x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
				y: points[i - 1].y + (points[i].y - points[i - 1].y) * t
			};
		}
		acc += seg;
	}
	const last = points[points.length - 1];
	return { x: last.x, y: last.y };
}

const EDITOR_CONTEXT_KEY = Symbol('editor');

export class Editor {
	graph = new Graph();
	sceneManager!: SceneManager;
	nodeRenderer!: NodeRenderer;
	roadRenderer!: RoadRenderer;
	blockRenderer!: BlockRenderer;
	selectionRenderer!: SelectionRenderer;
	setbackRenderer!: SetbackRenderer;
	connectionRenderer!: ConnectionRenderer;
	private currentSetbackHandles: SetbackHandleInfo[] = [];
	// The junction being edited in connector mode, and its current lane
	// connectivity overlay (dots + movement arcs).
	connectorNodeId: string | null = null;
	private currentConnectors: { endpoints: LaneEndpoint[]; connections: LaneConnection[] } = {
		endpoints: [],
		connections: []
	};

	mode = $state<Mode>('select');
	drawStyle = $state<DrawStyle>('straight');
	currentLaneTemplateId = $state(getDefaultTemplate().id);
	fps = $state(0);
	canUndo = $state(false);
	canRedo = $state(false);
	selectedNodes = new SvelteSet<string>();
	selectedSegments = new SvelteSet<string>();

	private modeHandlers: ModeHandlers | null = null;
	private boundKeyDown: ((e: KeyboardEvent) => void) | null = null;
	private boundHistoryKeyDown: ((e: KeyboardEvent) => void) | null = null;
	private hoveredNodeId: string | null = null;
	private hoveredSegmentId: string | null = null;

	// Undo history as whole-graph snapshots, captured at the save boundary:
	// every operation (a draw click, a finished drag, a lane tweak, a
	// delete, a fixture load) ends in graph.save(), so one save equals one
	// undo step with no per-command bookkeeping.
	private undoStack: string[] = [];
	private redoStack: string[] = [];
	private presentState = '';
	private restoringHistory = false;

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
		this.blockRenderer = new BlockRenderer(this.sceneManager.scene);
		this.selectionRenderer = new SelectionRenderer(this.sceneManager.scene);
		this.setbackRenderer = new SetbackRenderer(this.sceneManager.scene);
		this.connectionRenderer = new ConnectionRenderer(this.sceneManager.scene);

		this.loadSavedData();
		this.presentState = JSON.stringify(this.graph.toJSON());
		this.graph.onSaved = (serialized) => this.recordHistory(serialized);
		this.setupCanvasEvents();
		this.setupHistoryKeys();
		// The mode effect already ran before init; install the default mode now.
		this.setupMode(this.mode);
	}

	private recordHistory(serialized: string) {
		if (this.restoringHistory || serialized === this.presentState) return;
		this.undoStack.push(this.presentState);
		if (this.undoStack.length > 100) this.undoStack.shift();
		this.redoStack.length = 0;
		this.presentState = serialized;
		this.canUndo = true;
		this.canRedo = false;
	}

	undo() {
		const previous = this.undoStack.pop();
		if (previous === undefined) return;
		this.redoStack.push(this.presentState);
		this.restoreState(previous);
	}

	redo() {
		const next = this.redoStack.pop();
		if (next === undefined) return;
		this.undoStack.push(this.presentState);
		this.restoreState(next);
	}

	private restoreState(serialized: string) {
		this.restoringHistory = true;
		this.presentState = serialized;
		// Mode-local state (a pending segment, a drag) may reference graph
		// objects that no longer exist; reinstalling the mode resets it.
		this.setupMode(this.mode);
		this.replaceGraph(JSON.parse(serialized));
		// setupMode rebuilt the connector overlay against the pre-undo graph;
		// refresh it now that the restored graph is in place.
		if (this.mode === 'connector') this.refreshConnectors();
		this.restoringHistory = false;
		this.canUndo = this.undoStack.length > 0;
		this.canRedo = this.redoStack.length > 0;
	}

	private setupHistoryKeys() {
		this.boundHistoryKeyDown = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
			const target = e.target;
			if (target instanceof HTMLElement && target.tagName !== 'BODY') return;
			e.preventDefault();
			if (e.shiftKey) {
				this.redo();
			} else {
				this.undo();
			}
		};
		window.addEventListener('keydown', this.boundHistoryKeyDown);
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
		const trims = computeIntersectionTrims(this.graph);
		this.roadRenderer.update(this.graph, trims);
		this.blockRenderer.update(this.graph, trims);
		for (const node of this.graph.nodes.values()) {
			this.nodeRenderer.setRadius(node.id, this.nodeRingRadius(node));
		}
	}

	// Node rings hug the widest road meeting at the node; the modes also use
	// this as the node's hit radius.
	nodeRingRadius(node: { connectedSegments: string[] }) {
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
		canvas.addEventListener('dblclick', (e) => {
			if (this.sceneManager.isCameraPanning()) return;
			this.modeHandlers?.onDoubleClick?.(e);
		});
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
		} else if (mode === 'bulldoze') {
			this.modeHandlers = setupBulldozeMode(this);
		} else if (mode === 'connector') {
			this.modeHandlers = setupConnectorMode(this);
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
		this.refreshSetbackHandles();
	}

	deselectNode(nodeId: string) {
		this.selectedNodes.delete(nodeId);
		this.nodeRenderer.setSelected(nodeId, false);
		this.refreshRevealedNodes();
		this.refreshSetbackHandles();
	}

	// Per-arm setback handles for a single selected junction (3+ arms): a dot
	// on each arm's stop line. Bends get no handle (the stop sits on the node).
	refreshSetbackHandles() {
		const nodeId = this.selectedNodes.size === 1 ? [...this.selectedNodes][0] : null;
		const node = nodeId ? this.graph.nodes.get(nodeId) : undefined;
		if (!node || node.connectedSegments.length < 3) {
			this.currentSetbackHandles = [];
			this.setbackRenderer.clear();
			return;
		}

		const trims = computeIntersectionTrims(this.graph);
		const rich: SetbackHandleInfo[] = [];
		const display: SetbackHandle[] = [];
		for (const segmentId of node.connectedSegments) {
			const segment = this.graph.segments.get(segmentId);
			if (!segment) continue;
			const startNode = this.graph.nodes.get(segment.startNodeId);
			const endNode = this.graph.nodes.get(segment.endNodeId);
			if (!startNode || !endNode) continue;

			const atStart = segment.startNodeId === node.id;
			const trim = trims.get(segmentId) ?? { start: 0, end: 0 };
			const trimmed = sampleTrimmedCenterline(segment, startNode, endNode, trim.start, trim.end);
			if (trimmed.length < 2) continue;
			let centerline = sampleTrimmedCenterline(segment, startNode, endNode, 0, 0);
			if (!atStart) centerline = [...centerline].reverse();

			// Seat the handle at its stop line, but never closer to the node than
			// the minimum, so a through-road's two stops don't stack on the node.
			const trimDist = atStart ? trim.start : trim.end;
			const nodePoint = { x: node.x, y: node.y };
			const handlePoint = pointAtArcLength(
				centerline,
				Math.max(trimDist, SETBACK_HANDLE_MIN_OFFSET)
			);
			rich.push({ segmentId, atStart, node: nodePoint, handle: handlePoint, centerline });
			display.push({ node: nodePoint, handle: handlePoint });
		}

		this.currentSetbackHandles = rich;
		this.setbackRenderer.show(display);
	}

	setbackHandleAt(worldX: number, worldZ: number): SetbackHandleInfo | null {
		const threshold = Math.max(2, this.sceneManager.worldPerPixel() * 10);
		let best: SetbackHandleInfo | null = null;
		let bestDistance = threshold;
		for (const handle of this.currentSetbackHandles) {
			const distance = Math.hypot(handle.handle.x - worldX, handle.handle.y - worldZ);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = handle;
			}
		}
		return best;
	}

	// Live update while dragging a setback handle: project the cursor onto the
	// arm's centerline and use the arc length from the node as the setback.
	setSetbackFromDrag(handle: SetbackHandleInfo, worldX: number, worldZ: number) {
		const points = handle.centerline;
		let accumulated = 0;
		let bestArc = 0;
		let bestDistance = Infinity;
		for (let i = 1; i < points.length; i++) {
			const ax = points[i - 1].x;
			const ay = points[i - 1].y;
			const dx = points[i].x - ax;
			const dy = points[i].y - ay;
			const lengthSq = dx * dx + dy * dy;
			const t =
				lengthSq > 0
					? Math.max(0, Math.min(1, ((worldX - ax) * dx + (worldZ - ay) * dy) / lengthSq))
					: 0;
			const px = ax + dx * t;
			const py = ay + dy * t;
			const distance = Math.hypot(px - worldX, py - worldZ);
			if (distance < bestDistance) {
				bestDistance = distance;
				bestArc = accumulated + t * Math.sqrt(lengthSq);
			}
			accumulated += Math.sqrt(lengthSq);
		}

		const segment = this.graph.segments.get(handle.segmentId);
		if (!segment) return;
		const value = bestArc < 1 ? undefined : bestArc;
		if (handle.atStart) segment.setbackStart = value;
		else segment.setbackEnd = value;

		this.rebuildRoads();
		this.refreshSetbackHandles();
	}

	finishSetback() {
		this.graph.save();
	}

	// Connector mode edits which movements a junction allows. Entry is a
	// double-click on a junction (3+ arms): the overlay shows a dot at each
	// lane mouth (cyan incoming, white outgoing) and an arc per movement;
	// toggling a movement recarves the junction pavement and persists.
	enterConnectorMode(nodeId: string) {
		const node = this.graph.nodes.get(nodeId);
		if (!node || node.connectedSegments.length < 3) return;
		this.clearSelection();
		this.connectorNodeId = nodeId;
		this.mode = 'connector';
	}

	exitConnectorMode() {
		this.connectorNodeId = null;
		this.mode = 'select';
	}

	refreshConnectors() {
		const node = this.connectorNodeId ? this.graph.nodes.get(this.connectorNodeId) : null;
		if (!node) {
			this.currentConnectors = { endpoints: [], connections: [] };
			this.connectionRenderer.clear();
			return;
		}
		this.currentConnectors = nodeConnectivity(this.graph, node);
		this.connectionRenderer.show(
			this.currentConnectors.connections,
			this.currentConnectors.endpoints
		);
	}

	// The lane dot nearest the cursor, either flow — used for hover feedback and
	// for picking both ends of a connector drag (direction-agnostic).
	connectorEndpointNear(worldX: number, worldZ: number): LaneEndpoint | null {
		const threshold = Math.max(2, this.sceneManager.worldPerPixel() * 12);
		let best: LaneEndpoint | null = null;
		let bestDistance = threshold;
		for (const endpoint of this.currentConnectors.endpoints) {
			const distance = Math.hypot(endpoint.point.x - worldX, endpoint.point.y - worldZ);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = endpoint;
			}
		}
		return best;
	}

	toggleConnection(from: LaneRef, to: LaneRef) {
		const node = this.connectorNodeId ? this.graph.nodes.get(this.connectorNodeId) : null;
		if (!node) return;
		const ref = { from, to };
		const disabled = [...(node.disabledConnections ?? [])];
		const existing = disabled.findIndex((d) => sameConnectionRef(d, ref));
		if (existing >= 0) disabled.splice(existing, 1);
		else disabled.push(ref);
		node.disabledConnections = disabled.length > 0 ? disabled : undefined;
		this.graph.save();
		this.rebuildRoads();
		this.refreshConnectors();
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
		this.currentSetbackHandles = [];
		this.setbackRenderer.clear();
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
			this.selectionRenderer.showHover(
				segment,
				startNode,
				endNode,
				this.nodeRingRadius(startNode),
				this.nodeRingRadius(endNode),
				this.mode === 'bulldoze'
			);
		} else {
			this.selectionRenderer.hideHover();
		}
		this.refreshRevealedNodes();
	}

	// Nodes shown despite the base visibility being off: selection endpoints
	// and the node under the cursor, toned by why they show (selection wins).
	private refreshRevealedNodes() {
		const revealed = new SvelteMap<string, NodeTone>();
		// In bulldoze mode the hover means "about to be demolished".
		const hoverTone: NodeTone = this.mode === 'bulldoze' ? 'danger' : 'hover';
		if (this.hoveredNodeId) {
			revealed.set(this.hoveredNodeId, hoverTone);
		}
		if (this.hoveredSegmentId) {
			const segment = this.graph.segments.get(this.hoveredSegmentId);
			if (segment) {
				revealed.set(segment.startNodeId, hoverTone);
				revealed.set(segment.endNodeId, hoverTone);
			}
		}
		for (const nodeId of this.selectedNodes) {
			revealed.set(nodeId, 'selected');
		}
		for (const segmentId of this.selectedSegments) {
			const segment = this.graph.segments.get(segmentId);
			if (segment) {
				revealed.set(segment.startNodeId, 'selected');
				revealed.set(segment.endNodeId, 'selected');
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

			this.selectionRenderer.showSegment(
				segment,
				startNode,
				endNode,
				this.nodeRingRadius(startNode),
				this.nodeRingRadius(endNode)
			);
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

		this.clearSelection();
		this.setHoveredNode(null);
		this.setHoveredSegment(null);
		this.rebuildRoads();
		this.graph.save();
	}

	clearAll() {
		this.clearSelection();
		this.nodeRenderer.clear();
		this.roadRenderer.clear();
		this.blockRenderer.clear();
		this.graph.clear();
		this.graph.save();
	}

	// Swap the whole working graph (fixture loads). Persists like any edit.
	replaceGraph(data: GraphData) {
		this.clearSelection();
		this.setHoveredNode(null);
		this.setHoveredSegment(null);
		this.nodeRenderer.clear();
		this.roadRenderer.clear();
		this.blockRenderer.clear();
		this.graph.fromJSON(data);
		for (const node of this.graph.nodes.values()) {
			this.nodeRenderer.createNode(node);
		}
		this.rebuildRoads();
		this.graph.save();
	}

	dispose() {
		if (this.modeHandlers?.cleanup) {
			this.modeHandlers.cleanup();
		}
		if (this.boundKeyDown) {
			window.removeEventListener('keydown', this.boundKeyDown);
		}
		if (this.boundHistoryKeyDown) {
			window.removeEventListener('keydown', this.boundHistoryKeyDown);
		}
		this.setbackRenderer?.dispose();
		this.connectionRenderer?.dispose();
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
