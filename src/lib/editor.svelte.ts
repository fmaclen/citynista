import * as THREE from 'three';
import { getContext, setContext, untrack } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { Graph } from './core/graph.svelte';
import { CityStore, loadExample } from './core/city-store';
import type {
	Brush,
	CameraState,
	CityRecord,
	CitySummary,
	GraphData,
	JunctionCrossing,
	JunctionData,
	Lane,
	LaneRef
} from './core/types';
import {
	cloneLanes,
	defaultHotbar,
	HOTBAR_SIZE,
	serializeLanes,
	reverseLanes
} from './core/lane-template';
import { resolveCrossings } from './core/crossings';
import type { Pt as Point } from './lab/model';
import type { LaneConnection } from './core/lane-connections';
import { CROSSING_DEPTH, CROSSING_FROM_END, endsOf, type EndInfo } from './lab/junction';
import { crossingAt } from './core/place';
import { mapJunction } from './core/junction-data';
import { nodePoint, roadLine } from './core/road-line';
import { segmentEnds } from './core/attach';
import { kindOf } from './lab/connect';
import { isTravel } from './lab/road';
import { endKey, type Control, type LaneRef as ModelLaneRef } from './lab/model';
import { crossSection, frameAt, offsetPoint, project } from './lab/geometry';
import { getQuadraticBezierTangent } from './geometry/bezier';
import { SceneManager, GRID_SUB } from './rendering/scene.svelte';
import { NodeRenderer, type NodeTone } from './rendering/node-renderer';
import { LabRenderer } from './rendering/lab-renderer';
import { COLOURS } from './lab/scene';
import { SelectionRenderer } from './rendering/selection-renderer';
import { HandleRenderer } from './rendering/handle-renderer';
import { offsetHandle, type OffsetHandle } from './modes/offset';
import { ConnectionRenderer } from './rendering/connection-renderer';
import {
	CROSSING_HANDLE,
	OFFSET_HANDLE,
	TAPER_HANDLE,
	hitsHandle
} from './rendering/handle-shapes';
import {
	HANDLE_HIT_SLACK_PX,
	LANE_DOT_PX,
	NODE_RING_PX,
	type HandleState
} from './rendering/editor-palette';

// A taper handle on a selected node where two roads meet: it sits where the
// transition ends on one of them.
export interface TaperHandleInfo {
	// Its place among the node's handles.
	index: number;
	nodeId: string;
	segmentId: string;
	atStart: boolean;
	node: Point;
	handle: Point;
	// Along the road at the handle, away from the node.
	dir: Point;
	// The road's line from the node out, for reading the drag as a distance
	// along it.
	centerline: Point[];
}

// One handle on the map, for tinting it by its state: a road's curvature
// handle, or a taper, offset or crossing handle by its place in the list shown.
export type HandleRef =
	| { kind: 'curve'; segmentId: string }
	| { kind: 'taper' | 'offset' | 'crossing'; index: number };
import { DRAW_STYLES, type DrawStyle, type ModeHandlers, type Mode } from './modes/types';
import { setupDrawMode } from './modes/draw';
import { setupCircleMode } from './modes/circle';
import { setupSelectMode } from './modes/select';
import { setupBulldozeMode } from './modes/bulldoze';
import { setupSplitMode } from './modes/split';
import { setupConnectorMode } from './modes/connector';
import { setupPlaceMode } from './modes/place';

// A new crosswalk lands this far beyond the end of its road's taper.
const NEW_CROSSING_BEYOND = 3;
// Lane dots of two road ends that nearly meet sit at least this far apart.
const CONNECTOR_SPREAD = 10;
// Taper handles sit at least this far from their node, so the node itself
// can always be grabbed.
const TAPER_HANDLE_REACH = 4;

// The point a distance along a polyline.
function pointAlong(points: Point[], distance: number): Point {
	let run = 0;
	for (let i = 1; i < points.length; i++) {
		const l = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
		if (run + l >= distance) {
			const f = l > 0 ? (distance - run) / l : 0;
			return {
				x: points[i - 1].x + (points[i].x - points[i - 1].x) * f,
				y: points[i - 1].y + (points[i].y - points[i - 1].y) * f
			};
		}
		run += l;
	}
	const last = points[points.length - 1];
	return { x: last.x, y: last.y };
}

// The unit direction a polyline runs at a distance along it.
function directionAlong(points: Point[], distance: number): Point {
	const a = pointAlong(points, Math.max(0, distance - 0.5));
	const b = pointAlong(points, distance + 0.5);
	const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
	return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
}

// A lane end in the lane connector: travel lanes are entered (`in`) or left
// (`out`); medians, grass and sidewalks connect either way (`both`).
export interface ConnectorEndpoint {
	ref: LaneRef;
	lane: ModelLaneRef;
	kind: string;
	point: Point;
	dir: Point;
	flow: 'in' | 'out' | 'both';
}

const EDITOR_CONTEXT_KEY = Symbol('editor');

export interface ClipboardNodeSnapshot {
	id: string;
	x: number;
	y: number;
	// The node's junction edits, naming the copied roads by their old ids.
	junction?: JunctionData;
}

export interface ClipboardSegmentSnapshot {
	id: string;
	startNodeId: string;
	endNodeId: string;
	controlX?: number;
	controlY?: number;
	offset: number;
	lanes: Lane[];
}

export interface SegmentClipboard {
	kind: 'segments';
	nodes: ClipboardNodeSnapshot[];
	segments: ClipboardSegmentSnapshot[];
}

// A node's junction edits with its roads named by their order round the
// node (`arm0`, `arm1`, …) and lanes by their place on the road, to paste
// onto another node with as many roads.
interface NodeClipboard {
	kind: 'node';
	arms: number;
	junction: JunctionData;
}

type EditorClipboard = SegmentClipboard | NodeClipboard;

// The hotbar belongs to the browser, not to a city: it survives reloads and
// switching cities. Read once when the editor is made; unreadable or missing
// data keeps the defaults.
const HOTBAR_KEY = 'citynista:hotbar';

function storedHotbar() {
	try {
		const raw = localStorage.getItem(HOTBAR_KEY);
		const stored: unknown = raw ? JSON.parse(raw) : null;
		return Array.isArray(stored) && stored.length === HOTBAR_SIZE
			? (stored as (Brush | null)[])
			: null;
	} catch {
		return null;
	}
}

export class Editor {
	graph = new Graph();
	private cityStore = new CityStore();
	// Reactive city-library state for the toolbar.
	cities = $state<CitySummary[]>([]);
	currentCityId = $state('');
	currentCityName = $state('');
	// Set while an example is open. Saving it asks for a name (saveAsOpen) and
	// creates a city of your own; the example file never changes. Duplicate
	// opens the same dialog for your own cities.
	currentExampleId = $state<string | null>(null);
	saveAsOpen = $state(false);
	// Edits live in memory until Save; dirty means the graph differs from what
	// was last saved or opened.
	dirty = $state(false);
	private savedState = '';
	// The open city's own view. ?topdown and screenshot cameras are fixed for
	// tests and never replace it in what gets saved.
	private cityCamera: CameraState | null = null;
	// Map-wide snapping grid (toggled from the toolbar). Drawing snaps to gridSize.
	gridEnabled = $state(false);
	readonly gridSize = GRID_SUB;
	sceneManager!: SceneManager;
	nodeRenderer!: NodeRenderer;
	// Roads and junctions, drawn from the road model (src/lib/lab).
	roadRenderer!: LabRenderer;
	// The connection overlay: every junction's lane-to-lane connections.
	showConnections = $state(false);
	selectionRenderer!: SelectionRenderer;
	taperRenderer!: HandleRenderer;
	// The selected road's lateral offset handle.
	offsetRenderer!: HandleRenderer;
	// In the connector, a handle on each crosswalk to slide it along its road.
	crossingRenderer!: HandleRenderer;
	currentOffsetHandle: OffsetHandle | null = null;
	connectionRenderer!: ConnectionRenderer;
	private currentTaperHandles: TaperHandleInfo[] = [];
	// The junction being edited in connector mode, and its current lane
	// connectivity overlay (dots + movement arcs).
	connectorNodeId: string | null = null;
	private currentConnectors: {
		endpoints: ConnectorEndpoint[];
		connections: LaneConnection[];
	} = { endpoints: [], connections: [] };
	// In the connector, each approach's control (stop, yield, signal or
	// none) where it is shown, to click through.
	controlBadges = $state<{ key: string; control: Control; x: number; y: number }[]>([]);

