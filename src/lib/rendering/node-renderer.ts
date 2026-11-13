import * as THREE from 'three';
import type { Node } from '../core/node.svelte';
import {
	HOVER_COLOR,
	SELECT_COLOR,
	DANGER_COLOR,
	NODE_RING_PX,
	RING_THICKNESS_PX
} from './editor-palette';
import type { ScreenSized } from './handle-shapes';

// Node markers: outline rings of one fixed size on screen (NODE_RING_PX),
// modelled in pixels and scaled to world units per pixel each frame by the
// scene manager. Only revealed rings are registered for that scaling.
// Cyan means hover, yellow means selected — rings revealed as part of a
// selection take the selected tone, rings revealed by hover the hover one.
const NODE_OPACITY = 0.9;

export type NodeTone = 'hover' | 'selected' | 'danger';
const NODE_SEGMENTS = 48;

// A node ring in pixel units, for anything that previews one (the draw ghost,
// split and paste markers); register the mesh in `screenSized` to size it.
export function nodeRingGeometry() {
	return new THREE.RingGeometry(NODE_RING_PX - RING_THICKNESS_PX, NODE_RING_PX, NODE_SEGMENTS);
}
// Above the whole lane-layer stack (which now reaches ~0.31 with composite
// material layers) so hover/selection rings are never hidden under the road.
export const NODE_Y_OFFSET = 0.4;

export class NodeRenderer {
	private scene: THREE.Scene;
	private screenSized: ScreenSized;
	// Every ring is the same shape, so they share one geometry.
	private geometry = nodeRingGeometry();
	private meshes = new Map<string, THREE.Mesh>();
	private selectedNodes = new Set<string>();
	private hoveredNode: string | null = null;
	private revealed = new Map<string, NodeTone>();

	constructor(scene: THREE.Scene, screenSized: ScreenSized) {
		this.scene = scene;
		this.screenSized = screenSized;
	}

	createNode(node: Node) {
		const material = new THREE.MeshBasicMaterial({
			color: HOVER_COLOR,
			transparent: true,
			opacity: NODE_OPACITY
		});
		const mesh = new THREE.Mesh(this.geometry, material);

		mesh.rotation.x = -Math.PI / 2;
		mesh.position.set(node.x, NODE_Y_OFFSET, node.y);
		mesh.userData = { type: 'node', id: node.id };
		mesh.visible = false;

		this.scene.add(mesh);
		this.meshes.set(node.id, mesh);
		this.applyVisibility(node.id);

		return mesh;
	}

	updateNode(node: Node) {
		const mesh = this.meshes.get(node.id);
		if (mesh) {
			mesh.position.set(node.x, NODE_Y_OFFSET, node.y);
		}
	}

	// Where the ring shows (see nodePoint).
	setPosition(nodeId: string, p: { x: number; y: number }) {
		const mesh = this.meshes.get(nodeId);
		if (mesh && (mesh.position.x !== p.x || mesh.position.z !== p.y))
			mesh.position.set(p.x, NODE_Y_OFFSET, p.y);
	}

	removeNode(nodeId: string) {
		const mesh = this.meshes.get(nodeId);
		if (mesh) {
			this.scene.remove(mesh);
			this.screenSized.delete(mesh);
			(mesh.material as THREE.Material).dispose();
			this.meshes.delete(nodeId);
		}
		this.selectedNodes.delete(nodeId);
		this.revealed.delete(nodeId);
		if (this.hoveredNode === nodeId) {
			this.hoveredNode = null;
		}
	}

	setSelected(nodeId: string, selected: boolean) {
		if (selected) {
			this.selectedNodes.add(nodeId);
		} else {
			this.selectedNodes.delete(nodeId);
		}
		this.applyStyle(nodeId);
	}

	setHovered(nodeId: string | null) {
		if (this.hoveredNode === nodeId) return;

		const previous = this.hoveredNode;
		this.hoveredNode = nodeId;
		if (previous) this.applyStyle(previous);
		if (nodeId) this.applyStyle(nodeId);
	}

	clearSelection() {
		const cleared = [...this.selectedNodes];
		this.selectedNodes.clear();
		for (const nodeId of cleared) {
			this.applyStyle(nodeId);
		}
	}

	private applyStyle(nodeId: string) {
		const mesh = this.meshes.get(nodeId);
		if (!mesh) return;

		const tone = this.revealed.get(nodeId);
		const selected = this.selectedNodes.has(nodeId) || tone === 'selected';
		const material = mesh.material as THREE.MeshBasicMaterial;
		material.color.setHex(selected ? SELECT_COLOR : tone === 'danger' ? DANGER_COLOR : HOVER_COLOR);
	}

	// Nodes are hidden by default; only revealed ones render — selection
	// endpoints and whatever is under the cursor, toned by why they show.
	setRevealed(tones: ReadonlyMap<string, NodeTone>) {
		for (const nodeId of [...this.revealed.keys()]) {
			if (!tones.has(nodeId)) {
				this.revealed.delete(nodeId);
				this.applyVisibility(nodeId);
			}
		}
		for (const [nodeId, tone] of tones) {
			if (this.revealed.get(nodeId) !== tone) {
				const isNew = !this.revealed.has(nodeId);
				this.revealed.set(nodeId, tone);
				if (isNew) this.applyVisibility(nodeId);
				this.applyStyle(nodeId);
			}
		}
	}

	private applyVisibility(nodeId: string) {
		const mesh = this.meshes.get(nodeId);
		if (!mesh) return;
		mesh.visible = this.revealed.has(nodeId);
		if (mesh.visible) this.screenSized.set(mesh, Infinity);
		else this.screenSized.delete(mesh);
	}

	clear() {
		for (const [nodeId] of this.meshes) {
			this.removeNode(nodeId);
		}
	}

	getMesh(nodeId: string) {
		return this.meshes.get(nodeId);
	}
}
