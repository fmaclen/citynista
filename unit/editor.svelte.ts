import { mock } from 'bun:test';
import * as THREE from 'three';
import { screenSizedMap } from '../src/lib/rendering/handle-shapes';
import { frameHooks } from '../src/lib/rendering/guide-renderer';
import { createLanesFrom } from '../src/lib/core/lane-template';
import type { GraphData } from '../src/lib/core/types';
import { Networks, type Scene } from '../src/lib/core/networks';

// The editor itself, driven in Node without a browser: its graph, modes and
// renderers as the page runs them, the camera a straight-down view where a
// pixel is `wpp` metres and screen (0, 0) lies on the world's origin, so a
// pointer event is placed in world metres. Nothing is painted.

// What the editor reads of the browser: the window's listeners, storage and
// animation frames (run by `frame()`, as the browser runs them between
// events), set up afresh for each editor opened.
const frames: (FrameRequestCallback | null)[] = [];
const window = new EventTarget();
function browser() {
	const store: Record<string, string> = {};
	const globals = {
		window,
		localStorage: {
			getItem: (key: string) => store[key] ?? null,
			setItem: (key: string, value: string) => void (store[key] = value),
			removeItem: (key: string) => void delete store[key]
		},
		HTMLElement: class {},
		requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
		cancelAnimationFrame: (id: number) => {
			frames[id - 1] = null;
		}
	};
	for (const [name, value] of Object.entries(globals))
		Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
	frames.length = 0;
}

let wpp = 0.1;
// The canvas the pointer events reach, with the style the connector sets its
// cursor on.
const newCanvas = () => Object.assign(new EventTarget(), { style: { cursor: '' } });
let canvas = newCanvas();

class FakeSceneManager {
	scene = new THREE.Scene();
	screenSized = screenSizedMap();
	beforeFrame = frameHooks();
	onCameraPersist = null;
	worldPerPixel = () => wpp;
	screenToWorld = (x: number, y: number) => ({ x: x * wpp, z: y * wpp });
	getCanvas = () => canvas;
	isCameraPanning = () => false;
	isDeterministicCamera = () => true;
	setGridVisible() {}
	getCameraState() {
		return { zoom: 1, targetX: 0, targetZ: 0, azimuth: 0, polar: 0 };
	}
	setCameraState() {}
	resetCamera() {}
	dispose() {}
}

mock.module('../src/lib/rendering/scene.svelte', () => ({
	SceneManager: FakeSceneManager,
	GRID_SUB: 10
}));
// Svelte as the browser runs it: its effects and reactive sets live, so the
// editor reacts to its mode and selection as on the page.
const load = (path: string) => import(path);
const client = (await load(
	'../node_modules/svelte/src/index-client.js'
)) as typeof import('svelte');
const reactivity = (await load(
	'../node_modules/svelte/src/reactivity/index-client.js'
)) as typeof import('svelte/reactivity');
mock.module('svelte', () => client);
mock.module('svelte/reactivity', () => reactivity);

const { Editor } = await import('../src/lib/editor.svelte');

// Runs the effects and animation frames the browser would run before the
// next event.
export function frame() {
	client.flushSync();
	while (frames.some((f) => f)) {
		const k = frames.findIndex((f) => f);
		const callback = frames[k]!;
		frames[k] = null;
		callback(0);
	}
	client.flushSync();
}

type Pointer = { shift?: boolean; ctrl?: boolean; buttons?: number };