	mode = $state<Mode>('select');
	hotbar = $state<(Brush | null)[]>(storedHotbar() ?? defaultHotbar());
	activeSlot = $state(0);
	// A one-off brush from continuing an existing road's endpoint — overrides the
	// active hotbar slot until you leave draw mode or pick another brush.
	continuationBrush = $state<Brush | null>(null);
	activeBrush = $derived(this.continuationBrush ?? this.hotbar[this.activeSlot]);
	// How an armed preset lays roads: straight pieces, pieces that curve on
	// from the road they continue, or a ring. Kept across preset picks.
	drawStyle = $state<DrawStyle>('curve');
	private pendingDrawAnchor: string | null = null;
	// The roads a drawing mode would lay on the next click and their
	// drawing, while it shows them (read by ?model scripts).
	ghost: { graph: Graph; renderer: LabRenderer } | null = null;
	fps = $state(0);
	canUndo = $state(false);
	canRedo = $state(false);
	selectedNodes = new SvelteSet<string>();
	selectedSegments = new SvelteSet<string>();
	pendingPlacement: SegmentClipboard | null = null;
	// A single selected node that just passes through two same-section segments
	// can be dissolved back into one road; the toolbar offers it only then.
	joinableNodeId = $derived.by(() => {
		if (this.selectedNodes.size !== 1 || this.selectedSegments.size !== 0) return null;
		const nodeId = [...this.selectedNodes][0];
		return this.canJoinNode(nodeId) ? nodeId : null;
	});
	// The shared cross-section of a uniform segment selection — the config you
	// can drop into a hotbar slot to build with it. Null for empty or mixed.
	pickableLanes = $derived.by(() => {
		const segments = [...this.selectedSegments]
			.map((id) => this.graph.segments.get(id))
			.filter((segment) => segment !== undefined);
		if (segments.length === 0) return null;
		const key = segments[0].lanesKey;
		if (!segments.every((segment) => segment.lanesKey === key)) return null;
		return segments[0].lanes;
	});
	// What the lane panel edits: the selected roads' shared lanes ('mixed'
	// when they differ), else in draw mode the armed slot's (empty when the
	// slot is). Null when there is nothing to edit.
	laneSource = $derived.by(() => {
		if (this.selectedSegments.size > 0) {
			const lanes = this.pickableLanes;
			if (!lanes) return 'mixed' as const;
			return { lanes };
		}
		if (this.mode === 'draw' && !this.continuationBrush) {
			const brush = this.hotbar[this.activeSlot];
			return { lanes: brush?.lanes ?? [] };
		}
		return null;
	});
	// The panel row under the pointer, lit on every selected road.
	highlightedLane = $state<number | null>(null);
	// Draw mode only draws with lanes: an armed empty slot leaves the map inert.
	private drawing = $derived(this.mode === 'draw' && (this.activeBrush?.lanes.length ?? 0) > 0);

	private modeHandlers: ModeHandlers | null = null;
	private boundKeyDown: ((e: KeyboardEvent) => void) | null = null;
	private boundHistoryKeyDown: ((e: KeyboardEvent) => void) | null = null;
	private boundMouseUp: ((e: MouseEvent) => void) | null = null;
	private boundClipboardKeyDown: ((e: KeyboardEvent) => void) | null = null;
	private hoveredNodeId: string | null = null;
	private hoveredSegmentId: string | null = null;
	private clipboard: EditorClipboard | null = null;

	// Undo history as whole-graph snapshots, captured at the commit boundary:
	// every operation (a draw click, a finished drag, a lane tweak, a
	// delete) ends in graph.save(), so one commit equals one undo step with no
	// per-command bookkeeping. Nothing reaches storage until the user saves.
	private undoStack: string[] = [];
	private redoStack: string[] = [];
	private presentState = '';
	private restoringHistory = false;

	constructor() {
		// Track only the mode itself: setupMode reads selection state internally
		// and must not re-run when that state changes.
		$effect(() => {
			const mode = this.mode;
			void this.drawing;
			untrack(() => this.setupMode(mode));
		});
	}

	private initialized = false;

	// loadCurrent is false when the page is about to deep-link an ?example=, so we
	// don't create/touch an "untitled" city just to throw it away.
	async init(container: HTMLElement, loadCurrent = true) {
		if (this.initialized) return;
		this.initialized = true;

		this.sceneManager = new SceneManager(container, (fps) => {
			this.fps = fps;
		});
		const { scene, screenSized } = this.sceneManager;
		this.nodeRenderer = new NodeRenderer(scene, screenSized);
		this.roadRenderer = new LabRenderer(scene);
		scene.background = new THREE.Color(COLOURS.ground);
		this.selectionRenderer = new SelectionRenderer(scene, screenSized);
		this.taperRenderer = new HandleRenderer(scene, screenSized, 'taper');
		this.offsetRenderer = new HandleRenderer(scene, screenSized, 'offset');
		this.crossingRenderer = new HandleRenderer(scene, screenSized, 'crossing');
		this.connectionRenderer = new ConnectionRenderer(scene, screenSized);

		if (loadCurrent) this.loadSavedData();
		this.presentState = this.savedState = JSON.stringify(this.graph.toJSON());
		this.graph.onSaved = (serialized) => this.recordHistory(serialized);
		this.sceneManager.onCameraPersist = () => this.saveCameraToCache();
		this.gridEnabled = localStorage.getItem('citynista:grid') === '1';
		this.sceneManager.setGridVisible(this.gridEnabled);
		this.setupCanvasEvents();
		this.setupHistoryKeys();
		this.setupClipboardKeys();
		window.addEventListener('beforeunload', this.warnUnsaved);
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
		this.dirty = this.presentState !== this.savedState;
	}

	private warnUnsaved = (event: BeforeUnloadEvent) => {
		if (!this.dirty) return;
		event.preventDefault();
		event.returnValue = '';
	};

	// True when it's fine to leave the current graph: nothing unsaved, or the
	// user agreed to discard it.
	confirmDiscard() {
		return !this.dirty || window.confirm('Discard unsaved changes?');
	}

	undo() {
		const previous = this.undoStack.pop();
		if (previous === undefined) return;
		this.redoStack.push(this.presentState);
		this.restoreState(previous);
	}

	// Takes back the last edit with no trace in redo (a draw cancelled after
	// its first click cut a road).
	discardLastEdit() {
		const previous = this.undoStack.pop();
		if (previous !== undefined) this.restoreState(previous);
	}

	redo() {
		const next = this.redoStack.pop();
		if (next === undefined) return;
		this.undoStack.push(this.presentState);
		this.restoreState(next);
	}

	toggleConnections() {
		this.showConnections = !this.showConnections;
		this.roadRenderer.setShowConnections(this.showConnections);
	}

	toggleGrid() {
		this.gridEnabled = !this.gridEnabled;
		this.sceneManager.setGridVisible(this.gridEnabled);
		try {
			localStorage.setItem('citynista:grid', this.gridEnabled ? '1' : '0');
		} catch {
			// best-effort
		}
	}

	// Arms a slot, empty or not; the lane panel opens on it.
	activateSlot(index: number) {
		this.continuationBrush = null;
		this.activeSlot = index;
		this.armStyle();
	}

	// Enters the mode of the chosen draw style for the armed slot; an empty
	// slot goes to draw mode, where the lane panel fills it.
	private armStyle() {
		this.mode = this.drawStyle === 'circle' && this.hotbar[this.activeSlot] ? 'circle' : 'draw';
	}

