import * as THREE from 'three';
import type { Node } from '../core/node.svelte';

// Node markers: outline rings sized to the widest
// road meeting at the node (the editor keeps radii in sync on rebuild).
// Blue means hover, yellow means selected — rings revealed as part of a
// selection take the selected tone, rings revealed by hover the hover one.
const DEFAULT_RADIUS = 6;
const RING_THICKNESS = 1.2;
const NODE_HOVER_COLOR = 0x4a9eff;
const NODE_DANGER_COLOR = 0xef4444;
const NODE_SELECTED_COLOR = 0xfacc15;
const NODE_OPACITY = 0.9;

export type NodeTone = 'hover' | 'selected' | 'danger';
const NODE_SEGMENTS = 48;
const NODE_Y_OFFSET = 0.2;

export class NodeRenderer {
	private scene: THREE.Scene;
	private meshes = new Map<string, THREE.Mesh>();
	private radii = new Map<string, number>();
	private selectedNodes = new Set<string>();
	private hoveredNode: string | null = null;
	private revealed = new Map<string, NodeTone>();

	constructor(scene: THREE.Scene) {
		this.scene = scene;
	}

	private ringGeometry(radius: number) {
		return new THREE.RingGeometry(radius - RING_THICKNESS, radius, NODE_SEGMENTS);
	}

	createNode(node: Node) {
		const geometry = this.ringGeometry(DEFAULT_RADIUS);
		const material = new THREE.MeshBasicMaterial({
			color: NODE_HOVER_COLOR,
			transparent: true,
			opacity: NODE_OPACITY
		});
		const mesh = new THREE.Mesh(geometry, material);

		mesh.rotation.x = -Math.PI / 2;
		mesh.position.set(node.x, NODE_Y_OFFSET, node.y);
		mesh.userData = { type: 'node', id: node.id };
		mesh.visible = this.revealed.has(node.id);

		this.scene.add(mesh);
		this.meshes.set(node.id, mesh);
		this.radii.set(node.id, DEFAULT_RADIUS);

		return mesh;
	}

	updateNode(node: Node) {
		const mesh = this.meshes.get(node.id);
		if (mesh) {
			mesh.position.set(node.x, NODE_Y_OFFSET, node.y);
		}
	}

	setRadius(nodeId: string, radius: number) {
		const mesh = this.meshes.get(nodeId);
		if (!mesh || this.radii.get(nodeId) === radius) return;

		mesh.geometry.dispose();
		mesh.geometry = this.ringGeometry(radius);
		this.radii.set(nodeId, radius);
	}

	removeNode(nodeId: string) {
		const mesh = this.meshes.get(nodeId);
		if (mesh) {
			this.scene.remove(mesh);
			mesh.geometry.dispose();
			(mesh.material as THREE.Material).dispose();
			this.meshes.delete(nodeId);
		}
		this.radii.delete(nodeId);
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
		material.color.setHex(
			selected ? NODE_SELECTED_COLOR : tone === 'danger' ? NODE_DANGER_COLOR : NODE_HOVER_COLOR
		);
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
		if (mesh) {
			mesh.visible = this.revealed.has(nodeId);
		}
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
