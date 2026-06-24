import { getContext, setContext, untrack } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { Graph } from './core/graph.svelte';
import type { GraphData, Lane, LaneConnectionRef, LaneRef } from './core/types';
import { getDefaultTemplate } from './core/lane-template';
import { resolveCrossings } from './core/crossings';
import {
	computeIntersectionTrims,
	sampleTrimmedCenterline,
	transitionStraddle,
	transitionTaper
} from './core/road-geometry';
import type { CenterlineSample, Point } from './core/road-geometry';
import { isDefaultMovement, nodeConnectivity, sameConnectionRef } from './core/lane-connections';
import type { Barrier, LaneEndpoint, LaneConnection } from './core/lane-connections';
import { getQuadraticBezierTangent } from './geometry/bezier';
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
	// A straddling transition has a handle on each side at half the taper
	// length; they are linked (drag one, both move) and the stored setback is
	// twice the handle distance (the full taper spans both sides of the node).
	straddle?: { link: { segmentId: string; atStart: boolean } };
}
import type { ModeHandlers, Mode, DrawStyle } from './modes/types';
import { setupDrawMode } from './modes/draw';
import { setupSelectMode } from './modes/select';
import { setupBulldozeMode } from './modes/bulldoze';
import { setupSplitMode } from './modes/split';
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
const PASTE_OFFSET = 16;

interface ClipboardNodeSnapshot {
	id: string;
	x: number;
	y: number;
	disabledConnections?: LaneConnectionRef[];
	enabledConnections?: LaneConnectionRef[];
}

interface ClipboardSegmentSnapshot {
	id: string;
	startNodeId: string;
	endNodeId: string;
	controlX?: number;
	controlY?: number;
	lanes: Lane[];
}

interface SegmentClipboard {
	kind: 'segments';
	nodes: ClipboardNodeSnapshot[];
	segments: ClipboardSegmentSnapshot[];
}

interface RelativeLaneRef {
	armIndex: number;
	laneIndex: number;
}

interface RelativeConnectionRef {
	from: RelativeLaneRef;
	to: RelativeLaneRef;
}

interface NodeClipboard {
	kind: 'node';
	armCount: number;
	disabledConnections?: RelativeConnectionRef[];
	enabledConnections?: RelativeConnectionRef[];
}

type EditorClipboard = SegmentClipboard | NodeClipboard;

function cloneLanes(lanes: Lane[]) {
	return lanes.map((lane) => ({ ...lane }));
}

function cloneConnectionRef(connection: LaneConnectionRef): LaneConnectionRef {
	return {
		from: { ...connection.from },
		to: { ...connection.to }
	};
}

