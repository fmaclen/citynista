# Architecture Refactor Plan

## Current Problems

### 1. **Mixed Concerns & Unclear Ownership**

- `canvas.ts` manages module-level state (currentMode, handlers, canvas/graph instances) but doesn't own the canvas or graph
- Mode handlers are set up in `canvas.ts` but triggered through global event handlers
- Graph data model has Fabric.js objects (Path, Circle) embedded in it - violates separation of concerns

### 2. **Non-Reactive State Management**

- Module-level variables in `canvas.ts` aren't reactive
- Mode handlers use module-level state that isn't reactive
- Canvas changes don't automatically trigger graph updates (manual sync required)
- Graph has `$effect` for auto-save but canvas rendering isn't reactive to graph changes

### 3. **Imperative Canvas Management**

- Canvas manipulation is entirely imperative (manual `canvas.add()`, `canvas.remove()`, `canvas.renderAll()`)
- Fabric.js objects are stored directly in Graph - breaks data/view separation
- Mode switching requires manual cleanup of handlers

### 4. **Context Pattern Issues**

- GraphContext doesn't truly own all graph-related state
- Mode state lives in GraphContext but mode logic lives in `canvas.ts`
- Canvas reference stored in context but canvas is created elsewhere
- No clear single source of truth for application state

### 5. **Future DB Integration Blockers**

- Graph stores Fabric.js objects which can't be serialized to DB
- No clear separation between domain model and presentation layer
- Changes to graph don't automatically propagate to canvas (and vice versa)

---

## Proposed Architecture

### Core Principles

1. **Everything is Reactive**: Use Svelte runes ($state, $derived, $effect) throughout
2. **Each Object Draws Itself**: Segments and Nodes manage their own Fabric.js objects
3. **Graph is Pure Data**: No Fabric.js objects in Graph, just data and IDs
4. **Context Owns All State**: All app state lives in single context
5. **Effects at Object Level**: Each Segment/Node has its own $effect for efficient updates

---

## New Structure

### 1. Core Classes

**`/lib/segment.svelte.ts`**

```typescript
export class Segment {
	id: string;
	startNodeId: string; // Just stores ID
	endNodeId: string; // Just stores ID
	controlX = $state(0);
	controlY = $state(0);

	isSelected = $state(false);
	isDraft = $state(false);

	// Private - only this segment touches these
	private path: Path | null = null;
	private startHandle: Circle | null = null;
	private endHandle: Circle | null = null;
	private bezierHandle: Circle | null = null;

	constructor(data: SegmentData, canvas: Canvas, graph: Graph) {
		this.id = data.id;
		this.startNodeId = data.startNodeId;
		this.endNodeId = data.endNodeId;
		this.controlX = data.controlX;
		this.controlY = data.controlY;

		// Each segment has its own effect - only runs when THIS segment changes
		$effect(() => {
			// Ask graph for the nodes we need
			const startNode = graph.nodes.get(this.startNodeId);
			const endNode = graph.nodes.get(this.endNodeId);

			if (!startNode || !endNode) return;

			// Track our dependencies
			void this.controlX;
			void this.controlY;
			void startNode.x;
			void startNode.y;
			void endNode.x;
			void endNode.y;

			// Only THIS segment redraws
			this.updatePath(canvas, startNode, endNode);
		});

		// Show/hide handles based on selection
		$effect(() => {
			if (this.isSelected) {
				this.showHandles(canvas, graph);
			} else {
				this.hideHandles(canvas);
			}
		});
	}

	private updatePath(canvas: Canvas, startNode: Node, endNode: Node) {
		if (!this.path) {
			this.path = createPath(
				startNode.x,
				startNode.y,
				endNode.x,
				endNode.y,
				this.controlX,
				this.controlY
			);
			canvas.add(this.path);
		} else {
			updatePathData(
				this.path,
				startNode.x,
				startNode.y,
				endNode.x,
				endNode.y,
				this.controlX,
				this.controlY
			);
		}
		canvas.renderAll();
	}

	cleanup(canvas: Canvas) {
		if (this.path) canvas.remove(this.path);
		this.hideHandles(canvas);
	}
}
```

**`/lib/node.svelte.ts`**

```typescript
export class Node {
	id: string;
	x = $state(0);
	y = $state(0);
	connectedSegments: string[] = [];

	private circle: Circle | null = null;
	private debugHitArea: Circle | null = null;

	constructor(data: NodeData, canvas: Canvas) {
		this.id = data.id;
		this.x = data.x;
		this.y = data.y;
		this.connectedSegments = data.connectedSegments;

		// Draw itself when position changes
		$effect(() => {
			void this.x;
			void this.y;
			this.draw(canvas);
		});
	}

	private draw(canvas: Canvas) {
		// Node drawing logic...
	}

	cleanup(canvas: Canvas) {
		if (this.circle) canvas.remove(this.circle);
		if (this.debugHitArea) canvas.remove(this.debugHitArea);
	}
}
```