// An editor showing `graph` in select mode, `perPixel` metres a pixel, and
// the pointer driven in world metres.
let open: InstanceType<typeof Editor> | null = null;
export function openEditor(graph: GraphData, perPixel = 0.1) {
	open?.dispose();
	browser();
	wpp = perPixel;
	canvas = newCanvas();
	let editor!: InstanceType<typeof Editor>;
	$effect.root(() => {
		editor = new Editor();
	});
	open = editor;
	void editor.init({} as HTMLElement, false);
	frame();
	editor.replaceGraph(graph);
	// A graph put in place is the city as opened: no step to undo.
	(editor as unknown as { clearHistory(): void }).clearHistory();

	const event = (type: string, x: number, y: number, o: Pointer = {}) =>
		Object.assign(new Event(type), {
			clientX: x / wpp,
			clientY: y / wpp,
			button: 0,
			buttons: o.buttons ?? (type === 'mouseup' ? 0 : 1),
			shiftKey: o.shift ?? false,
			ctrlKey: o.ctrl ?? false,
			metaKey: false,
			altKey: false
		});
	const fire = (type: string, x: number, y: number, o: Pointer = {}) => {
		const target = type === 'mouseup' ? window : canvas;
		frame();
		target.dispatchEvent(event(type, x, y, o));
		frame();
	};
	const key = (key: string, o: { shift?: boolean; ctrl?: boolean } = {}) => {
		const e = Object.assign(new Event('keydown'), {
			key,
			shiftKey: o.shift ?? false,
			ctrlKey: o.ctrl ?? false,
			metaKey: false,
			altKey: false
		});
		frame();
		window.dispatchEvent(e);
		frame();
	};

	// The hotbar slot holding `name` clicked, as its button does
	// (EditorToolbar.svelte): with a road selected it puts that road in the
	// slot, otherwise it arms the slot.
	const brush = (name: string) => {
		const i = editor.hotbar.findIndex((b) => b?.name === name);
		if (editor.pickableLanes !== null) editor.pickIntoSlot(i);
		else editor.activateSlot(i);
		frame();
	};

	return {
		editor,
		fire,
		key,
		// A press at `from`, moved in `steps` to `to` and let go there.
		drag(from: { x: number; y: number }, to: { x: number; y: number }, o: Pointer = {}, steps = 8) {
			fire('mousedown', from.x, from.y, o);
			for (let k = 1; k <= steps; k++)
				fire(
					'mousemove',
					from.x + ((to.x - from.x) * k) / steps,
					from.y + ((to.y - from.y) * k) / steps,
					o
				);
			fire('mouseup', to.x, to.y, o);
		},
		click(x: number, y: number, o: Pointer = {}) {
			fire('mousedown', x, y, o);
			fire('mouseup', x, y, o);
		},
		hover(x: number, y: number, o: Pointer = {}) {
			fire('mousemove', x, y, { ...o, buttons: 0 });
		},
		// Two clicks and the double-click the browser sends after them.
		dblclick(x: number, y: number) {
			for (let k = 0; k < 2; k++) {
				fire('mousedown', x, y);
				fire('mouseup', x, y);
			}
			fire('dblclick', x, y);
		},
		brush,
		// Draws a straight run of the hotbar's brush `name` through `points`, each
		// click free of any snap (Ctrl held) but where `snap` says, and leaves
		// draw mode, as `gestures().draw` in e2e/app.ts does on the page.
		draw(name: string, points: { x: number; y: number }[], snap: boolean[] = []) {
			brush(name);
			editor.setDrawStyle('straight');
			for (const [k, q] of points.entries()) {
				const o = { ctrl: !snap[k] };
				fire('mousemove', q.x, q.y, { ...o, buttons: 0 });
				fire('mousedown', q.x, q.y, o);
				fire('mouseup', q.x, q.y, o);
			}
			key('Escape');
			key('Escape');
		},
		graph: () => editor.graph.toJSON(),
		// The pieces the editor draws otherwise than a fresh build of its
		// graph would, as `__staleDrawing` in src/routes/+page.svelte reads
		// them: none, unless something kept from build to build missed a
		// change.
		stale() {
			frame();
			const live = editor.roadRenderer.scene;
			if (!live) return ['no drawing'];
			const fresh = new Networks().build(editor.graph).scene;
			const pieces = (scene: Scene) => [
				...scene.place.roads.map((r) => `road:${r.id}`),
				...scene.place.junctions.map((j) => `node:${j.id}`)
			];
			const drawn = (scene: Scene, piece: string) => {
				const id = piece.slice(5);
				const d = piece.startsWith('road') ? scene.road(id) : scene.node(id);
				return JSON.stringify(d, (k, v) => (k === 'key' ? undefined : v));
			};
			const shown = pieces(live);
			return [...shown, ...pieces(fresh).filter((piece) => !shown.includes(piece))].filter(
				(piece) => drawn(live, piece) !== drawn(fresh, piece)
			);
		},
		node: (id: string) => editor.graph.nodes.get(id)!,
		saved: () =>
			JSON.parse((editor as unknown as { presentState: string }).presentState) as GraphData
	};
}

// A saved graph of streets and paths, each road given by its ends (and an
// optional curve handle); nodes named `n<k>` in the order they are listed.
type Road = {
	id: string;
	from: string;
	to: string;
	lanes: 'street' | 'avenue' | 'path';
	control?: { x: number; y: number };
};
export function cityOf(nodes: Record<string, [number, number]>, roads: Road[]): GraphData {
	return {
		nodes: Object.entries(nodes).map(([id, [x, y]]) => ({ id, x, y })),
		segments: roads.map((r) => ({
			id: r.id,
			startNodeId: r.from,
			endNodeId: r.to,
			lanes: createLanesFrom(r.lanes),
			...(r.control ? { controlX: r.control.x, controlY: r.control.y } : {})
		}))
	} as GraphData;
}
