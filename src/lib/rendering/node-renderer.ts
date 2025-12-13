import * as THREE from 'three';
import type { Node } from '../core/node.svelte';

const NODE_RADIUS = 6;
const NODE_COLOR = 0xffffff;
const NODE_SELECTED_COLOR = 0x4a9eff;
const NODE_SEGMENTS = 32;

export class NodeRenderer {
	private scene: THREE.Scene;
	private meshes = new Map<string, THREE.Mesh>();
	private selectedNodes = new Set<string>();

	constructor(scene: THREE.Scene) {
		this.scene = scene;
	}

	createNode(node: Node) {
		const geometry = new THREE.CircleGeometry(NODE_RADIUS, NODE_SEGMENTS);
		const material = new THREE.MeshBasicMaterial({ color: NODE_COLOR });
		const mesh = new THREE.Mesh(geometry, material);

		mesh.rotation.x = -Math.PI / 2;
		mesh.position.set(node.x, 0.1, node.y);
		mesh.userData = { type: 'node', id: node.id };

		this.scene.add(mesh);
		this.meshes.set(node.id, mesh);

		return mesh;
	}

	updateNode(node: Node) {
		const mesh = this.meshes.get(node.id);
		if (mesh) {
			mesh.position.set(node.x, 0.1, node.y);
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
			}
		}
		this.selectedNodes.clear();
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