**`/lib/graph.svelte.ts`**

```typescript
export class Graph {
	nodes = new SvelteMap<string, Node>();
	segments = new SvelteMap<string, Segment>();

	private canvas: Canvas | null = null;

	constructor() {
		// Auto-save when graph changes
		$effect(() => {
			void this.nodes.size;
			void this.segments.size;
			requestAnimationFrame(() => this.save());
		});
	}

	setCanvas(canvas: Canvas) {
		this.canvas = canvas;
	}

	addNode(data: NodeData): Node {
		const node = new Node(data, this.canvas!);
		this.nodes.set(node.id, node);
		return node;
	}

	addSegment(data: SegmentData): Segment {
		const segment = new Segment(data, this.canvas!, this);
		this.segments.set(segment.id, segment);
		return segment;
	}

	deleteSegment(id: string) {
		const segment = this.segments.get(id);
		if (segment) {
			segment.cleanup(this.canvas!);
			this.segments.delete(id);
		}
	}

	deleteNode(id: string) {
		const node = this.nodes.get(id);
		if (node) {
			node.cleanup(this.canvas!);
			this.nodes.delete(id);
		}
	}

	// Graph is just a container - doesn't render anything itself
	// Each Segment and Node draws itself via its own $effect
}
```

### 2. Context Layer

**`/lib/context/editor.svelte.ts`** - Editor State & Lifecycle

```typescript
import { Canvas } from 'fabric';
import { Graph } from '$lib/graph.svelte';
import { setupDraw } from '$lib/modes/draw';
import { setupSelect } from '$lib/modes/select';
import type { Segment } from '$lib/segment.svelte';

type ModeHandlers = {
	onMouseDown: (e: any) => void;
	onMouseMove: (e: any) => void;
	onMouseUp: (e: any) => void;
	onKeyDown?: (e: KeyboardEvent) => void;
	cleanup: () => void;
};

export class Editor {
	graph: Graph;
	canvas: Canvas | null = null;

	// Mode state
	mode = $state<'draw' | 'select' | undefined>(undefined);

	// Selection state (used in select mode)
	selectedSegments = $state(new Set<string>());
	selectedNodes = $state(new Set<string>());

	// Draft state (used in draw mode)
	isDrafting = $state(false);
	draftSegment: Segment | null = null;

	private currentHandlers: ModeHandlers | null = null;

	constructor() {
		this.graph = new Graph();

		// Auto-setup mode handlers when mode changes
		$effect(() => {
			this.setupModeHandlers();
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

		// Setup resize handler
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

		// Cleanup old handlers
		this.cleanupHandlers();

		if (this.mode === 'draw') {
			this.currentHandlers = setupDraw(this);
		} else if (this.mode === 'select') {
			this.currentHandlers = setupSelect(this);
		}

		// Attach handlers to canvas
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

	// Selection helpers
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
}

export function setEditorContext() {
	const editor = new Editor();
	setContext('editor', editor);
	return editor;
}

export function getEditorContext(): Editor {
	return getContext('editor');
}
```

### 3. Mode Handlers (Plain Functions)

**`/lib/modes/draw.ts`** (not .svelte.ts - no reactive state here)

```typescript
import type { Editor } from '$lib/context/editor.svelte';
import type { TPointerEventInfo } from 'fabric';
import { Segment } from '$lib/segment.svelte';
import { generateId } from '$lib/utils';

export function setupDraw(editor: Editor) {
	if (!editor.canvas) throw new Error('Canvas not initialized');

	editor.canvas.defaultCursor = 'crosshair';

	return {
		onMouseDown(e: TPointerEventInfo) {
			const pointer = e.viewportPoint;
			if (!pointer) return;

			// Create draft segment
			const segment = new Segment(
				{
					id: 'draft-' + generateId(),
					startNodeId: '', // Will be finalized later
					endNodeId: '',
					controlX: pointer.x,
					controlY: pointer.y
				},
				editor.canvas!,
				editor.graph
			);

			segment.isDraft = true;
			editor.draftSegment = segment;
			editor.isDrafting = true;
		},

		onMouseMove(e: TPointerEventInfo) {
			if (!editor.isDrafting || !editor.draftSegment) return;

			const pointer = e.viewportPoint;
			if (!pointer) return;

			// Update draft segment position (triggers its $effect to redraw)
			editor.draftSegment.controlX = pointer.x;
			editor.draftSegment.controlY = pointer.y;
		},

		onMouseUp() {
			if (!editor.draftSegment) return;

			const shouldCommit = true; // TODO: check length, etc.

			if (shouldCommit) {
				// Finalize nodes and add to graph
				const finalizedSegment = finalizeDraftSegment(editor, editor.draftSegment);
				editor.graph.addSegment(finalizedSegment);
			} else {
				editor.draftSegment.cleanup(editor.canvas!);
			}

			editor.draftSegment = null;
			editor.isDrafting = false;
		},

		cleanup() {
			if (editor.canvas) {
				editor.canvas.defaultCursor = 'default';
			}
			if (editor.draftSegment) {
				editor.draftSegment.cleanup(editor.canvas!);
				editor.draftSegment = null;
			}
			editor.isDrafting = false;
		}
	};
}
```

