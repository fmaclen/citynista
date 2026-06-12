import * as THREE from 'three';
import type { ModeHandlers } from './types';
import type { Editor } from '../editor.svelte';
import { pickAt, rectContents } from './picking';

const DANGER_COLOR = 0xef4444;
const MARQUEE_Y = 0.5;

// Bulldoze: click demolishes a node (with its segments) or a segment;
// dragging from open ground draws a red marquee that demolishes everything
// contained. Deletion goes through the selection so orphan cleanup, saving,
// and undo all behave exactly like Delete in select mode.
export function setupBulldozeMode(editor: Editor): ModeHandlers {
	let marqueeStart: { x: number; z: number } | null = null;

	const marqueeFillMaterial = new THREE.MeshBasicMaterial({
		color: DANGER_COLOR,
		transparent: true,
		opacity: 0.15,
		depthWrite: false
	});
	const marqueeFill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), marqueeFillMaterial);
	marqueeFill.rotation.x = -Math.PI / 2;
	marqueeFill.position.y = MARQUEE_Y;
	marqueeFill.visible = false;
	editor.sceneManager.scene.add(marqueeFill);

	const marqueeOutlineGeometry = new THREE.BufferGeometry();
	marqueeOutlineGeometry.setAttribute(
		'position',
		new THREE.Float32BufferAttribute(new Float32Array(12), 3)
	);
	const marqueeOutlineMaterial = new THREE.LineBasicMaterial({
		color: DANGER_COLOR,
		transparent: true,
		opacity: 0.9
	});
	const marqueeOutline = new THREE.LineLoop(marqueeOutlineGeometry, marqueeOutlineMaterial);
	marqueeOutline.frustumCulled = false;
	marqueeOutline.visible = false;
	editor.sceneManager.scene.add(marqueeOutline);

	const updateMarqueeVisual = (endX: number, endZ: number) => {
		if (!marqueeStart) return;

		const minX = Math.min(marqueeStart.x, endX);
		const maxX = Math.max(marqueeStart.x, endX);
		const minZ = Math.min(marqueeStart.z, endZ);
		const maxZ = Math.max(marqueeStart.z, endZ);

		marqueeFill.position.set((minX + maxX) / 2, MARQUEE_Y, (minZ + maxZ) / 2);
		marqueeFill.scale.set(Math.max(maxX - minX, 0.001), Math.max(maxZ - minZ, 0.001), 1);

		const positions = marqueeOutlineGeometry.getAttribute('position');
		positions.setXYZ(0, minX, MARQUEE_Y, minZ);
		positions.setXYZ(1, maxX, MARQUEE_Y, minZ);
		positions.setXYZ(2, maxX, MARQUEE_Y, maxZ);
		positions.setXYZ(3, minX, MARQUEE_Y, maxZ);
		positions.needsUpdate = true;

		marqueeFill.visible = true;
		marqueeOutline.visible = true;
	};

	const hideMarquee = () => {
		marqueeFill.visible = false;
		marqueeOutline.visible = false;
	};

	const demolishSelection = () => {
		if (editor.selectedNodes.size === 0 && editor.selectedSegments.size === 0) return;
		editor.deleteSelected();
	};

	const onMouseDown = (event: MouseEvent) => {
		if (event.button !== 0) return;
		if (event.altKey) return;

		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		const { node, segment } = pickAt(editor, worldPos.x, worldPos.z);

		if (node || segment) {
			editor.clearSelection();
			if (node) editor.selectNode(node.id);
			if (segment) editor.selectSegment(segment.id);
			demolishSelection();
			return;
		}

		marqueeStart = { x: worldPos.x, z: worldPos.z };
	};

	const onMouseMove = (event: MouseEvent) => {
		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);

		if (marqueeStart) {
			updateMarqueeVisual(worldPos.x, worldPos.z);
			return;
		}

		const { node, segment } = pickAt(editor, worldPos.x, worldPos.z);
		editor.setHoveredNode(node?.id ?? null);
		editor.setHoveredSegment(segment?.id ?? null);
	};

	const onMouseUp = (event: MouseEvent) => {
		if (!marqueeStart) return;

		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		const contents = rectContents(editor, marqueeStart.x, marqueeStart.z, worldPos.x, worldPos.z);
		hideMarquee();
		marqueeStart = null;

		editor.clearSelection();
		for (const nodeId of contents.nodeIds) {
			editor.selectNode(nodeId);
		}
		for (const segmentId of contents.segmentIds) {
			editor.selectSegment(segmentId);
		}
		demolishSelection();
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') {
			editor.mode = 'select';
		}
	};

	const cleanup = () => {
		marqueeStart = null;
		editor.setHoveredNode(null);
		editor.setHoveredSegment(null);
		editor.sceneManager.scene.remove(marqueeFill);
		editor.sceneManager.scene.remove(marqueeOutline);
		marqueeFill.geometry.dispose();
		marqueeFillMaterial.dispose();
		marqueeOutlineGeometry.dispose();
		marqueeOutlineMaterial.dispose();
	};

	return {
		onMouseDown,
		onMouseMove,
		onMouseUp,
		onKeyDown,
		cleanup
	};
}