function cloneConnectionRefs(connections: LaneConnectionRef[] | undefined) {
	if (!connections || connections.length === 0) return undefined;
	return connections.map(cloneConnectionRef);
}

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
	private currentConnectors: {
		endpoints: LaneEndpoint[];
		connections: LaneConnection[];
		barriers: Barrier[];
	} = {
		endpoints: [],
		connections: [],
		barriers: []
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
	private boundClipboardKeyDown: ((e: KeyboardEvent) => void) | null = null;
	private hoveredNodeId: string | null = null;
	private hoveredSegmentId: string | null = null;
	private clipboard: EditorClipboard | null = null;

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
		this.setupClipboardKeys();
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

	private setupClipboardKeys() {
		this.boundClipboardKeyDown = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey)) return;
			const key = e.key.toLowerCase();
			if (key !== 'c' && key !== 'v') return;
			const target = e.target;
			if (target instanceof HTMLElement && target.tagName !== 'BODY') return;
			e.preventDefault();
			if (key === 'c') {
				this.copySelection();
			} else {
				this.paste();
			}
		};
		window.addEventListener('keydown', this.boundClipboardKeyDown);
	}

	private copySelection() {
		if (this.selectedSegments.size > 0) {
			this.copySelectedSegments();
		} else if (this.selectedNodes.size === 1) {
			this.copySelectedNodeConnections();
		}
	}

	private copySelectedSegments() {
		if (this.selectedSegments.size === 0) return;

		const nodes = new SvelteMap<string, ClipboardNodeSnapshot>();
		const segments: ClipboardSegmentSnapshot[] = [];

		for (const segmentId of this.selectedSegments) {
			const segment = this.graph.segments.get(segmentId);
			if (!segment) continue;
			const startNode = this.graph.nodes.get(segment.startNodeId);
			const endNode = this.graph.nodes.get(segment.endNodeId);
			if (!startNode || !endNode) continue;

			for (const node of [startNode, endNode]) {
				if (nodes.has(node.id)) continue;
				nodes.set(node.id, {
					id: node.id,
					x: node.x,
					y: node.y,
					disabledConnections: cloneConnectionRefs(node.disabledConnections),
					enabledConnections: cloneConnectionRefs(node.enabledConnections)
				});
			}

			segments.push({
				id: segment.id,
				startNodeId: segment.startNodeId,
				endNodeId: segment.endNodeId,
				controlX: segment.controlX,
				controlY: segment.controlY,
				lanes: cloneLanes(segment.lanes)
			});
		}

		if (segments.length === 0) return;
		this.clipboard = {
			kind: 'segments',
			nodes: [...nodes.values()],
			segments
		};
	}

	private sortedNodeArms(nodeId: string) {
		const node = this.graph.nodes.get(nodeId);
		if (!node) return [];

		const arms: { segmentId: string; laneCount: number; angle: number }[] = [];
		for (const segmentId of node.connectedSegments) {
			const segment = this.graph.segments.get(segmentId);
			if (!segment) continue;
			const startNode = this.graph.nodes.get(segment.startNodeId);
			const endNode = this.graph.nodes.get(segment.endNodeId);
			if (!startNode || !endNode) continue;

			const atStart = segment.startNodeId === node.id;
			const straight = atStart
				? { x: endNode.x - startNode.x, y: endNode.y - startNode.y }
				: { x: startNode.x - endNode.x, y: startNode.y - endNode.y };
			let direction = straight;
			if (segment.controlX !== undefined && segment.controlY !== undefined) {
				const tangent = getQuadraticBezierTangent(
					startNode.x,
					startNode.y,
					segment.controlX,
					segment.controlY,
					endNode.x,
					endNode.y,
					atStart ? 0 : 1
				);
				direction = atStart ? tangent : { x: -tangent.x, y: -tangent.y };
				if (Math.hypot(direction.x, direction.y) < 0.0001) direction = straight;
			}
			arms.push({
				segmentId,
				laneCount: segment.lanes.length,
				angle: Math.atan2(direction.y, direction.x)
			});
		}

		return arms
			.sort((a, b) => a.angle - b.angle)
			.map(({ segmentId, laneCount }) => ({ segmentId, laneCount }));
	}

	private relativeLaneRef(ref: LaneRef, armIndices: SvelteMap<string, number>) {
		const armIndex = armIndices.get(ref.segmentId);
		return armIndex === undefined ? null : { armIndex, laneIndex: ref.laneIndex };
	}

	private relativeConnectionRef(
		connection: LaneConnectionRef,
		armIndices: SvelteMap<string, number>
	) {
		const from = this.relativeLaneRef(connection.from, armIndices);
		const to = this.relativeLaneRef(connection.to, armIndices);
		return from && to ? { from, to } : null;
	}

	private relativeConnectionRefs(
		connections: LaneConnectionRef[] | undefined,
		armIndices: SvelteMap<string, number>
	) {
		if (!connections || connections.length === 0) return undefined;
		const relative = connections
			.map((connection) => this.relativeConnectionRef(connection, armIndices))
			.filter((connection) => connection !== null);
		return relative.length > 0 ? relative : undefined;
	}

	private copySelectedNodeConnections() {
		const nodeId = [...this.selectedNodes][0];
		const node = this.graph.nodes.get(nodeId);
		if (!node) return;

		const armIndices = new SvelteMap<string, number>();
		const arms = this.sortedNodeArms(node.id);
		arms.forEach((arm, index) => armIndices.set(arm.segmentId, index));

		this.clipboard = {
			kind: 'node',
			armCount: arms.length,
			disabledConnections: this.relativeConnectionRefs(node.disabledConnections, armIndices),
			enabledConnections: this.relativeConnectionRefs(node.enabledConnections, armIndices)
		};
	}

	private paste() {
		const clipboard = this.clipboard;
		if (!clipboard) return;
		if (clipboard.kind === 'segments' && this.selectedSegments.size > 0) {
			this.pasteLanesToSelectedSegments(clipboard);
			return;
		}
		if (
			clipboard.kind === 'node' &&
			this.selectedNodes.size === 1 &&
			this.selectedSegments.size === 0
		) {
			this.pasteNodeConnections(clipboard);
			return;
		}
		if (
			clipboard.kind === 'segments' &&
			this.selectedNodes.size === 0 &&
			this.selectedSegments.size === 0
		) {
			this.pasteNewSegments(clipboard);
		}
	}

	private pasteLanesToSelectedSegments(clipboard: SegmentClipboard) {
		const source = clipboard.segments[0];
		if (!source) return;

		for (const segmentId of this.selectedSegments) {
			const segment = this.graph.segments.get(segmentId);
			if (segment) {
				segment.lanes = cloneLanes(source.lanes);
			}
		}
		this.rebuildRoads();
		this.refreshSelectionVisuals();
		this.graph.save();
	}

	private mappedLaneRef(ref: RelativeLaneRef, arms: { segmentId: string; laneCount: number }[]) {
		const arm = arms[ref.armIndex];
		if (!arm || ref.laneIndex < 0 || ref.laneIndex >= arm.laneCount) return null;
		return { segmentId: arm.segmentId, laneIndex: ref.laneIndex };
	}

	private mappedConnectionRef(
		connection: RelativeConnectionRef,
		arms: { segmentId: string; laneCount: number }[]
	) {
		const from = this.mappedLaneRef(connection.from, arms);
		const to = this.mappedLaneRef(connection.to, arms);
		return from && to ? { from, to } : null;
	}

	private mappedConnectionRefs(
		connections: RelativeConnectionRef[] | undefined,
		arms: { segmentId: string; laneCount: number }[]
	) {
		if (!connections || connections.length === 0) return undefined;
		const mapped = connections
			.map((connection) => this.mappedConnectionRef(connection, arms))
			.filter((connection) => connection !== null);
		return mapped.length > 0 ? mapped : undefined;
	}

	private pasteNodeConnections(clipboard: NodeClipboard) {
		const nodeId = [...this.selectedNodes][0];
		const node = this.graph.nodes.get(nodeId);
		if (!node) return;

		const arms = this.sortedNodeArms(node.id);
		if (arms.length !== clipboard.armCount) return;

		node.disabledConnections = this.mappedConnectionRefs(clipboard.disabledConnections, arms);
		node.enabledConnections = this.mappedConnectionRefs(clipboard.enabledConnections, arms);
		this.rebuildRoads();
		this.graph.save();
	}

	private remapLaneRef(ref: LaneRef, segmentIds: SvelteMap<string, string>) {
		const segmentId = segmentIds.get(ref.segmentId);
		return segmentId ? { segmentId, laneIndex: ref.laneIndex } : null;
	}

	private remapConnectionRef(connection: LaneConnectionRef, segmentIds: SvelteMap<string, string>) {
		const from = this.remapLaneRef(connection.from, segmentIds);
		const to = this.remapLaneRef(connection.to, segmentIds);
		return from && to ? { from, to } : null;
	}

	private remapConnectionRefs(
		connections: LaneConnectionRef[] | undefined,
		segmentIds: SvelteMap<string, string>
	) {
		if (!connections || connections.length === 0) return undefined;
		const remapped = connections
			.map((connection) => this.remapConnectionRef(connection, segmentIds))
			.filter((connection) => connection !== null);
		return remapped.length > 0 ? remapped : undefined;
	}

	private pasteNewSegments(clipboard: SegmentClipboard) {
		const nodeIds = new SvelteMap<string, string>();
		const segmentIds = new SvelteMap<string, string>();

		for (const snapshot of clipboard.nodes) {
			const node = this.graph.createNode(snapshot.x + PASTE_OFFSET, snapshot.y + PASTE_OFFSET);
			nodeIds.set(snapshot.id, node.id);
			this.nodeRenderer.createNode(node);
		}

		for (const snapshot of clipboard.segments) {
			const startNodeId = nodeIds.get(snapshot.startNodeId);
			const endNodeId = nodeIds.get(snapshot.endNodeId);
			if (!startNodeId || !endNodeId) continue;

			const segment = this.graph.createSegment(startNodeId, endNodeId, cloneLanes(snapshot.lanes));
			segmentIds.set(snapshot.id, segment.id);
			if (snapshot.controlX !== undefined && snapshot.controlY !== undefined) {
				segment.setControlPoint(snapshot.controlX + PASTE_OFFSET, snapshot.controlY + PASTE_OFFSET);
			}
		}

		for (const snapshot of clipboard.nodes) {
			const nodeId = nodeIds.get(snapshot.id);
			const node = nodeId ? this.graph.nodes.get(nodeId) : undefined;
			if (!node) continue;
			node.disabledConnections = this.remapConnectionRefs(snapshot.disabledConnections, segmentIds);
			node.enabledConnections = this.remapConnectionRefs(snapshot.enabledConnections, segmentIds);
		}

		this.clearSelection();
		for (const segmentId of segmentIds.values()) {
			this.selectSegment(segmentId);
		}
		this.rebuildRoads();
		this.refreshSelectionVisuals();
		this.graph.save();
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
		} else if (mode === 'split') {
			this.modeHandlers = setupSplitMode(this);
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
		if (!node) {
			this.currentSetbackHandles = [];
			this.setbackRenderer.clear();
			return;
		}
		// Junctions (3+ arms) get a handle per arm at its stop line. A straight
		// width-transition straddles its node, so it gets a linked handle on each
		// side at half the taper length; a bent transition keeps one handle on
		// the wide side.
		const isJunction = node.connectedSegments.length >= 3;
		const taper = isJunction ? null : transitionTaper(this.graph, node);
		const straddle = isJunction ? null : transitionStraddle(this.graph, node);
		if (!isJunction && !taper) {
			this.currentSetbackHandles = [];
			this.setbackRenderer.clear();
			return;
		}

		const trims = computeIntersectionTrims(this.graph);
		const rich: SetbackHandleInfo[] = [];
		const display: SetbackHandle[] = [];
		for (const segmentId of node.connectedSegments) {
			// A bent transition only handles the wide (morphing) segment; a
			// straddle handles both sides; a junction handles every arm.
			if (taper && !straddle && segmentId !== taper.segmentId) continue;
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

			// Seat the handle at its stop line — a straddle at half the taper
			// length (the taper end on this side), a bent transition at the taper
			// start, a junction at its trim — never closer than the minimum so a
			// through-road's two stops don't stack on the node.
			const trimDist = straddle
				? straddle.half
				: taper
					? taper.length
					: atStart
						? trim.start
						: trim.end;
			const nodePoint = { x: node.x, y: node.y };
			const handlePoint = pointAtArcLength(
				centerline,
				Math.max(trimDist, SETBACK_HANDLE_MIN_OFFSET)
			);
			let straddleInfo: SetbackHandleInfo['straddle'];
			if (straddle) {
				const otherId = node.connectedSegments.find((id) => id !== segmentId);
				const otherSeg = otherId ? this.graph.segments.get(otherId) : undefined;
				if (otherId && otherSeg) {
					straddleInfo = {
						link: { segmentId: otherId, atStart: otherSeg.startNodeId === node.id }
					};
				}
			}
			rich.push({
				segmentId,
				atStart,
				node: nodePoint,
				handle: handlePoint,
				centerline,
				straddle: straddleInfo
			});
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
		// A straddle handle sits at half the taper, so the stored setback (the
		// full taper length) is twice the drag distance, and the linked segment
		// on the other side gets the same value.
		const value = bestArc < 1 ? undefined : handle.straddle ? bestArc * 2 : bestArc;
		if (handle.atStart) segment.setbackStart = value;
		else segment.setbackEnd = value;

		if (handle.straddle) {
			const linked = this.graph.segments.get(handle.straddle.link.segmentId);
			if (linked) {
				if (handle.straddle.link.atStart) linked.setbackStart = value;
				else linked.setbackEnd = value;
			}
		}

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
		if (!node || node.connectedSegments.length < 2) return;
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
			this.currentConnectors = { endpoints: [], connections: [], barriers: [] };
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
		// A default movement is toggled by adding/removing it from the disabled
		// set; a non-default one (U-turn, median break) by adding/removing it from
		// the enabled set.
		const toggle = (list: typeof node.disabledConnections) => {
			const next = [...(list ?? [])];
			const existing = next.findIndex((d) => sameConnectionRef(d, ref));
			if (existing >= 0) next.splice(existing, 1);
			else next.push(ref);
			return next.length > 0 ? next : undefined;
		};
		if (
			isDefaultMovement(this.currentConnectors.endpoints, this.currentConnectors.barriers, from, to)
		) {
			node.disabledConnections = toggle(node.disabledConnections);
		} else {
			node.enabledConnections = toggle(node.enabledConnections);
		}
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

	// Drop the connector overlay when its node no longer exists (reset, fixture
	// load) — but keep it across an undo that preserves the node.
	private dropStaleConnector() {
		if (this.connectorNodeId && this.graph.nodes.has(this.connectorNodeId)) return;
		this.connectorNodeId = null;
		this.connectionRenderer.clear();
		if (this.mode === 'connector') this.mode = 'select';
	}

	clearAll() {
		this.clearSelection();
		this.nodeRenderer.clear();
		this.roadRenderer.clear();
		this.blockRenderer.clear();
		this.graph.clear();
		this.dropStaleConnector();
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
		this.dropStaleConnector();
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
		if (this.boundClipboardKeyDown) {
			window.removeEventListener('keydown', this.boundClipboardKeyDown);
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
