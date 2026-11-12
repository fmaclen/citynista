import * as THREE from 'three';
import type { Pt as Point } from '../lab/model';
import { editorLineGeometry, createEditorLineMaterial } from './editor-line';
import { HANDLE_FILL, type HandleState } from './editor-palette';
import {
	CROSSING_HANDLE,
	CROSSING_OFF_HANDLE,
	OFFSET_HANDLE,
	TAPER_HANDLE,
	disposeHandleObject,
	handleObject,
	setHandleState,
	type HandleShape,
	type ScreenSized
} from './handle-shapes';

// Draggable handles of one kind (see handle-shapes.ts for the shapes): a
// node's taper ends (arrows pointing along their road, away from the node),
// a road's offset (a double arrow across it), the connector's crossings (bars
// across their road, hollow when switched off, each on a beaded line from
// sidewalk to sidewalk while on). One of them can be lit for its state. A
// cheap overlay, rebuilt on selection and edits.
const STEM_Y = 0.3;
const HANDLE_Y = 0.31;
const RENDER_ORDER = 8;

export type HandleKind = 'taper' | 'offset' | 'crossing';

function shapeOf(kind: HandleKind, hollow: boolean): HandleShape {
	if (kind === 'taper') return TAPER_HANDLE;
	if (kind === 'offset') return OFFSET_HANDLE;
	return hollow ? CROSSING_OFF_HANDLE : CROSSING_HANDLE;
}

export interface Handle {
	at: Point;
	// The handle's axis on the ground (a unit vector): along the road for a
	// taper, across it for an offset or a crossing.
	dir: Point;
	stem?: [Point, Point];
	// A crossing that is switched off.
	hollow?: boolean;
}

export class HandleRenderer {
	private scene: THREE.Scene;
	private screenSized: ScreenSized;
	private kind: HandleKind;
	private group: THREE.Group | null = null;
	private handles: THREE.Object3D[] = [];
	private lineMaterial = createEditorLineMaterial(HANDLE_FILL);
	// The handle under the pointer or in hand, by its place in the list shown.
	private lit: { index: number; state: HandleState } | null = null;

	constructor(scene: THREE.Scene, screenSized: ScreenSized, kind: HandleKind) {
		this.scene = scene;
		this.screenSized = screenSized;
		this.kind = kind;
	}

	show(handles: Handle[]) {
		const lit = this.lit;
		this.clear();
		this.lit = lit;
		if (handles.length === 0) return;

		const group = new THREE.Group();
		handles.forEach((h, i) => {
			if (h.stem) {
				const stem = new THREE.Mesh(editorLineGeometry(h.stem, STEM_Y), this.lineMaterial);
				stem.renderOrder = RENDER_ORDER - 1;
				group.add(stem);
			}
			const handle = handleObject(
				shapeOf(this.kind, !!h.hollow),
				h.at,
				h.dir,
				HANDLE_Y,
				RENDER_ORDER,
				lit?.index === i ? lit.state : 'rest'
			);
			this.screenSized.set(handle, Infinity);
			this.handles.push(handle);
			group.add(handle);
		});

		this.scene.add(group);
		this.group = group;
	}

	// Tints one handle for its state and the rest back to rest; null for none.
	light(index: number | null, state: HandleState = 'hover') {
		this.lit = index === null ? null : { index, state };
		this.handles.forEach((h, i) => setHandleState(h, i === index ? state : 'rest'));
	}

	clear() {
		for (const handle of this.handles) this.screenSized.delete(handle);
		this.handles = [];
		this.lit = null;
		if (!this.group) return;
		disposeHandleObject(this.group);
		this.scene.remove(this.group);
		this.group = null;
	}

	dispose() {
		this.clear();
		this.lineMaterial.dispose();
	}
}