**`/lib/modes/select.ts`** (renamed from edit.ts)

```typescript
import type { Editor } from '$lib/context/editor.svelte';
import type { TPointerEventInfo } from 'fabric';

export function setupSelect(editor: Editor) {
	if (!editor.canvas) throw new Error('Canvas not initialized');

	return {
		onMouseDown(e: TPointerEventInfo) {
			const pointer = e.viewportPoint;
			if (!pointer) return;

			// Find clicked segment
			const clickedSegment = findSegmentAtPoint(editor, pointer);

			if (clickedSegment) {
				// Single select (clear others first)
				editor.clearSelection();
				editor.selectSegment(clickedSegment.id);
			} else {
				// Clicked empty space - clear selection
				editor.clearSelection();
			}
		},

		onMouseMove(e: TPointerEventInfo) {
			// TODO: Handle dragging selected segments
			// TODO: Show hover state
		},

		onMouseUp() {
			// TODO: Finalize any drag operations
		},

		onKeyDown(e: KeyboardEvent) {
			if (e.key === 'Delete' || e.key === 'Backspace') {
				editor.deleteSelected();
			}
		},

		cleanup() {
			editor.clearSelection();
		}
	};
}

function findSegmentAtPoint(editor: Editor, point: { x: number; y: number }) {
	// TODO: Implement hit testing
	// Loop through segments and check if point is near path
	return null;
}
```

### 4. Page Setup

**`/routes/+page.svelte`** - Minimal Page Setup

```svelte
<script lang="ts">
	import { setEditorContext } from '$lib/context/editor.svelte';
	import EditorToolbar from '$lib/components/EditorToolbar.svelte';

	let canvasElement: HTMLCanvasElement;
	const editor = setEditorContext();

	$effect(() => {
		if (!canvasElement) return;

		editor.initCanvas(canvasElement);
		editor.loadSavedData();
	});
</script>

<div class="h-screen w-screen overflow-hidden bg-[#2a2a2a]">
	<EditorToolbar />
	<canvas id="canvas" bind:this={canvasElement}></canvas>
</div>
```

---

## Migration Strategy

### Phase 1: Create New Classes

1. Create `Segment` class with $effects for self-drawing
2. Create `Node` class with $effects for self-drawing
3. Keep existing Graph for now, migrate incrementally

### Phase 2: Update Graph

1. Change Graph to instantiate new Segment/Node classes
2. Remove Fabric.js objects from NetworkSegment/NetworkNode interfaces
3. Graph becomes pure data + factory methods

### Phase 3: Consolidate Context

1. Create unified `App` context
2. Move mode state, selection state into App
3. Single setContext/getContext pair

### Phase 4: Refactor Modes

1. Create Draw and Edit classes
2. Move mode logic out of canvas.ts
3. Modes only update graph/context state

### Phase 5: Update Page Setup

1. Simplify +page.svelte to use new architecture
2. Remove canvas.ts entirely
3. All state and logic now in proper classes

### Phase 6: Cleanup

1. Remove old mode handler files
2. Remove canvas.ts
3. Clean up any remaining imperative code

---

## Key Benefits

### Performance

- Only changed segments redraw (each has its own $effect)
- No mass re-rendering when one thing changes
- Svelte's reactivity handles change detection

### Maintainability

- Each class has single responsibility
- Clear ownership (Segment owns its path, Node owns its circle)
- No global state or module variables

### DB Integration

- Graph is pure data (no Fabric.js objects)
- Segments/Nodes instantiate from data
- Easy to sync: `graph.addSegment(dataFromDB)` and it auto-renders

### Testability

- Can test Graph without canvas
- Can test Segment logic independently
- Clear interfaces between layers
