import * as THREE from 'three';
import type { Point } from '../core/road-geometry';

// Per-arm setback handles shown on a selected junction: a stem from the node
// to a draggable dot sitting on the arm's stop line. Dragging the dot pulls
// the arm back from the node. A cheap overlay, rebuilt on selection/edit.
const HANDLE_Y = 0.31;
const COLOR = 0xfacc15;
const STEM_OPACITY = 0.85;
const HANDLE_RADIUS = 1.6;
const SEGMENTS = 16;
const RENDER_ORDER = 4;

export interface SetbackHandle {
	node: Point;
	handle: Point;
}

export class SetbackRenderer {
	private scene: THREE.Scene;
	private group: THREE.Group | null = null;
	private lineMaterial: THREE.LineBasicMaterial;
	private dotMaterial: THREE.MeshBasicMaterial;

	constructor(scene: THREE.Scene) {
		this.scene = scene;
		this.lineMaterial = new THREE.LineBasicMaterial({
			color: COLOR,
			transparent: true,
			opacity: STEM_OPACITY,
			depthWrite: false
		});
		this.dotMaterial = new THREE.MeshBasicMaterial({ color: COLOR, depthWrite: false });
	}

	show(handles: SetbackHandle[]) {
		this.clear();
		if (handles.length === 0) return;

		const group = new THREE.Group();
		group.renderOrder = RENDER_ORDER;

		for (const h of handles) {
			const stem = new THREE.Line(
				new THREE.BufferGeometry().setFromPoints([
					new THREE.Vector3(h.node.x, HANDLE_Y, h.node.y),
					new THREE.Vector3(h.handle.x, HANDLE_Y, h.handle.y)
				]),
				this.lineMaterial
			);
			group.add(stem);

			const dot = new THREE.Mesh(
				new THREE.CircleGeometry(HANDLE_RADIUS, SEGMENTS),
				this.dotMaterial
			);
			dot.rotation.x = -Math.PI / 2;
			dot.position.set(h.handle.x, HANDLE_Y + 0.01, h.handle.y);
			group.add(dot);
		}

		this.scene.add(group);
		this.group = group;
	}

	clear() {
		if (!this.group) return;
		this.group.traverse((object) => {
			if (object instanceof THREE.Line || object instanceof THREE.Mesh) object.geometry.dispose();
		});
		this.scene.remove(this.group);
		this.group = null;
	}

	dispose() {
		this.clear();
		this.lineMaterial.dispose();
		this.dotMaterial.dispose();
	}
}
