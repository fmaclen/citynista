import * as THREE from 'three';
import type { Node } from '../core/node.svelte';

const NODE_RADIUS = 6;
const NODE_COLOR = 0xf59e0b; // amber-500
const NODE_SELECTED_COLOR = 0x4a9eff;
const NODE_SELECTED_SCALE = 1.3;
const NODE_OPACITY = 0.75;
const NODE_SEGMENTS = 32;
const NODE_Y_OFFSET = 0.2;

export class NodeRenderer {
	private scene: THREE.Scene;
	private meshes = new Map<string, THREE.Mesh>();
	private selectedNodes = new Set<string>();
	private visible = false;

	constructor(scene: THREE.Scene) {
		this.scene = scene;
	}

	createNode(node: Node) {
		const geometry = new THREE.CircleGeometry(NODE_RADIUS, NODE_SEGMENTS);
		const material = new THREE.MeshBasicMaterial({
			color: NODE_COLOR,
			transparent: true,
			opacity: NODE_OPACITY
		});
		const mesh = new THREE.Mesh(geometry, material);

		mesh.rotation.x = -Math.PI / 2;
		mesh.position.set(node.x, NODE_Y_OFFSET, node.y);
		mesh.userData = { type: 'node', id: node.id };
		mesh.visible = this.visible;

		this.scene.add(mesh);
		this.meshes.set(node.id, mesh);

		return mesh;
	}

	updateNode(node: Node) {
		const mesh = this.meshes.get(node.id);
		if (mesh) {
			mesh.position.set(node.x, NODE_Y_OFFSET, node.y);
		}
	}

	removeNode(nodeId: string) {
		const mesh = this.meshes.get(nodeId);
		if (mesh) {
			this.scene.remove(mesh);
			mesh.geometry.dispose();
			(mesh.material as THREE.Material).dispose();
			this.meshes.delete(nodeId);
		}
		this.selectedNodes.delete(nodeId);
	}

	setSelected(nodeId: string, selected: boolean) {
		const mesh = this.meshes.get(nodeId);
		if (mesh) {
			const material = mesh.material as THREE.MeshBasicMaterial;
			material.color.setHex(selected ? NODE_SELECTED_COLOR : NODE_COLOR);
			mesh.scale.setScalar(selected ? NODE_SELECTED_SCALE : 1);

			if (selected) {
				this.selectedNodes.add(nodeId);
			} else {
				this.selectedNodes.delete(nodeId);
			}
		}
	}

	clearSelection() {
		for (const nodeId of this.selectedNodes) {
			const mesh = this.meshes.get(nodeId);
			if (mesh) {
				const material = mesh.material as THREE.MeshBasicMaterial;
				material.color.setHex(NODE_COLOR);
				mesh.scale.setScalar(1);
			}
		}
		this.selectedNodes.clear();
	}

	setAllVisible(visible: boolean) {
		this.visible = visible;
		for (const mesh of this.meshes.values()) {
			mesh.visible = visible;
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
