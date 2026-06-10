import * as THREE from 'three';
import type { ModeHandlers } from './types';
import type { Editor } from '../editor.svelte';
import type { Segment } from '../core/segment.svelte';
import type { Node } from '../core/node.svelte';
import { distanceToQuadraticBezier, getQuadraticBezierTangent } from '../geometry/bezier';

const NODE_HIT_THRESHOLD = 15;
const SEGMENT_HIT_THRESHOLD = 10;
const CONTROL_POINT_HIT_THRESHOLD = 12;
const STRAIGHT_SNAP_DISTANCE = 10;
const MARQUEE_COLOR = 0x4a9eff;
const MARQUEE_Y = 0.5;

type DragTarget =
	| { type: 'nodes' }
	| { type: 'controlPoint'; segmentId: string }
	| { type: 'segments'; segmentIds: string[] }
	| null;

export function setupSelectMode(editor: Editor): ModeHandlers {
	let isDragging = false;
	let dragTarget: DragTarget = null;
	let dragStartX = 0;
	let dragStartZ = 0;
	let marqueeStart: { x: number; z: number } | null = null;

	const marqueeFillMaterial = new THREE.MeshBasicMaterial({
		color: MARQUEE_COLOR,
		transparent: true,
		opacity: 0.12
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
		color: MARQUEE_COLOR,
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

	// Select everything inside the rectangle: nodes by position, segments
	// when both endpoints fall inside.
	const applyMarquee = (endX: number, endZ: number) => {
		if (!marqueeStart) return;

		const minX = Math.min(marqueeStart.x, endX);
		const maxX = Math.max(marqueeStart.x, endX);
		const minZ = Math.min(marqueeStart.z, endZ);
		const maxZ = Math.max(marqueeStart.z, endZ);
		const inside = (x: number, y: number) => x >= minX && x <= maxX && y >= minZ && y <= maxZ;

		for (const node of editor.graph.nodes.values()) {
			if (inside(node.x, node.y)) {
				editor.selectNode(node.id);
			}
		}
		for (const segment of editor.graph.segments.values()) {
			const startNode = editor.graph.nodes.get(segment.startNodeId);
			const endNode = editor.graph.nodes.get(segment.endNodeId);
			if (
				startNode &&
				endNode &&
				inside(startNode.x, startNode.y) &&
				inside(endNode.x, endNode.y)
			) {
				editor.selectSegment(segment.id);
			}
		}
	};
	// Control points expressed in their segment's local frame at drag start,
	// so curves scale and rotate proportionally with their moving endpoints.
	const controlFrames = new Map<string, { u: number; v: number }>();

	const captureControlFrames = () => {
		controlFrames.clear();

		for (const segment of editor.graph.segments.values()) {
			if (!segment.hasControlPoint) continue;
			if (
				!editor.selectedNodes.has(segment.startNodeId) &&
				!editor.selectedNodes.has(segment.endNodeId)
			) {
				continue;
			}

			const startNode = editor.graph.nodes.get(segment.startNodeId);
			const endNode = editor.graph.nodes.get(segment.endNodeId);
			if (!startNode || !endNode) continue;

			const dx = endNode.x - startNode.x;
			const dy = endNode.y - startNode.y;
			const lengthSq = dx * dx + dy * dy;
			if (lengthSq < 0.0001) continue;

			const rx = segment.controlX! - startNode.x;
			const ry = segment.controlY! - startNode.y;
			controlFrames.set(segment.id, {
				u: (rx * dx + ry * dy) / lengthSq,
				v: (dx * ry - dy * rx) / lengthSq
			});
		}
	};

	const restoreControlFrames = () => {
		for (const [segmentId, frame] of controlFrames) {
			const segment = editor.graph.segments.get(segmentId);
			if (!segment) continue;

			const startNode = editor.graph.nodes.get(segment.startNodeId);
			const endNode = editor.graph.nodes.get(segment.endNodeId);
			if (!startNode || !endNode) continue;

			const dx = endNode.x - startNode.x;
			const dy = endNode.y - startNode.y;
			segment.setControlPoint(
				startNode.x + frame.u * dx - frame.v * dy,
				startNode.y + frame.u * dy + frame.v * dx
			);
		}
	};

	const findNodeAt = (worldX: number, worldZ: number) => {
		return editor.graph.findNodeAt(worldX, worldZ, NODE_HIT_THRESHOLD);
	};

	const findSegmentAt = (worldX: number, worldZ: number) => {
		for (const segment of editor.graph.segments.values()) {
			const startNode = editor.graph.nodes.get(segment.startNodeId);
			const endNode = editor.graph.nodes.get(segment.endNodeId);
			if (!startNode || !endNode) continue;

			const cx = segment.controlX ?? (startNode.x + endNode.x) / 2;
			const cy = segment.controlY ?? (startNode.y + endNode.y) / 2;

			const dist = distanceToQuadraticBezier(
				worldX,
				worldZ,
				startNode.x,
				startNode.y,
				cx,
				cy,
				endNode.x,
				endNode.y
			);

			if (dist < SEGMENT_HIT_THRESHOLD) {
				return segment;
			}
		}
		return null;
	};

	const findControlPointAt = (worldX: number, worldZ: number) => {
		for (const segmentId of editor.selectedSegments) {
			const segment = editor.graph.segments.get(segmentId);
			if (!segment) continue;

			const startNode = editor.graph.nodes.get(segment.startNodeId);
			const endNode = editor.graph.nodes.get(segment.endNodeId);
			if (!startNode || !endNode) continue;

			const cx = segment.controlX ?? (startNode.x + endNode.x) / 2;
			const cy = segment.controlY ?? (startNode.y + endNode.y) / 2;

			const dx = worldX - cx;
			const dz = worldZ - cy;
			if (Math.sqrt(dx * dx + dz * dz) < CONTROL_POINT_HIT_THRESHOLD) {
				return segment;
			}
		}
		return null;
	};

	const moveControlPoint = (segmentId: string, dx: number, dz: number, factor: number) => {
		const segment = editor.graph.segments.get(segmentId);
		if (!segment) return;

		const startNode = editor.graph.nodes.get(segment.startNodeId);
		const endNode = editor.graph.nodes.get(segment.endNodeId);
		if (!startNode || !endNode) return;

		const cx = segment.controlX ?? (startNode.x + endNode.x) / 2;
		const cy = segment.controlY ?? (startNode.y + endNode.y) / 2;
		segment.setControlPoint(cx + dx * factor, cy + dz * factor);
	};

	// The direction a smooth continuation of the neighboring road would enter
	// this segment with at the given node, or null when the node has no other
	// segment. With several neighbors, the one closest to a straight-through
	// continuation wins.
	const approachDirectionAt = (segment: Segment, node: Node, otherNode: Node) => {
		const chordLength = Math.hypot(otherNode.x - node.x, otherNode.y - node.y);
		if (chordLength < 0.0001) return null;
		const chordX = (otherNode.x - node.x) / chordLength;
		const chordY = (otherNode.y - node.y) / chordLength;

		let best: { x: number; y: number } | null = null;
		let bestDot = Infinity;

		for (const segmentId of node.connectedSegments) {
			if (segmentId === segment.id) continue;
			const adjacent = editor.graph.segments.get(segmentId);
			if (!adjacent) continue;

			const adjacentStart = editor.graph.nodes.get(adjacent.startNodeId);
			const adjacentEnd = editor.graph.nodes.get(adjacent.endNodeId);
			if (!adjacentStart || !adjacentEnd) continue;

			const atStart = adjacent.startNodeId === node.id;
			const cx = adjacent.controlX ?? (adjacentStart.x + adjacentEnd.x) / 2;
			const cy = adjacent.controlY ?? (adjacentStart.y + adjacentEnd.y) / 2;
			const tangent = getQuadraticBezierTangent(
				adjacentStart.x,
				adjacentStart.y,
				cx,
				cy,
				adjacentEnd.x,
				adjacentEnd.y,
				atStart ? 0 : 1
			);
			const length = Math.hypot(tangent.x, tangent.y);
			if (length < 0.0001) continue;

			// Outward along the neighbor, away from the node.
			const outX = (atStart ? tangent.x : -tangent.x) / length;
			const outY = (atStart ? tangent.y : -tangent.y) / length;

			const dot = outX * chordX + outY * chordY;
			if (dot < bestDot) {
				bestDot = dot;
				best = { x: -outX, y: -outY };
			}
		}

		return best;
	};

	// Shift while dragging the control point: snap to the "perfect curve"
	// whose tangents line up with the neighboring segments at both ends —
	// the control point sits where the two approach rays intersect. Near the
	// straight line between the nodes it snaps to no curvature at all.
	const snapControlPoint = (segmentId: string, worldX: number, worldZ: number) => {
		const segment = editor.graph.segments.get(segmentId);
		if (!segment) return;

		const startNode = editor.graph.nodes.get(segment.startNodeId);
		const endNode = editor.graph.nodes.get(segment.endNodeId);
		if (!startNode || !endNode) return;

		const chordX = endNode.x - startNode.x;
		const chordY = endNode.y - startNode.y;
		const chordLength = Math.hypot(chordX, chordY);
		if (chordLength < 0.0001) return;

		// Straight snap: cursor close to the line between the endpoints.
		const t = Math.max(
			0,
			Math.min(
				1,
				((worldX - startNode.x) * chordX + (worldZ - startNode.y) * chordY) /
					(chordLength * chordLength)
			)
		);
		const nearestX = startNode.x + chordX * t;
		const nearestY = startNode.y + chordY * t;
		if (Math.hypot(worldX - nearestX, worldZ - nearestY) < STRAIGHT_SNAP_DISTANCE) {
			segment.clearControlPoint();
			return;
		}

		const fromStart = approachDirectionAt(segment, startNode, endNode);
		const fromEnd = approachDirectionAt(segment, endNode, startNode);
		const reach = chordLength * 5;

		if (fromStart && fromEnd) {
			const denominator = fromStart.x * fromEnd.y - fromStart.y * fromEnd.x;
			if (Math.abs(denominator) > 0.0001) {
				const qx = endNode.x - startNode.x;
				const qy = endNode.y - startNode.y;
				const a = (qx * fromEnd.y - qy * fromEnd.x) / denominator;
				const b = (qx * fromStart.y - qy * fromStart.x) / denominator;
				if (a > 0.01 && b > 0.01 && a < reach && b < reach) {
					segment.setControlPoint(startNode.x + fromStart.x * a, startNode.y + fromStart.y * a);
					return;
				}
			}
		}

		const single = fromStart ?? fromEnd;
		if (single) {
			const origin = fromStart ? startNode : endNode;
			const along = Math.max(
				0,
				Math.min(reach, (worldX - origin.x) * single.x + (worldZ - origin.y) * single.y)
			);
			segment.setControlPoint(origin.x + single.x * along, origin.y + single.y * along);
			return;
		}

		// No neighbors at all: symmetric curve via the perpendicular bisector.
		const perpX = -chordY / chordLength;
		const perpY = chordX / chordLength;
		const midX = (startNode.x + endNode.x) / 2;
		const midY = (startNode.y + endNode.y) / 2;
		const offset = (worldX - midX) * perpX + (worldZ - midY) * perpY;
		segment.setControlPoint(midX + perpX * offset, midY + perpY * offset);
	};

	const applyChanges = () => {
		editor.refreshSelectionVisuals();
		editor.rebuildRoads();
	};

	const onMouseDown = (event: MouseEvent) => {
		if (event.button !== 0) return;
		if (event.altKey) return;

		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		dragStartX = worldPos.x;
		dragStartZ = worldPos.z;

		// The hover highlight would go stale while dragging; selection visuals
		// take over from here.
		editor.setHoveredSegment(null);

		const controlPointSegment = findControlPointAt(worldPos.x, worldPos.z);
		if (controlPointSegment) {
			isDragging = true;
			dragTarget = { type: 'controlPoint', segmentId: controlPointSegment.id };
			return;
		}

		const node = findNodeAt(worldPos.x, worldPos.z);
		if (node) {
			if (event.shiftKey) {
				if (editor.selectedNodes.has(node.id)) {
					editor.deselectNode(node.id);
					return;
				}
				editor.selectNode(node.id);
			} else if (!editor.selectedNodes.has(node.id)) {
				editor.clearSelection();
				editor.selectNode(node.id);
			}
			isDragging = true;
			dragTarget = { type: 'nodes' };
			captureControlFrames();
			return;
		}

		const segment = findSegmentAt(worldPos.x, worldPos.z);
		if (segment) {
			if (event.shiftKey) {
				if (editor.selectedSegments.has(segment.id)) {
					editor.deselectSegment(segment.id);
					return;
				}
				editor.selectSegment(segment.id);
			} else if (!editor.selectedSegments.has(segment.id)) {
				editor.clearSelection();
				editor.selectSegment(segment.id);
			}
			isDragging = true;
			dragTarget = { type: 'segments', segmentIds: [...editor.selectedSegments] };
			return;
		}

		if (!event.shiftKey) {
			editor.clearSelection();
		}
		marqueeStart = { x: worldPos.x, z: worldPos.z };
	};

	const onMouseMove = (event: MouseEvent) => {
		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);

		if (marqueeStart) {
			updateMarqueeVisual(worldPos.x, worldPos.z);
			return;
		}

		if (!isDragging || !dragTarget) {
			const node = findNodeAt(worldPos.x, worldPos.z);
			editor.setHoveredNode(node?.id ?? null);
			editor.setHoveredSegment(node ? null : (findSegmentAt(worldPos.x, worldPos.z)?.id ?? null));
			return;
		}

		const dx = worldPos.x - dragStartX;
		const dz = worldPos.z - dragStartZ;

		if (dragTarget.type === 'nodes') {
			for (const nodeId of editor.selectedNodes) {
				const node = editor.graph.nodes.get(nodeId);
				if (node) {
					node.x += dx;
					node.y += dz;
					editor.nodeRenderer.updateNode(node);
				}
			}
			restoreControlFrames();
			applyChanges();
		} else if (dragTarget.type === 'controlPoint') {
			if (event.shiftKey) {
				snapControlPoint(dragTarget.segmentId, worldPos.x, worldPos.z);
			} else {
				moveControlPoint(dragTarget.segmentId, dx, dz, 1);
			}
			applyChanges();
		} else if (dragTarget.type === 'segments') {
			// Dragging a path moves the selected segments rigidly; curvature only
			// changes via the control-point handle. Shared endpoints move once.
			const movedNodes = new Set<string>();
			for (const segmentId of dragTarget.segmentIds) {
				const segment = editor.graph.segments.get(segmentId);
				if (!segment) continue;

				for (const nodeId of [segment.startNodeId, segment.endNodeId]) {
					if (movedNodes.has(nodeId)) continue;
					movedNodes.add(nodeId);

					const node = editor.graph.nodes.get(nodeId);
					if (node) {
						node.x += dx;
						node.y += dz;
						editor.nodeRenderer.updateNode(node);
					}
				}
				if (segment.hasControlPoint) {
					moveControlPoint(segment.id, dx, dz, 1);
				}
			}
			applyChanges();
		}

		dragStartX = worldPos.x;
		dragStartZ = worldPos.z;
	};

	const onMouseUp = (event: MouseEvent) => {
		if (marqueeStart) {
			const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
			applyMarquee(worldPos.x, worldPos.z);
			hideMarquee();
			marqueeStart = null;
			return;
		}

		if (isDragging) {
			editor.resolveSegmentCrossings();
			editor.graph.save();
		}
		isDragging = false;
		dragTarget = null;
		controlFrames.clear();
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Delete' || event.key === 'Backspace') {
			if (editor.selectedNodes.size > 0 || editor.selectedSegments.size > 0) {
				event.preventDefault();
				editor.deleteSelected();
			}
		} else if (event.key === 'Escape') {
			editor.clearSelection();
		}
	};

	const cleanup = () => {
		isDragging = false;
		dragTarget = null;
		marqueeStart = null;
		controlFrames.clear();
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
