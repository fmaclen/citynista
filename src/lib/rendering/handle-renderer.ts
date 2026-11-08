import * as THREE from 'three';
import type { Pt as Point } from '../lab/model';
import { editorLineGeometry, createEditorLineMaterial } from './editor-line';
import {
	CROSSING_HANDLE,
	OFFSET_HANDLE,
	TAPER_HANDLE,
	ZEBRA_STRIPE_COLOR,
	type HandleLook
} from './editor-palette';
import {
	arrowShape,
	disposeHandleObject,
	handleMaterial,
	handleObject,
	outlineMaterial,
	triangleShape,
	zebraShape,
	type HandleParts,
	type ScreenSized
} from './handle-shapes';

// Draggable handles of one kind, each on an optional beaded stem in its
// colour: a node's taper ends (triangles pointing along their road), a road's
// offset (a two-headed arrow across it), the connector's crossings (zebra
// bars across their road, hollow when switched off). A cheap overlay, rebuilt
// on selection and edits.
const STEM_Y = 0.3;
const HANDLE_Y = 0.31;
const RENDER_ORDER = 8;

export type HandleKind = 'taper' | 'offset' | 'crossing';

const LOOKS: Record<HandleKind, HandleLook> = {
	taper: TAPER_HANDLE,
	offset: OFFSET_HANDLE,
	crossing: CROSSING_HANDLE
};

function shapeOf(kind: HandleKind, hollow: boolean): HandleParts {
	if (kind === 'taper') return triangleShape(TAPER_HANDLE);
	if (kind === 'offset') return arrowShape(OFFSET_HANDLE);
	return zebraShape(CROSSING_HANDLE, hollow);
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
	private lineMaterial: THREE.MeshBasicMaterial;
	private outline = outlineMaterial();
	private fill: THREE.MeshBasicMaterial;
	private detail = handleMaterial(ZEBRA_STRIPE_COLOR);

	constructor(scene: THREE.Scene, screenSized: ScreenSized, kind: HandleKind) {
		this.scene = scene;
		this.screenSized = screenSized;
		this.kind = kind;
		const color = LOOKS[kind].color;
		this.lineMaterial = createEditorLineMaterial(color);
		this.fill = handleMaterial(color);
	}

	show(handles: Handle[]) {
		this.clear();
		if (handles.length === 0) return;

		const group = new THREE.Group();
		const materials = { outline: this.outline, fill: this.fill, detail: this.detail };
		for (const h of handles) {
			if (h.stem) {
				const stem = new THREE.Mesh(editorLineGeometry(h.stem, STEM_Y), this.lineMaterial);
				stem.renderOrder = RENDER_ORDER - 1;
				group.add(stem);
			}
			const handle = handleObject(
				shapeOf(this.kind, !!h.hollow),
				materials,
				h.at,
				h.dir,
				HANDLE_Y,
				RENDER_ORDER
			);
			this.screenSized.set(handle, Infinity);
			this.handles.push(handle);
			group.add(handle);
		}

		this.scene.add(group);
		this.group = group;
	}

	clear() {
		for (const handle of this.handles) this.screenSized.delete(handle);
		this.handles = [];
		if (!this.group) return;
		disposeHandleObject(this.group);
		this.scene.remove(this.group);
		this.group = null;
	}

	dispose() {
		this.clear();
		for (const m of [this.lineMaterial, this.outline, this.fill, this.detail]) m.dispose();
	}
}