	setDrawStyle(style: DrawStyle) {
		if (!this.activeBrush || style === this.drawStyle) return;
		this.drawStyle = style;
		const mode = style === 'circle' ? 'circle' : 'draw';
		// Straight and curve share draw mode, which reads the style on each
		// move: the pending road keeps its start and only its preview redraws.
		if (this.mode === mode) this.modeHandlers?.refresh?.();
		else this.mode = mode;
	}

	cycleDrawStyle() {
		const at = DRAW_STYLES.indexOf(this.drawStyle);
		this.setDrawStyle(DRAW_STYLES[(at + 1) % DRAW_STYLES.length]);
	}

	cycleBrush(direction: number) {
		const filled = this.hotbar.flatMap((brush, i) => (brush ? [i] : []));
		if (filled.length === 0) return;
		const at = filled.indexOf(this.activeSlot);
		const next =
			filled[((((at < 0 ? 0 : at) + direction) % filled.length) + filled.length) % filled.length];
		this.continuationBrush = null;
		this.activeSlot = next;
		this.armStyle();
	}

	// Continue an existing road from a dangling endpoint, building onward with the
	// same lane cross-section (reversed if the node is the segment's start, so the
	// road reads continuously whichever end you extend).
	continueFromNode(nodeId: string) {
		const node = this.graph.nodes.get(nodeId);
		if (!node || node.connectedSegments.length !== 1) return;
		const segment = this.graph.segments.get(node.connectedSegments[0]);
		if (!segment) return;
		const atEnd = segment.endNodeId === nodeId;
		this.continuationBrush = {
			name: 'Continue road',
			lanes: atEnd ? cloneLanes(segment.lanes) : reverseLanes(segment.lanes)
		};
		this.pendingDrawAnchor = nodeId;
		this.clearSelection();
		this.mode = 'draw';
	}

	// Consumed once by draw mode to anchor the first segment at a continued endpoint.
	takeDrawAnchor(): string | null {
		const anchor = this.pendingDrawAnchor;
		this.pendingDrawAnchor = null;
		return anchor;
	}

	// Drop a cross-section (the selected road's by default) into a slot and arm it.
	pickIntoSlot(index: number, lanes = this.pickableLanes) {
		if (!lanes) return;
		this.hotbar[index] = { name: 'Custom road', lanes: cloneLanes(lanes) };
		this.saveHotbar();
		this.continuationBrush = null;
		this.clearSelection();
		this.activeSlot = index;
		this.armStyle();
	}

	// The eyedropper: the road under the cursor replaces the armed slot, or
	// fills the first empty one when none is armed, and drawing starts with it.
	eyedrop() {
		const segment = this.hoveredSegmentId && this.graph.segments.get(this.hoveredSegmentId);
		if (!segment) return;
		const armed = this.mode === 'draw' && !this.continuationBrush;
		const index = armed ? this.activeSlot : this.hotbar.findIndex((brush) => !brush);
		if (index < 0) return;
		this.pickIntoSlot(index, segment.lanes);
	}

	// Applies one change to each target's own lane list: every selected road
	// (when they share a cross-section) or the armed slot. Lanes the change
	// adds get fresh ids on each road; lanes it keeps keep theirs, since
	// junction connections name them. live skips saving, for mid-drag edits.
	editLanes(change: (lanes: Lane[]) => void, live = false) {
		const source = this.laneSource;
		if (!source || source === 'mixed') return;
		if (this.selectedSegments.size > 0) {
			for (const id of this.selectedSegments) {
				const segment = this.graph.segments.get(id);
				if (!segment) continue;
				const before = [...segment.lanes];
				change(segment.lanes);
				for (const lane of segment.lanes) if (!before.includes(lane)) delete lane.id;
				segment.ensureLaneIds();
			}
			this.rebuildRoads();
			this.refreshSelectionVisuals();
			if (!live) this.graph.save();
		} else {
			const brush = this.hotbar[this.activeSlot] ?? { name: 'Custom road', lanes: [] };
			change(brush.lanes);
			this.hotbar[this.activeSlot] = brush.lanes.length > 0 ? brush : null;
			if (!live) this.saveHotbar();
		}
	}

	// Closes the lane panel: drops the selection, or leaves draw mode.
	closeLanes() {
		if (this.selectedSegments.size > 0) this.clearSelection();
		else this.mode = 'select';
	}

	highlightLane(index: number | null) {
		if (this.highlightedLane === index) return;
		this.highlightedLane = index;
		this.refreshSelectionVisuals();
	}

	// Empty a slot. Drawing falls back to select if it held the active brush.
	clearSlot(index: number) {
		if (!this.hotbar[index]) return;
		this.hotbar[index] = null;
		this.saveHotbar();
		if (this.activeSlot === index) this.mode = 'select';
	}

	private saveHotbar() {
		try {
			localStorage.setItem(HOTBAR_KEY, JSON.stringify(this.hotbar));
		} catch {
			// best-effort
		}
	}

	private restoreState(serialized: string) {
		this.restoringHistory = true;
		this.presentState = serialized;
		// Mode-local state (a pending segment, a drag) may reference graph
		// objects that no longer exist; reinstalling the mode resets it.
		this.setupMode(this.mode);
		this.replaceGraph(JSON.parse(serialized), true, true);
		// setupMode rebuilt the connector overlay against the pre-undo graph;
		// refresh it now that the restored graph is in place.
		if (this.mode === 'connector') this.refreshConnectors();
		this.restoringHistory = false;
		this.canUndo = this.undoStack.length > 0;
		this.canRedo = this.redoStack.length > 0;
		this.dirty = this.presentState !== this.savedState;
	}

