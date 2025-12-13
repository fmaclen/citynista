import * as THREE from 'three';
import type { ModeHandlers } from './types';
import type { Editor } from '../editor.svelte';

export function setupDrawMode(editor: Editor): ModeHandlers {
	let startNodeId: string | null = null;
	let draftLine: THREE.Line | null = null;

	const createDraftLine = () => {
		const geometry = new THREE.BufferGeometry();
		const material = new THREE.LineBasicMaterial({
			color: 0xffffff,
			opacity: 0.5,
			transparent: true
		});
		draftLine = new THREE.Line(geometry, material);
		editor.sceneManager.scene.add(draftLine);
	};

	const updateDraftLine = (startX: number, startZ: number, endX: number, endZ: number) => {
		if (!draftLine) return;
		const points = [new THREE.Vector3(startX, 0.05, startZ), new THREE.Vector3(endX, 0.05, endZ)];
		draftLine.geometry.setFromPoints(points);
	};

	const removeDraftLine = () => {
		if (draftLine) {
			editor.sceneManager.scene.remove(draftLine);
			draftLine.geometry.dispose();
			(draftLine.material as THREE.Material).dispose();
			draftLine = null;
		}
	};

	const onMouseDown = (event: MouseEvent) => {
		if (event.button !== 0) return;
		if (event.shiftKey) return;

		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);

		const existingNode = editor.graph.findNodeAt(worldPos.x, worldPos.z);

		if (startNodeId === null) {
			if (existingNode) {
				startNodeId = existingNode.id;
			} else {
				const newNode = editor.graph.createNode(worldPos.x, worldPos.z);
				editor.nodeRenderer.createNode(newNode);
				startNodeId = newNode.id;
			}
			createDraftLine();
		} else {
			let endNodeId: string;

			if (existingNode) {
				endNodeId = existingNode.id;
			} else {
				const newNode = editor.graph.createNode(worldPos.x, worldPos.z);
				editor.nodeRenderer.createNode(newNode);
				endNodeId = newNode.id;
			}

			if (startNodeId !== endNodeId) {
				const segment = editor.graph.createSegment(startNodeId, endNodeId);
				const startNode = editor.graph.nodes.get(startNodeId)!;
				const endNode = editor.graph.nodes.get(endNodeId)!;
				editor.segmentRenderer.createSegment(segment, startNode, endNode);
				editor.graph.save();
			}

			removeDraftLine();
			startNodeId = endNodeId;
			createDraftLine();
		}
	};

	const onMouseMove = (event: MouseEvent) => {
		if (startNodeId === null || !draftLine) return;

		const startNode = editor.graph.nodes.get(startNodeId);
		if (!startNode) return;

		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		updateDraftLine(startNode.x, startNode.y, worldPos.x, worldPos.z);
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') {
			startNodeId = null;
			removeDraftLine();
		}
	};

	const cleanup = () => {
		startNodeId = null;
		removeDraftLine();
	};

	return {
		onMouseDown,
		onMouseMove,
		onKeyDown,
		cleanup
	};
}
