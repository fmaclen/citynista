import * as THREE from 'three';
import { getContext, setContext, untrack } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { fromPage } from './utils';
import { Graph } from './core/graph.svelte';
import { CityStore, loadExample } from './core/city-store';
import type { Brush, CameraState, CityRecord, CitySummary, GraphData, Lane } from './core/types';
import { cloneLanes, defaultHotbar, HOTBAR_SIZE, reverseLanes } from './core/lane-template';
import { resolveCrossings } from './core/crossings';
import { join, joinPlan } from './core/join';
import { nodePoint } from './core/road-line';
import { segmentEnds } from './core/attach';
import type { Control } from './road-model/model';
import { SceneManager, GRID_SUB } from './rendering/scene.svelte';
import { NodeRenderer, type NodeTone } from './rendering/node-renderer';
import { RoadRenderer } from './rendering/road-renderer';
import { COLOURS } from './rendering/road-palette';
import { SelectionRenderer } from './rendering/selection-renderer';
import { HandleRenderer } from './rendering/handle-renderer';
import { GuideRenderer } from './rendering/guide-renderer';
import { ConnectionRenderer } from './rendering/connection-renderer';
import { OFFSET_HANDLE, hitsHandle } from './rendering/handle-shapes';
import { NODE_RING_PX, type HandleState } from './rendering/editor-palette';
import { DRAW_STYLES, type DrawStyle, type ModeHandlers, type Mode } from './modes/types';
import { offsetHandle, type OffsetHandle } from './modes/offset';
import { setbackHandles, type SetbackHandle } from './modes/setback';
import { setupDrawMode } from './modes/draw';
import { setupCircleMode } from './modes/circle';
import { setupSelectMode } from './modes/select';
import { setupBulldozeMode } from './modes/bulldoze';
import { setupSplitMode } from './modes/split';
import { setupConnectorMode, type ConnectorEndpoint } from './modes/connector';
import { setupPlaceMode } from './modes/place';
import {
	copySegments,
	copySelection,
	paste,
	type Clipboard,
	type SegmentClipboard
} from './clipboard';

// One handle on the map, for tinting it by its state: a road's curvature
// handle, or a taper, offset or crossing handle by its place in the list shown.
export type HandleRef =
	| { kind: 'curve'; segmentId: string }
	| { kind: 'taper' | 'offset' | 'crossing'; index: number };