	private setupHistoryKeys() {
		this.boundHistoryKeyDown = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey)) return;
			// ⌘S saves from anywhere, panel inputs included.
			if (e.key.toLowerCase() === 's') {
				e.preventDefault();
				this.save();
				return;
			}
			if (e.key.toLowerCase() !== 'z') return;
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
			// I, the eyedropper, copies the road under the cursor into a slot.
			if (e.key.toLowerCase() === 'i' && !e.metaKey && !e.ctrlKey && !e.altKey) {
				const target = e.target;
				if (target instanceof HTMLElement && target.tagName !== 'BODY') return;
				this.eyedrop();
				return;
			}
			if (!(e.metaKey || e.ctrlKey)) return;
			const key = e.key.toLowerCase();
			if (key !== 'c' && key !== 'v' && key !== 'x') return;
			const target = e.target;
			if (target instanceof HTMLElement && target.tagName !== 'BODY') return;
			e.preventDefault();
			if (key === 'c') {
				this.copySelection();
			} else if (key === 'x') {
				this.cutSelection();
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

	// Cut is copy-then-delete, scoped to segment geometry (the only thing placement
	// can recreate). One undo step — the deletion; the later paste/place is its own.
	private cutSelection() {
		if (this.selectedSegments.size === 0) return;
		if (!this.copySelectedSegments()) return;
		this.deleteSelected();
	}

	private copySelectedSegments() {
		if (this.selectedSegments.size === 0) return false;

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
					junction: node.junction ? $state.snapshot(node.junction) : undefined
				});
			}

			segments.push({
				id: segment.id,
				startNodeId: segment.startNodeId,
				endNodeId: segment.endNodeId,
				controlX: segment.controlX,
				controlY: segment.controlY,
				offset: segment.offset,
				lanes: cloneLanes(segment.lanes)
			});
		}

		if (segments.length === 0) return false;
		this.clipboard = {
			kind: 'segments',
			nodes: [...nodes.values()],
			segments
		};
		return true;
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

	private copySelectedNodeConnections() {
		const node = this.graph.nodes.get([...this.selectedNodes][0]);
		if (!node?.junction) return;
		const arms = this.sortedNodeArms(node.id);
		const junction = mapJunction(
			node.junction,
			(road, end) => {
				const index = arms.findIndex((a) => a.segmentId === road);
				return index < 0 ? null : { road: `arm${index}`, end };
			},
			(road, lane) => {
				const index = this.graph.segments.get(road)?.lanes.findIndex((l) => l.id === lane) ?? -1;
				return index < 0 ? null : String(index);
			}
		);
		if (junction) this.clipboard = { kind: 'node', arms: arms.length, junction };
	}

	private paste() {
		const clipboard = this.clipboard;
		if (!clipboard) return;

		if (clipboard.kind === 'node') {
			if (this.selectedNodes.size === 1 && this.selectedSegments.size === 0) {
				this.pasteNodeConnections(clipboard);
			}
			return;
		}

		// Lane paste only when the selection includes a segment OTHER than the one
		// just copied — pasting onto (only) the source means "make a floating copy".
		const copiedIds = clipboard.segments.map((segment) => segment.id);
		const ontoOtherSegments = [...this.selectedSegments].some((id) => !copiedIds.includes(id));
		if (ontoOtherSegments) {
			this.pasteLanesToSelectedSegments(clipboard);
			return;
		}

		this.startPlacement(clipboard);
	}

	private startPlacement(clipboard: SegmentClipboard) {
		this.pendingPlacement = clipboard;
		if (this.mode === 'place') {
			this.setupMode('place');
		} else {
			this.mode = 'place';
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

	private pasteNodeConnections(clipboard: NodeClipboard) {
		const nodeId = [...this.selectedNodes][0];
		const node = this.graph.nodes.get(nodeId);
		if (!node) return;

		const arms = this.sortedNodeArms(node.id);
		if (arms.length !== clipboard.arms) return;
		const segmentOf = (road: string) =>
			this.graph.segments.get(arms[Number(road.slice(3))]?.segmentId ?? '');
		node.junction = mapJunction(
			clipboard.junction,
			(road) => {
				const segment = segmentOf(road);
				if (!segment) return null;
				return { road: segment.id, end: segment.startNodeId === node.id ? 'start' : 'end' };
			},
			(road, lane) => segmentOf(road)?.lanes[Number(lane)]?.id ?? null
		);
		this.rebuildRoads();
		this.graph.save();
	}

	private loadSavedData() {
		const city = this.cityStore.ensureCurrent();
		this.currentCityId = city.id;
		this.currentCityName = city.name;
		this.cityCamera = this.readCameraCache(city.id) ?? city.camera;
		this.cities = this.cityStore.list();
		this.graph.fromJSON(this.workingGraph(city));
		for (const node of this.graph.nodes.values()) {
			this.nodeRenderer.createNode(node);
		}
		this.rebuildRoads();
	}

	// The saved graph is the legacy single-graph slot (written on every save and
	// city switch); the current city's snapshot is the fallback. Reading the legacy slot
	// first lets external writers (and the e2e harness) seed a graph before boot.
	private workingGraph(city: CityRecord): GraphData {
		try {
			const raw = localStorage.getItem('citynista-graph-v2');
			if (raw) return JSON.parse(raw) as GraphData;
		} catch {
			// fall through to the city snapshot
		}
		return city.graph;
	}

	// Apply the saved camera for the current city. The page calls this only on the
	// normal path; ?example= and ?topdown manage the camera themselves, so a
	// city's view never leaks into a deterministic test render.
	restoreCityCamera() {
		if (this.cityCamera) this.sceneManager.setCameraState(this.cityCamera);
	}

	// Save the current graph: over your own city, or, for an example, into a
	// new city named in the save-as dialog.
	save() {
		if (this.currentExampleId) {
			this.saveAsOpen = true;
			return;
		}
		if (!this.currentCityId) return;
		const graph = this.graph.toJSON();
		this.cityStore.save({
			id: this.currentCityId,
			name: this.currentCityName,
			graph,
			camera: this.cameraForSave()
		});
		this.markSaved(graph);
	}

	saveAs(name: string) {
		this.saveAsOpen = false;
		const graph = this.graph.toJSON();
		const city = this.cityStore.create(name, graph, this.cameraForSave());
		this.cityStore.setCurrentId(city.id);
		this.currentExampleId = null;
		this.currentCityId = city.id;
		this.currentCityName = city.name;
		this.cities = this.cityStore.list();
		this.markSaved(graph);
	}

	private markSaved(graph: GraphData) {
		this.writeMirror(graph);
		this.saveCameraToCache();
		this.savedState = this.presentState;
		this.dirty = false;
	}

	// Camera-only changes (panning, zooming) persist to a localStorage cache, not
	// the city record, which only refreshes its camera when the graph is saved.
	private cameraForSave() {
		if (this.sceneManager && !this.sceneManager.isDeterministicCamera()) {
			this.cityCamera = this.sceneManager.getCameraState();
		}
		return this.cityCamera;
	}

	private saveCameraToCache() {
		if (!this.currentCityId || !this.sceneManager) return;
		if (this.sceneManager.isDeterministicCamera()) return;
		try {
			localStorage.setItem(
				`citynista:cam:${this.currentCityId}`,
				JSON.stringify(this.sceneManager.getCameraState())
			);
		} catch {
			// best-effort
		}
	}

	private readCameraCache(id: string): CameraState | null {
		try {
			const raw = localStorage.getItem(`citynista:cam:${id}`);
			return raw ? (JSON.parse(raw) as CameraState) : null;
		} catch {
			return null;
		}
	}

	// Back-compat mirror of the current city's saved graph — the single-graph
	// slot the e2e suite, any legacy reader, and boot's workingGraph() still read.
	private writeMirror(graph: GraphData) {
		try {
			localStorage.setItem('citynista-graph-v2', JSON.stringify(graph));
		} catch {
			// best-effort
		}
	}

	private clearHistory() {
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.presentState = this.savedState = JSON.stringify(this.graph.toJSON());
		this.canUndo = false;
		this.canRedo = false;
		this.dirty = false;
	}

	// Load a city into view without writing anything back.
	private openCity(city: CityRecord) {
		this.cityStore.setCurrentId(city.id);
		this.currentExampleId = null;
		this.currentCityId = city.id;
		this.currentCityName = city.name;
		this.showCity(city, this.readCameraCache(city.id) ?? city.camera);
		this.writeMirror(city.graph);
	}

	private showCity(city: CityRecord, camera: CameraState | null) {
		this.cityCamera = camera;
		// In ?topdown / screenshot mode the camera is fixed deterministically — don't
		// clobber it with the city's saved view (or the e2e screen coords drift).
		if (!this.sceneManager.isDeterministicCamera()) {
			if (camera) this.sceneManager.setCameraState(camera);
			else this.sceneManager.resetCamera();
		}
		this.replaceGraph(city.graph, false);
		this.clearHistory();
		this.cities = this.cityStore.list();
	}

	// Always the original file, and nothing is stored until Save. The current-city
	// pointer stays on your last own city, so a reload lands there.
	async openExample(id: string) {
		const example = await loadExample(id);
		if (!example) return;
		this.currentExampleId = id;
		this.currentCityId = '';
		this.currentCityName = example.name;
		this.showCity(example, example.camera);
	}

	// Writes the new name straight to storage without saving pending map edits,
	// and is not an undo step. Examples are read-only and keep their name.
	renameCity(name: string) {
		const trimmed = name.trim();
		if (!trimmed || this.currentExampleId || !this.currentCityId) return;
		this.cityStore.rename(this.currentCityId, trimmed);
		this.currentCityName = trimmed;
		this.cities = this.cityStore.list();
	}

	newCity(name: string) {
		this.openCity(this.cityStore.create(name));
	}

	loadCityById(id: string) {
		if (id === this.currentCityId) return;
		const stored = this.cityStore.load(id);
		if (stored) this.openCity(stored);
	}

	deleteCurrentCity() {
		if (!this.currentCityId) return;
		this.cityStore.remove(this.currentCityId);
		const remaining = this.cityStore.list();
		const next = remaining.length > 0 ? this.cityStore.load(remaining[0].id) : null;
		if (next) this.openCity(next);
		else this.newCity('untitled');
	}

	// One drag frame for profiling (?stats): the busiest junction nudged half
	// a metre (back again on the next call), or (`unchanged`) a rebuild with
	// nothing changed.
	private perfStep = 0.5;
	perfMove(what: string) {
		const busiest = [...this.graph.nodes.values()].reduce((a, b) =>
			b.connectedSegments.length > a.connectedSegments.length ? b : a
		);
		if (what !== 'unchanged') {
			busiest.x += this.perfStep;
			this.perfStep = -this.perfStep;
		}
		this.rebuildRoads();
	}

	// Render costs for perf runs (?stats): scene size, draw calls, CPU time per
	// frame submission, and the time of a full road rebuild and of an update
	// where nothing changed.
	renderStats() {
		const { scene, camera, renderer } = this.sceneManager;
		let meshes = 0;
		let triangles = 0;
		scene.traverse((object) => {
			if (!(object instanceof THREE.Mesh) || !object.visible) return;
			meshes++;
			const index = object.geometry.index;
			triangles +=
				(index ? index.count : (object.geometry.getAttribute('position')?.count ?? 0)) / 3;
		});
		let t = performance.now();
		for (let i = 0; i < 20; i++) renderer.render(scene, camera);
		const renderMs = (performance.now() - t) / 20;
		const calls = renderer.info.render.calls;
		t = performance.now();
		this.rebuildRoads();
		const unchangedUpdateMs = performance.now() - t;
		// One junction nudged half a metre: what a drag frame costs.
		const busiest = [...this.graph.nodes.values()].reduce((a, b) =>
			b.connectedSegments.length > a.connectedSegments.length ? b : a
		);
		busiest.x += 0.5;
		t = performance.now();
		this.rebuildRoads();
		const oneNodeMovedMs = performance.now() - t;
		busiest.x -= 0.5;
		this.rebuildRoads();
		t = performance.now();
		this.roadRenderer.update(this.graph);
		const roadsOnlyUpdateMs = performance.now() - t;
		this.roadRenderer.clear();
		t = performance.now();
		this.rebuildRoads();
		const fullRebuildMs = performance.now() - t;
		return {
			meshes,
			triangles: Math.round(triangles),
			calls,
			renderMs,
			unchangedUpdateMs,
			roadsOnlyUpdateMs,
			oneNodeMovedMs,
			fullRebuildMs
		};
	}

	rebuildRoads() {
		this.roadRenderer.update(this.graph);
		this.refreshTaperHandles();
		this.refreshOffsetHandle();
		for (const node of this.graph.nodes.values()) {
			this.nodeRenderer.setPosition(node.id, nodePoint(this.graph, node));
		}
	}

	// A node ring's radius in world units at the current zoom: a fixed size on
	// screen. The modes use it as the node's hit and snap radius, so the ring
	// you see is the area you click.
	nodeRingRadius() {
		return NODE_RING_PX * this.sceneManager.worldPerPixel();
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
		// A press that starts on the canvas ends wherever the button comes up:
		// over the toolbar, or over the lane panel that the press itself opened.
		// Listening on the window keeps the mode from being left mid-drag.
		let pressedOnCanvas = false;
		canvas.addEventListener('mousedown', (e) => {
			if (this.sceneManager.isCameraPanning()) return;
			pressedOnCanvas = true;
			this.modeHandlers?.onMouseDown?.(e);
		});
		canvas.addEventListener('mousemove', (e) => {
			if (this.sceneManager.isCameraPanning()) return;
			this.modeHandlers?.onMouseMove?.(e);
		});
		this.boundMouseUp = (e: MouseEvent) => {
			if (!pressedOnCanvas) return;
			pressedOnCanvas = false;
			this.modeHandlers?.onMouseUp?.(e);
		};
		window.addEventListener('mouseup', this.boundMouseUp);
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
		if (mode !== 'place') this.pendingPlacement = null;
		// A continued road can be laid as a ring too, so circle keeps its brush.
		if (mode !== 'draw' && mode !== 'circle') this.continuationBrush = null;
		// Draw mode is never the circle style (an empty slot armed, a road
		// continued from its end), and circle mode always is.
		if (mode === 'draw' && this.drawStyle === 'circle') this.drawStyle = 'curve';
		if (mode === 'circle') this.drawStyle = 'circle';
		this.modeHandlers = null;

		if (mode === 'draw') {
			this.modeHandlers = this.drawing ? setupDrawMode(this) : null;
		} else if (mode === 'circle') {
			this.modeHandlers = setupCircleMode(this);
		} else if (mode === 'bulldoze') {
			this.modeHandlers = setupBulldozeMode(this);
		} else if (mode === 'split') {
			this.modeHandlers = setupSplitMode(this);
		} else if (mode === 'connector') {
			this.modeHandlers = setupConnectorMode(this);
		} else if (mode === 'place') {
			this.modeHandlers = setupPlaceMode(this);
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
		this.refreshTaperHandles();
	}

	deselectNode(nodeId: string) {
		this.selectedNodes.delete(nodeId);
		this.nodeRenderer.setSelected(nodeId, false);
		this.refreshRevealedNodes();
		this.refreshTaperHandles();
	}

	// Taper handles on a single selected node where only two roads meet: an
	// arrow on each road where the transition between them ends. Dragging either
	// sets the transition's length.
	refreshTaperHandles() {
		const nodeId = this.selectedNodes.size === 1 ? [...this.selectedNodes][0] : null;
		const node = nodeId ? this.graph.nodes.get(nodeId) : undefined;
		if (!node || node.connectedSegments.length !== 2 || !this.roadRenderer?.derived) {
			this.currentTaperHandles = [];
			this.taperRenderer?.clear();
			return;
		}
		const rich: TaperHandleInfo[] = [];
		for (const segmentId of node.connectedSegments) {
			const segment = this.graph.segments.get(segmentId);
			const span = this.roadRenderer.derived?.spans.get(segmentId);
			if (!segment || !span) continue;
			const atStart = segment.startNodeId === node.id;
			// Along the road as it shows (offset and all), from the node out.
			let centerline: Point[] = roadLine(this.graph, segment);
			if (!atStart) centerline = [...centerline].reverse();
			const trim = atStart ? span.d0 : span.total - span.d0 - span.length;
			// Where the taper ends, but never on the node itself.
			const reach = Math.max(trim, TAPER_HANDLE_REACH);
			rich.push({
				index: rich.length,
				nodeId: node.id,
				segmentId,
				atStart,
				node: centerline[0],
				handle: pointAlong(centerline, reach),
				dir: directionAlong(centerline, reach),
				centerline
			});
		}
		this.currentTaperHandles = rich;
		this.taperRenderer.show(rich.map((h) => ({ at: h.handle, dir: h.dir })));
	}

	taperHandleAt(worldX: number, worldZ: number): TaperHandleInfo | null {
		const scale = this.sceneManager.worldPerPixel();
		let best: TaperHandleInfo | null = null;
		let bestDistance = Infinity;
		for (const handle of this.currentTaperHandles) {
			if (!hitsHandle(TAPER_HANDLE, handle.handle, handle.dir, worldX, worldZ, scale)) continue;
			const distance = Math.hypot(handle.handle.x - worldX, handle.handle.y - worldZ);
			// Nearer the node than the handle: that's the node.
			const toNode = Math.hypot(handle.node.x - worldX, handle.node.y - worldZ);
			if (toNode < distance) continue;
			if (distance < bestDistance) {
				bestDistance = distance;
				best = handle;
			}
		}
		return best;
	}

	// While dragging a taper handle: the transition reaches as far along the
	// road from the node as the pointer, on both sides.
	setTaperFromDrag(handle: TaperHandleInfo, worldX: number, worldZ: number) {
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
			const distance = Math.hypot(ax + dx * t - worldX, ay + dy * t - worldZ);
			if (distance < bestDistance) {
				bestDistance = distance;
				bestArc = accumulated + t * Math.sqrt(lengthSq);
			}
			accumulated += Math.sqrt(lengthSq);
		}
		const node = this.graph.nodes.get(handle.nodeId);
		if (!node) return;
		// Within the taper's limits: no steeper than the lanes' shift allows,
		// and never into the far node's setback.
		const limits = this.roadRenderer.taperLimits(node.id);
		const taper = Math.min(limits?.max ?? Infinity, Math.max(limits?.min ?? 0, bestArc * 2));
		node.junction = { ...(node.junction ?? { connections: [] }), taper };
		this.rebuildRoads();
		this.refreshTaperHandles();
	}

	finishTaper() {
		this.graph.save();
	}

	// Connector mode edits which movements a junction allows. Entry is a
	// double-click on a junction (3+ arms): the overlay shows a dot at each
	// lane mouth (a disc incoming, a ring outgoing) and an arc per movement;
	// toggling a movement recarves the junction pavement and persists.
	enterConnectorMode(nodeId: string) {
		const node = this.graph.nodes.get(nodeId);
		if (!node || node.connectedSegments.length < 2) return;
		this.clearSelection();
		// The node's taper, and with it every lane dot, holds still while its
		// connections are edited; it settles when the connector closes.
		this.roadRenderer.holdTaper(nodeId);
		this.connectorNodeId = nodeId;
		this.mode = 'connector';
	}

	exitConnectorMode() {
		this.connectorNodeId = null;
		this.controlBadges = [];
		this.crossingRenderer.clear();
		this.roadRenderer.holdTaper(null);
		this.rebuildRoads();
		this.mode = 'select';
	}

	// The road ends at the connector's node, as the drawing reads them.
	private connectorEnds(): EndInfo[] {
		const id = this.connectorNodeId;
		const junction = id ? this.roadRenderer.derived?.junctions.get(id) : undefined;
		const scene = this.roadRenderer.scene;
		return junction && scene ? endsOf(junction, scene.geos) : [];
	}

	// Lane dots and the connections between them. Where only two roads meet,
	// every lane shows; at a junction of more, the travel lanes (its sidewalks
	// are its corners and crosswalks).
	refreshConnectors() {
		const id = this.connectorNodeId;
		const junction = id ? this.roadRenderer.derived?.junctions.get(id) : undefined;
		const ends = this.connectorEnds();
		const draw = id ? this.roadRenderer.scene?.junctionDraw(id) : undefined;
		this.controlBadges = (draw?.badges ?? []).map((b) => ({
			key: b.key,
			control: b.control,
			x: b.p.x,
			y: b.p.y
		}));
		if (!junction || ends.length === 0) {
			this.currentConnectors = { endpoints: [], connections: [] };
			this.connectionRenderer.clear();
			this.crossingRenderer.clear();
			return;
		}
		const link = ends.length === 2;
		// Where two road ends nearly meet, their dots spread apart along the
		// roads so every lane's dot can be told apart and aimed at.
		const gap = link
			? Math.hypot(ends[0].frame.p.x - ends[1].frame.p.x, ends[0].frame.p.y - ends[1].frame.p.y)
			: Infinity;
		const spread = Math.max(0, (CONNECTOR_SPREAD - gap) / 2);
		const endpoints: ConnectorEndpoint[] = [];
		for (const end of ends) {
			const segment = this.graph.segments.get(end.ref.road);
			if (!segment) continue;
			for (const l of end.lanes) {
				const travel = isTravel(l.lane);
				if (!travel && !link) continue;
				if (!travel && l.lane.kind !== 'walk' && l.lane.kind !== 'buffer') continue;
				const laneIndex = segment.lanes.findIndex((x) => x.id === l.ref.lane);
				if (laneIndex < 0) continue;
				endpoints.push({
					ref: { segmentId: end.ref.road, laneIndex },
					lane: l.ref,
					kind: kindOf(l.lane),
					point: {
						x: l.point.x + end.frame.out.x * spread,
						y: l.point.y + end.frame.out.y * spread
					},
					dir: { x: -end.frame.out.x, y: -end.frame.out.y },
					flow: !travel ? 'both' : l.flow === 'in' ? 'in' : 'out'
				});
			}
		}
		const find = (r: ModelLaneRef) =>
			endpoints.find((e) => endKey(e.lane) === endKey(r) && e.lane.lane === r.lane);
		const connections: LaneConnection[] = [];
		for (const c of junction.connections) {
			const from = find(c.from);
			const to = find(c.to);
			if (!from || !to) continue;
			connections.push({
				from: from.ref,
				to: to.ref,
				fromPoint: from.point,
				toPoint: to.point,
				fromDir: from.dir,
				toDir: { x: -to.dir.x, y: -to.dir.y },
				active: true
			});
		}
		this.currentConnectors = { endpoints, connections };
		this.connectionRenderer.show(connections, endpoints);
		// Each crossing: its handle across the road, on a straight line from
		// sidewalk to sidewalk while it is on.
		this.crossingRenderer.show(
			this.connectorCrossings().map((c) => ({
				at: c.mid,
				dir: c.dir,
				stem: c.crossing.on ? ([c.from, c.to] as [Point, Point]) : undefined,
				hollow: !c.crossing.on
			}))
		);
	}

	// The lane dot nearest the cursor, either flow — used for hover feedback and
	// for picking both ends of a connector drag (direction-agnostic).
	connectorEndpointNear(worldX: number, worldZ: number): ConnectorEndpoint | null {
		const threshold = (LANE_DOT_PX + HANDLE_HIT_SLACK_PX) * this.sceneManager.worldPerPixel();
		let best: ConnectorEndpoint | null = null;
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

	// Whether a drag from one lane dot to another makes (or unmakes) a
	// connection: same kind, different road ends, and for travel lanes from
	// where traffic comes in to where it leaves.
	canConnect(from: ConnectorEndpoint, to: ConnectorEndpoint) {
		// Two sidewalks of one road end: a crosswalk across that road.
		if (this.crossingPair(from, to)) return true;
		if (from.kind !== to.kind || endKey(from.lane) === endKey(to.lane)) return false;
		if (from.flow === 'both' || to.flow === 'both') return from.flow === to.flow;
		return from.flow === 'in' && to.flow === 'out';
	}

	// Adds the connection between two lane dots, or removes it if it is there.
	// The node keeps the edit (an addition or a removal against the defaults)
	// for as long as both lanes exist.
	toggleConnection(from: ConnectorEndpoint, to: ConnectorEndpoint) {
		if (!this.canConnect(from, to)) return;
		if (this.crossingPair(from, to)) {
			this.toggleCrossing(from, to);
			return;
		}
		this.editConnections([{ from: from.lane, to: to.lane }]);
	}

	// Two different sidewalks at the same road end.
	private crossingPair(a: ConnectorEndpoint, b: ConnectorEndpoint) {
		return (
			a.kind === 'walk' &&
			b.kind === 'walk' &&
			endKey(a.lane) === endKey(b.lane) &&
			a.lane.lane !== b.lane.lane
		);
	}

	// A crossing between two sidewalks of one road end: switched off if it is
	// on, on if it is off; one that isn't there yet is added a little way
	// past the node.
	private toggleCrossing(a: ConnectorEndpoint, b: ConnectorEndpoint) {
		const lanes: [string, string] = [a.lane.lane, b.lane.lane];
		const existing = this.connectorCrossings().find(
			(c) =>
				c.crossing.road === a.lane.road &&
				c.crossing.end === a.lane.end &&
				c.crossing.lanes.every((l) => lanes.includes(l))
		);
		if (existing) {
			this.switchCrossing(existing.index);
			return;
		}
		const span = this.roadRenderer.derived?.spans.get(a.lane.road);
		if (!span) return;
		const place = a.lane.end === 'start' ? NEW_CROSSING_BEYOND : span.length - NEW_CROSSING_BEYOND;
		this.storeCrossing(
			{ road: a.lane.road, end: a.lane.end, lanes },
			{ at: crossingAt(a.lane.end, place, span), on: true }
		);
		this.graph.save();
	}

	// Writes a crossing's stored edit on the connector's node: a default one
	// moved or switched, or one added by hand.
	private storeCrossing(c: JunctionCrossing, patch: Partial<JunctionCrossing>) {
		const node = this.connectorNodeId ? this.graph.nodes.get(this.connectorNodeId) : null;
		if (!node) return;
		const stored = node.junction?.crossings ?? [];
		const same = (x: JunctionCrossing) =>
			x.road === c.road && x.end === c.end && x.lanes.every((l) => c.lanes.includes(l));
		const next = stored.some(same)
			? stored.map((x) => (same(x) ? { ...x, ...patch } : x))
			: [...stored, { road: c.road, end: c.end, lanes: c.lanes, ...patch }];
		node.junction = { ...(node.junction ?? { connections: [] }), crossings: next };
		this.rebuildRoads();
		this.refreshConnectors();
	}

	// The connector node's crossings, on and off, each straight across its
	// road with a handle in the middle to slide it along the road.
	private connectorCrossings() {
		const id = this.connectorNodeId;
		const list = id ? this.roadRenderer.derived?.crossings.get(id) : undefined;
		const geos = this.roadRenderer.scene?.geos;
		if (!list || !geos) return [];
		return list.flatMap((c, index) => {
			const geo = geos.get(c.road);
			if (!geo || c.place === undefined) return [];
			const f = frameAt(geo.path, c.place);
			const spans = crossSection(geo.road, c.place);
			const sides = c.lanes.map((lane) => spans.find((sp) => sp.lane.id === lane));
			if (!sides[0] || !sides[1]) return [];
			const [p, q] = sides.map((sp) => offsetPoint(f.p, f.n, (sp!.left + sp!.right) / 2));
			const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
			const l = Math.hypot(q.x - p.x, q.y - p.y) || 1;
			const dir = { x: (q.x - p.x) / l, y: (q.y - p.y) / l };
			return [{ index, crossing: c, from: p, to: q, mid, dir }];
		});
	}

	// The crossing whose handle is under the pointer, with its place among
	// the handles shown (`shown`).
	crossingHandleAt(worldX: number, worldZ: number) {
		const scale = this.sceneManager.worldPerPixel();
		const list = this.connectorCrossings();
		const shown = list.findIndex((c) =>
			hitsHandle(CROSSING_HANDLE, c.mid, c.dir, worldX, worldZ, scale)
		);
		return shown < 0 ? null : { ...list[shown], shown };
	}

	// Slides a crossing along its road to where the pointer is: never past
	// either end of the road, nor onto another crossing on it.
	moveCrossing(index: number, worldX: number, worldZ: number) {
		const c = this.connectorCrossings().find((x) => x.index === index)?.crossing;
		const geo = c && this.roadRenderer.scene?.geos.get(c.road);
		const span = c && this.roadRenderer.derived?.spans.get(c.road);
		if (!c || !geo || !span || c.place === undefined) return;
		const lo = CROSSING_FROM_END;
		const hi = span.length - CROSSING_FROM_END;
		let place = Math.max(lo, Math.min(hi, project(geo.path, { x: worldX, y: worldZ }).s));
		// Other crossings on the road block the way from where it is now.
		const gap = CROSSING_DEPTH + 1;
		for (const other of geo.road.crossings ?? []) {
			if (Math.abs(other.at - c.place) < 1e-6) continue;
			if (other.at > c.place) place = Math.min(place, other.at - gap);
			else place = Math.max(place, other.at + gap);
		}
		this.storeCrossing(c, { at: crossingAt(c.end, place, span) });
	}

	// Switches a crossing off, or back on; one added by hand goes when
	// switched off.
	switchCrossing(index: number) {
		const node = this.connectorNodeId ? this.graph.nodes.get(this.connectorNodeId) : null;
		const c = this.connectorCrossings().find((x) => x.index === index)?.crossing;
		if (!node || !c) return;
		if (!c.auto && c.on) {
			const same = (x: JunctionCrossing) =>
				x.road === c.road && x.end === c.end && x.lanes.every((l) => c.lanes.includes(l));
			const crossings = (node.junction?.crossings ?? []).filter((x) => !same(x));
			node.junction = { ...(node.junction ?? { connections: [] }), crossings };
			this.rebuildRoads();
			this.refreshConnectors();
		} else this.storeCrossing(c, { on: !c.on });
		this.graph.save();
	}

	// Steps an approach's control on: none, stop, yield, signal, and round.
	cycleControl(key: string) {
		const node = this.connectorNodeId ? this.graph.nodes.get(this.connectorNodeId) : null;
		const current = this.controlBadges.find((b) => b.key === key)?.control;
		if (!node || !current) return;
		const order: Control[] = ['none', 'stop', 'yield', 'signal'];
		const next = order[(order.indexOf(current) + 1) % order.length];
		node.junction = {
			...(node.junction ?? { connections: [] }),
			control: { ...(node.junction?.control ?? {}), [key]: next }
		};
		this.rebuildRoads();
		this.graph.save();
		this.refreshConnectors();
	}

	// Double-clicking a lane dot removes every connection it has.
	toggleAllConnections(endpoint: ConnectorEndpoint) {
		const junction = this.connectorNodeId
			? this.roadRenderer.derived?.junctions.get(this.connectorNodeId)
			: undefined;
		const hit = (r: ModelLaneRef) =>
			endKey(r) === endKey(endpoint.lane) && r.lane === endpoint.lane.lane;
		const mine = (junction?.connections ?? []).filter((c) => hit(c.from) || hit(c.to));
		if (mine.length) this.editConnections(mine);
	}

	private editConnections(toggles: { from: ModelLaneRef; to: ModelLaneRef }[]) {
		const node = this.connectorNodeId ? this.graph.nodes.get(this.connectorNodeId) : null;
		const junction = node ? this.roadRenderer.derived?.junctions.get(node.id) : undefined;
		if (!node || !junction) return;
		const key = (r: ModelLaneRef) => `${endKey(r)}/${r.lane}`;
		const same = (
			x: { from: ModelLaneRef; to: ModelLaneRef },
			y: { from: ModelLaneRef; to: ModelLaneRef }
		) =>
			(key(x.from) === key(y.from) && key(x.to) === key(y.to)) ||
			(key(x.from) === key(y.to) && key(x.to) === key(y.from));
		const copy = (c: { from: ModelLaneRef; to: ModelLaneRef }) => ({
			from: { ...c.from },
			to: { ...c.to }
		});
		let added = (node.junction?.added ?? []).map(copy);
		let removed = (node.junction?.removed ?? []).map(copy);
		for (const t of toggles) {
			const present = junction.connections.some((c) => same(c, t));
			if (present) {
				if (added.some((c) => same(c, t))) added = added.filter((c) => !same(c, t));
				else removed.push(copy(t));
			} else if (removed.some((c) => same(c, t))) removed = removed.filter((c) => !same(c, t));
			else added.push(copy(t));
		}
		node.junction = {
			...(node.junction ?? { connections: [] }),
			added,
			removed
		};
		this.rebuildRoads();
		this.graph.save();
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
		this.refreshOffsetHandle();
	}

	clearSelection() {
		this.highlightedLane = null;
		this.nodeRenderer.clearSelection();
		this.selectionRenderer.clear();
		this.selectedNodes.clear();
		this.selectedSegments.clear();
		this.refreshRevealedNodes();
		this.currentTaperHandles = [];
		this.taperRenderer.clear();
		this.currentOffsetHandle = null;
		this.offsetRenderer?.clear();
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
		const ends = segment && segmentEnds(this.graph, segment);

		if (segment && startNode && endNode && ends) {
			this.selectionRenderer.showHover(segment, ends.a, ends.b, this.mode === 'bulldoze');
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

	refreshOffsetHandle() {
		this.currentOffsetHandle = this.sceneManager ? offsetHandle(this) : null;
		const h = this.currentOffsetHandle;
		if (h) this.offsetRenderer?.show([{ at: h.point, dir: h.normal }]);
		else this.offsetRenderer?.clear();
	}

	offsetHandleAt(worldX: number, worldZ: number) {
		const h = this.currentOffsetHandle;
		const scale = this.sceneManager.worldPerPixel();
		return h && hitsHandle(OFFSET_HANDLE, h.point, h.normal, worldX, worldZ, scale) ? h : null;
	}

	// Tints one handle for its state (the one under the pointer, or in hand)
	// and every other back to rest; null for none.
	lightHandle(ref: HandleRef | null, state: HandleState = 'hover') {
		const at = (kind: HandleRef['kind']) =>
			ref?.kind === kind && 'index' in ref ? ref.index : null;
		this.selectionRenderer?.lightControl(ref?.kind === 'curve' ? ref.segmentId : null, state);
		this.taperRenderer?.light(at('taper'), state);
		this.offsetRenderer?.light(at('offset'), state);
		this.crossingRenderer?.light(at('crossing'), state);
	}

	refreshSelectionVisuals() {
		this.refreshOffsetHandle();
		for (const segmentId of this.selectedSegments) {
			const segment = this.graph.segments.get(segmentId);
			if (!segment) continue;

			const startNode = this.graph.nodes.get(segment.startNodeId);
			const endNode = this.graph.nodes.get(segment.endNodeId);
			const ends = segmentEnds(this.graph, segment);
			if (!startNode || !endNode || !ends) continue;

			this.selectionRenderer.showSegment(segment, ends.a, ends.b, this.highlightedLane);
		}
	}

	// Joinable when the node bridges exactly two segments whose cross-sections
	// and offsets match once read in the same flow direction through it.
	canJoinNode(nodeId: string) {
		const node = this.graph.nodes.get(nodeId);
		if (!node || node.connectedSegments.length !== 2) return false;
		const segA = this.graph.segments.get(node.connectedSegments[0]);
		const segB = this.graph.segments.get(node.connectedSegments[1]);
		if (!segA || !segB) return false;
		const farA = segA.startNodeId === nodeId ? segA.endNodeId : segA.startNodeId;
		const farB = segB.startNodeId === nodeId ? segB.endNodeId : segB.startNodeId;
		if (farA === farB) return false;
		const flowA = segA.endNodeId === nodeId ? segA.lanes : reverseLanes(segA.lanes);
		const flowB = segB.startNodeId === nodeId ? segB.lanes : reverseLanes(segB.lanes);
		const offsetA = segA.endNodeId === nodeId ? segA.offset : -segA.offset;
		const offsetB = segB.startNodeId === nodeId ? segB.offset : -segB.offset;
		return serializeLanes(flowA) === serializeLanes(flowB) && Math.abs(offsetA - offsetB) < 1e-6;
	}

	joinNode(nodeId: string) {
		const node = this.graph.nodes.get(nodeId);
		if (!node || node.connectedSegments.length !== 2) return;
		const segA = this.graph.segments.get(node.connectedSegments[0]);
		const segB = this.graph.segments.get(node.connectedSegments[1]);
		if (!segA || !segB) return;
		const farAId = segA.startNodeId === nodeId ? segA.endNodeId : segA.startNodeId;
		const farBId = segB.startNodeId === nodeId ? segB.endNodeId : segB.startNodeId;
		const farA = this.graph.nodes.get(farAId);
		const farB = this.graph.nodes.get(farBId);
		if (!farA || !farB || farAId === farBId) return;

		if (!this.canJoinNode(nodeId)) return;
		const flowA = segA.endNodeId === nodeId ? segA.lanes : reverseLanes(segA.lanes);
		const flowB = segB.startNodeId === nodeId ? segB.lanes : reverseLanes(segB.lanes);

		const merged = this.graph.createSegment(farAId, farBId, cloneLanes(flowA));
		merged.offset = segA.endNodeId === nodeId ? segA.offset : -segA.offset;
		// Keep the shape: bow the merged road through where the node sat unless the
		// three points were already collinear, in which case it stays straight.
		const ax = farB.x - farA.x;
		const ay = farB.y - farA.y;
		const cross = ax * (node.y - farA.y) - ay * (node.x - farA.x);
		const lengthSq = ax * ax + ay * ay;
		if (lengthSq > 1e-6 && (cross * cross) / lengthSq > 0.25) {
			merged.setControlPoint(
				2 * node.x - (farA.x + farB.x) / 2,
				2 * node.y - (farA.y + farB.y) / 2
			);
		}

		// The far nodes' junction edits move onto the merged road: A's end at
		// its far node is the merged start, B's the merged end, and B's lanes
		// are the merged lanes in the same order.
		const laneOfB: Record<string, string | undefined> = Object.fromEntries(
			flowB.map((l, i) => [l.id ?? '', merged.lanes[i]?.id])
		);
		const onMerged = (road: string, end: 'start' | 'end') => {
			if (road === segA.id)
				return end === (segA.startNodeId === nodeId ? 'end' : 'start')
					? { road: merged.id, end: 'start' as const }
					: null;
			if (road === segB.id)
				return end === (segB.startNodeId === nodeId ? 'end' : 'start')
					? { road: merged.id, end: 'end' as const }
					: null;
			return { road, end };
		};
		const laneOnMerged = (road: string, lane: string) =>
			road === segB.id ? (laneOfB[lane] ?? null) : lane;
		for (const far of [farA, farB]) {
			if (far.junction) far.junction = mapJunction(far.junction, onMerged, laneOnMerged);
		}
		// Crossings kept on the joined node move to the merged road's start,
		// measured from there.
		const lengthA = Math.hypot(node.x - farA.x, node.y - farA.y);
		const moved = (node.junction?.crossings ?? []).flatMap((c) => {
			const onA = c.road === segA.id;
			const at = c.at === undefined ? undefined : onA ? lengthA - c.at : lengthA + c.at;
			const lanes = c.lanes.map((l) => (onA ? l : laneOfB[l])) as [string, string];
			return lanes[0] && lanes[1]
				? [{ ...c, road: merged.id, end: 'start' as const, at, lanes }]
				: [];
		});
		if (moved.length)
			farA.junction = {
				...(farA.junction ?? { connections: [] }),
				crossings: [...(farA.junction?.crossings ?? []), ...moved]
			};

		this.graph.deleteSegment(segA.id);
		this.graph.deleteSegment(segB.id);
		this.graph.deleteNode(nodeId);
		this.nodeRenderer.removeNode(nodeId);
		this.clearSelection();
		this.selectSegment(merged.id);
		this.rebuildRoads();
		this.graph.save();
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

	// Drop the connector overlay when its node no longer exists (reset, city
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
		this.graph.clear();
		this.dropStaleConnector();
		this.graph.save();
	}

	// Swap the whole working graph. Persists like any edit unless told not to.
	// An undo or redo keeps the drawing's caches: the graph it restores is
	// mostly the one on screen, and only the roads and junctions whose content
	// differs are drawn again.
	replaceGraph(data: GraphData, persist = true, keepDrawing = false) {
		this.clearSelection();
		this.setHoveredNode(null);
		this.setHoveredSegment(null);
		this.nodeRenderer.clear();
		if (!keepDrawing) this.roadRenderer.clear();
		this.graph.fromJSON(data);
		this.dropStaleConnector();
		for (const node of this.graph.nodes.values()) {
			this.nodeRenderer.createNode(node);
		}
		this.rebuildRoads();
		// persist=false just loads a city or example into view without saving it.
		if (persist) this.graph.save();
	}

	dispose() {
		if (this.modeHandlers?.cleanup) {
			this.modeHandlers.cleanup();
		}
		if (this.boundKeyDown) {
			window.removeEventListener('keydown', this.boundKeyDown);
		}
		window.removeEventListener('beforeunload', this.warnUnsaved);
		if (this.boundMouseUp) window.removeEventListener('mouseup', this.boundMouseUp);
		if (this.boundHistoryKeyDown) {
			window.removeEventListener('keydown', this.boundHistoryKeyDown);
		}
		if (this.boundClipboardKeyDown) {
			window.removeEventListener('keydown', this.boundClipboardKeyDown);
		}
		this.selectionRenderer?.dispose();
		this.taperRenderer?.dispose();
		this.offsetRenderer?.dispose();
		this.crossingRenderer?.dispose();
		this.connectionRenderer?.dispose();
		this.roadRenderer?.destroy();
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