const EDITOR_CONTEXT_KEY = Symbol('editor');

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
	// Set when writing a city fails (storage full), cleared by the next write
	// that succeeds.
	saveError = $state<string | null>(null);
	private savedState = '';
	// The open city's own view. ?topdown and screenshot cameras are fixed for
	// tests and never replace it in what gets saved.
	private cityCamera: CameraState | null = null;
	// Map-wide snapping grid (toggled from the toolbar). Drawing snaps to gridSize.
	gridEnabled = $state(false);
	readonly gridSize = GRID_SUB;
	// A point on open ground, on the nearest grid intersection while the grid
	// is on.
	gridPoint(x: number, y: number) {
		if (!this.gridEnabled) return { x, y };
		const g = this.gridSize;
		return { x: Math.round(x / g) * g, y: Math.round(y / g) * g };
	}
	sceneManager!: SceneManager;
	nodeRenderer!: NodeRenderer;
	// Roads and junctions, drawn from the road model (src/lib/road-model).
	roadRenderer!: RoadRenderer;
	// The connection overlay: every junction's lane-to-lane connections.
	showConnections = $state(false);
	selectionRenderer!: SelectionRenderer;
	taperRenderer!: HandleRenderer;
	guideRenderer!: GuideRenderer;
	// The selected road's lateral offset handle.
	offsetRenderer!: HandleRenderer;
	// In the connector, a handle on each crosswalk to slide it along its road.
	crossingRenderer!: HandleRenderer;
	currentOffsetHandle: OffsetHandle | null = null;
	connectionRenderer!: ConnectionRenderer;
	currentTaperHandles: SetbackHandle[] = [];
	// The junction being edited in connector mode (modes/connector.ts), and
	// the lane dots it shows there.
	connectorNodeId: string | null = null;
	connectorEndpoints: ConnectorEndpoint[] = [];
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
	// The roads a drawing or paste would lay on the next click and their
	// drawing, while it shows them (read by ?model scripts): the arrow for the
	// way a one-way road runs, and whether the click would lay nothing.
	ghost: {
		graph: Graph;
		renderer: RoadRenderer;
		arrow: { at: { x: number; y: number }; dir: { x: number; y: number } } | null;
		blocked: boolean;
	} | null = null;
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
		return joinPlan(this.graph, nodeId) ? nodeId : null;
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
	private clipboard: Clipboard | null = null;

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
		this.roadRenderer = new RoadRenderer(scene);
		scene.background = new THREE.Color(COLOURS.ground);
		this.selectionRenderer = new SelectionRenderer(scene, screenSized);
		this.taperRenderer = new HandleRenderer(scene, screenSized, 'taper');
		this.guideRenderer = new GuideRenderer(scene, this.sceneManager.beforeFrame);
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
		this.replaceGraph(JSON.parse(serialized), true);
		// setupMode drew the mode's overlay (the connector's) against the
		// pre-undo graph; redraw it now that the restored graph is in place.
		this.modeHandlers?.refresh?.();
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
			if (e.key.toLowerCase() !== 'z' || !fromPage(e)) return;
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
				if (fromPage(e)) this.eyedrop();
				return;
			}
			if (!(e.metaKey || e.ctrlKey)) return;
			const key = e.key.toLowerCase();
			if ((key !== 'c' && key !== 'v' && key !== 'x') || !fromPage(e)) return;
			e.preventDefault();
			if (key === 'c') {
				this.clipboard = copySelection(this) ?? this.clipboard;
			} else if (key === 'x') {
				// Cut is copy-then-delete, scoped to roads (the only thing
				// placement can recreate). One undo step, the deletion; the
				// later placement is its own.
				const copied = copySegments(this);
				if (!copied) return;
				this.clipboard = copied;
				this.deleteSelected();
			} else if (this.clipboard) {
				paste(this, this.clipboard);
			}
		};
		window.addEventListener('keydown', this.boundClipboardKeyDown);
	}

	// Places a copy of the copied roads: they follow the pointer until a click
	// lays them (modes/place.ts).
	startPlacement(clipboard: SegmentClipboard) {
		this.pendingPlacement = clipboard;
		if (this.mode === 'place') this.setupMode('place');
		else this.mode = 'place';
	}

	private loadSavedData() {
		const { city, stored } = this.cityStore.ensureCurrent();
		this.wrote(stored);
		this.currentCityId = city.id;
		this.currentCityName = city.name;
		this.cityCamera = this.readCameraCache(city.id) ?? city.camera;
		this.cities = this.cityStore.list();
		this.graph.fromJSON(city.graph);
		this.rebuildRoads();
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
		const saved = this.cityStore.save({
			id: this.currentCityId,
			name: this.currentCityName,
			graph: this.graph.toJSON(),
			camera: this.cameraForSave()
		});
		if (!this.wrote(saved)) return;
		// Recording the current city can fail on its own (storage full on boot),
		// so every successful save records it again: a reload reopens this city.
		// A city storage refused on boot is listed only from its first save.
		this.cityStore.setCurrentId(this.currentCityId);
		if (!this.cities.some((c) => c.id === this.currentCityId)) this.cities = this.cityStore.list();
		this.markSaved();
	}

	// True once the new city is stored and open.
	saveAs(name: string) {
		const city = this.cityStore.create(name, this.graph.toJSON(), this.cameraForSave());
		if (!this.wrote(city)) return false;
		this.saveAsOpen = false;
		this.cityStore.setCurrentId(city.id);
		this.currentExampleId = null;
		this.currentCityId = city.id;
		this.currentCityName = city.name;
		this.cities = this.cityStore.list();
		this.markSaved();
		return true;
	}

	// Whether storage took a save, rename or new city, keeping the message that
	// says it didn't in step.
	private wrote<T>(result: T | null | false): result is T {
		this.saveError = result ? null : "Couldn't save: this browser's storage is full";
		return !!result;
	}

	private markSaved() {
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
	}

	private showCity(city: CityRecord, camera: CameraState | null) {
		this.cityCamera = camera;
		// In ?topdown / screenshot mode the camera is fixed deterministically — don't
		// clobber it with the city's saved view (or the e2e screen coords drift).
		if (!this.sceneManager.isDeterministicCamera()) {
			if (camera) this.sceneManager.setCameraState(camera);
			else this.sceneManager.resetCamera();
		}
		this.replaceGraph(city.graph);
		this.clearHistory();
		this.saveError = null;
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
		if (!this.wrote(this.cityStore.rename(this.currentCityId, trimmed))) return;
		this.currentCityName = trimmed;
		this.cities = this.cityStore.list();
	}

	// True once the new city is stored and open.
	newCity(name: string) {
		const city = this.cityStore.create(name);
		if (!this.wrote(city)) return false;
		this.openCity(city);
		return true;
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

	// Draws the map as the graph now stands: roads, junctions, the handles
	// on the selection, and every node's ring where its roads meet (rings
	// come and go with their nodes).
	rebuildRoads() {
		this.roadRenderer.update(this.graph);
		this.refreshTaperHandles();
		this.refreshOffsetHandle();
		this.nodeRenderer.keepOnly(this.graph.nodes);
		for (const node of this.graph.nodes.values()) {
			this.nodeRenderer.setPosition(node, nodePoint(this.graph, node));
		}
	}

	// A node ring's radius in world units at the current zoom: a fixed size on
	// screen. The modes use it as the node's hit and snap radius, so the ring
	// you see is the area you click.
	nodeRingRadius() {
		return NODE_RING_PX * this.sceneManager.worldPerPixel();
	}

	// Join the changed roads to what they pass over: a node under the road,
	// or another road crossed mid-span, so overlapping roads become real
	// intersections.
	resolveSegmentCrossings(changed: Iterable<string>) {
		if (!resolveCrossings(this.graph, changed)) return;
		this.clearSelection();
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
		// Leaving the connector (Escape, a click on empty ground, another mode
		// picked) closes it.
		if (mode !== 'connector' && this.connectorNodeId) {
			this.closeConnector();
			this.rebuildRoads();
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
				if (fromPage(e)) handler(e);
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

	// The setback handles and guides on a single selected node
	// (modes/setback.ts), shown again for the graph as it stands.
	refreshTaperHandles() {
		const shown = setbackHandles(this);
		this.currentTaperHandles = shown?.handles ?? [];
		if (shown) {
			this.taperRenderer.show(shown.handles.map((h) => ({ at: h.handle, dir: h.dir })));
			this.guideRenderer.show(shown.guides);
		} else {
			this.taperRenderer?.clear();
			this.guideRenderer?.clear();
		}
	}

	// Every way out of the connector comes through here (Escape or a click on
	// empty ground, another mode picked, its node undone away): the node is
	// let go, so its taper follows its connections again from the next build.
	private closeConnector() {
		this.connectorNodeId = null;
		this.controlBadges = [];
		this.crossingRenderer.clear();
		this.roadRenderer.holdTaper(null);
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
		this.guideRenderer.clear();
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

	// Dissolves a node that only passes through two matching roads back into
	// one road (core/join.ts), selected.
	joinNode(nodeId: string) {
		const plan = joinPlan(this.graph, nodeId);
		if (!plan) return;
		const merged = join(this.graph, plan);
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
				this.graph.deleteNode(nodeId);
				nodesToCheck.delete(nodeId);
			}
		}

		for (const nodeId of nodesToCheck) {
			const node = this.graph.nodes.get(nodeId);
			if (node && node.connectedSegments.length === 0) {
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
		this.closeConnector();
		this.connectionRenderer.clear();
		if (this.mode === 'connector') this.mode = 'select';
	}

	// Swap the whole working graph without recording it as an edit. An undo
	// or redo keeps the drawing's caches: the graph it restores is
	// mostly the one on screen, and only the roads and junctions whose content
	// differs are drawn again.
	replaceGraph(data: GraphData, keepDrawing = false) {
		this.clearSelection();
		this.setHoveredNode(null);
		this.setHoveredSegment(null);
		this.nodeRenderer.clear();
		if (!keepDrawing) this.roadRenderer.clear();
		this.graph.fromJSON(data);
		this.dropStaleConnector();
		this.rebuildRoads();
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
		this.guideRenderer?.dispose();
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
