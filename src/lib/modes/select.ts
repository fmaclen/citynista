import * as THREE from 'three';
import type { ModeHandlers } from './types';
import type { Editor, SetbackHandleInfo } from '../editor.svelte';
import type { Segment } from '../core/segment.svelte';
import type { Node } from '../core/node.svelte';
import { getQuadraticBezierTangent } from '../geometry/bezier';
import { CONTROL_SIZE } from '../rendering/selection-renderer';
import { nodeHitAt, segmentHitAt, rectContents } from './picking';

// Snap radii are sized in screen pixels and converted to world units at
// the current zoom; hit areas live in modes/picking.
const CONTROL_POINT_HIT_PX = 17;
const STRAIGHT_SNAP_PX = 14;
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
	// Shift+click on a selected node means "deselect" only if no drag
	// follows — a shift+drag instead smooths the node's tangent live.
	let pendingShiftToggle: string | null = null;
	// Dragging a setback handle of the selected junction pulls that arm back.
	let setbackDrag: SetbackHandleInfo | null = null;
	let dragDistance = 0;

	const marqueeFillMaterial = new THREE.MeshBasicMaterial({
		color: MARQUEE_COLOR,
		transparent: true,
		opacity: 0.12,
		// Blend over selection highlights instead of occluding them.
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
		const contents = rectContents(editor, marqueeStart.x, marqueeStart.z, endX, endZ);
		for (const nodeId of contents.nodeIds) {
			editor.selectNode(nodeId);
		}
		for (const segmentId of contents.segmentIds) {
			editor.selectSegment(segmentId);
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

	const worldPerPixel = () => editor.sceneManager.worldPerPixel();

	// Inside a node's ring the node wins outright; shared logic lives in
	// modes/picking.
	const pickAt = (
		worldX: number,
		worldZ: number
	): { node: Node | null; segment: Segment | null } => {
		const nodeHit = nodeHitAt(editor, worldX, worldZ);
		if (nodeHit.node) return { node: nodeHit.node, segment: null };
		return { node: null, segment: segmentHitAt(editor, worldX, worldZ).segment };
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

			// The diamond is drawn in world units; its hit area covers the
			// visible shape with the pixel size only as a floor.
			const radius = Math.max(CONTROL_SIZE * 0.8, CONTROL_POINT_HIT_PX * worldPerPixel());
			if (Math.hypot(worldX - cx, worldZ - cy) < radius) {
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

	// Every direction a smooth continuation of a neighboring road would
	// enter this segment with at the given node — one candidate per
	// neighbor, so the handle can snap to any of them.
	const approachDirectionsAt = (segment: Segment, node: Node) => {
		const directions: { x: number; y: number }[] = [];

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

			// Inward along the neighbor's continuation, into this segment.
			const outX = (atStart ? tangent.x : -tangent.x) / length;
			const outY = (atStart ? tangent.y : -tangent.y) / length;
			directions.push({ x: -outX, y: -outY });
		}

		return directions;
	};

	// Shift while dragging the control point snaps to the nearest "perfect
	// curve": straight when near the chord, otherwise the candidate closest
	// to the cursor among every combination of neighbor tangents — ray
	// intersections (tangent-continuous at both ends) and single rays
	// (tangent-continuous at one end, cursor sliding along the ray). Keep
	// dragging the other way and the next neighbor's tangent catches.
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
		if (Math.hypot(worldX - nearestX, worldZ - nearestY) < STRAIGHT_SNAP_PX * worldPerPixel()) {
			segment.clearControlPoint();
			return;
		}

		const fromStarts = approachDirectionsAt(segment, startNode);
		const fromEnds = approachDirectionsAt(segment, endNode);
		const reach = chordLength * 5;
		const candidates: { x: number; y: number }[] = [];

		for (const fromStart of fromStarts) {
			for (const fromEnd of fromEnds) {
				const denominator = fromStart.x * fromEnd.y - fromStart.y * fromEnd.x;
				if (Math.abs(denominator) <= 0.0001) continue;
				const a = (chordX * fromEnd.y - chordY * fromEnd.x) / denominator;
				const b = (chordX * fromStart.y - chordY * fromStart.x) / denominator;
				if (a > 0.01 && b > 0.01 && a < reach && b < reach) {
					candidates.push({
						x: startNode.x + fromStart.x * a,
						y: startNode.y + fromStart.y * a
					});
				}
			}
		}
		for (const [origin, directions] of [
			[startNode, fromStarts],
			[endNode, fromEnds]
		] as const) {
			for (const direction of directions) {
				const along = Math.max(
					0,
					Math.min(reach, (worldX - origin.x) * direction.x + (worldZ - origin.y) * direction.y)
				);
				candidates.push({ x: origin.x + direction.x * along, y: origin.y + direction.y * along });
			}
		}

		if (candidates.length > 0) {
			let best = candidates[0];
			let bestDistance = Infinity;
			for (const candidate of candidates) {
				const distance = Math.hypot(worldX - candidate.x, worldZ - candidate.y);
				if (distance < bestDistance) {
					bestDistance = distance;
					best = candidate;
				}
			}
			segment.setControlPoint(best.x, best.y);
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

	// Shift-dragging near the line between two of the node's far endpoints
	// snaps the node onto it and straightens that pair — one perfectly
	// straight continuous road. Every pair of segments through the node is
	// a candidate, so it works at junctions and merge nodes too: the other
	// arms simply follow the node.
	const snapNodeStraight = (node: Node): boolean => {
		const ends: { segment: Segment; far: Node }[] = [];
		for (const segmentId of node.connectedSegments) {
			const segment = editor.graph.segments.get(segmentId);
			if (!segment) continue;
			const farId = segment.startNodeId === node.id ? segment.endNodeId : segment.startNodeId;
			const far = editor.graph.nodes.get(farId);
			if (!far) continue;
			ends.push({ segment, far });
		}
		if (ends.length < 2) return false;

		const threshold = STRAIGHT_SNAP_PX * worldPerPixel();
		let best: { x: number; y: number; pair: [Segment, Segment] } | null = null;
		let bestDistance = threshold;
		for (let i = 0; i < ends.length; i++) {
			for (let j = i + 1; j < ends.length; j++) {
				const ax = ends[i].far.x;
				const ay = ends[i].far.y;
				const dx = ends[j].far.x - ax;
				const dy = ends[j].far.y - ay;
				const lengthSq = dx * dx + dy * dy;
				if (lengthSq < 0.0001) continue;

				const t = ((node.x - ax) * dx + (node.y - ay) * dy) / lengthSq;
				if (t < 0.05 || t > 0.95) continue;
				const px = ax + dx * t;
				const py = ay + dy * t;
				const distance = Math.hypot(node.x - px, node.y - py);
				if (distance < bestDistance) {
					bestDistance = distance;
					best = { x: px, y: py, pair: [ends[i].segment, ends[j].segment] };
				}
			}
		}
		if (!best) return false;

		node.x = best.x;
		node.y = best.y;
		editor.nodeRenderer.updateNode(node);
		for (const segment of best.pair) {
			segment.clearControlPoint();
			controlFrames.delete(segment.id);
		}
		return true;
	};

	// Shift-dragging a dangling end node near the extension of a road at
	// its far end snaps it onto that line and straightens the segment — a
	// perfectly straight continuation.
	const snapEndNodeToContinuation = (node: Node): boolean => {
		if (node.connectedSegments.length !== 1) return false;
		const segment = editor.graph.segments.get(node.connectedSegments[0]);
		if (!segment) return false;
		const farId = segment.startNodeId === node.id ? segment.endNodeId : segment.startNodeId;
		const far = editor.graph.nodes.get(farId);
		if (!far) return false;

		const threshold = STRAIGHT_SNAP_PX * worldPerPixel();
		let best: { x: number; y: number } | null = null;
		let bestDistance = threshold;
		for (const direction of approachDirectionsAt(segment, far)) {
			const along = (node.x - far.x) * direction.x + (node.y - far.y) * direction.y;
			if (along < 1) continue;
			const candidate = { x: far.x + direction.x * along, y: far.y + direction.y * along };
			const distance = Math.hypot(node.x - candidate.x, node.y - candidate.y);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = candidate;
			}
		}
		if (!best) return false;

		node.x = best.x;
		node.y = best.y;
		editor.nodeRenderer.updateNode(node);
		segment.clearControlPoint();
		controlFrames.delete(segment.id);
		return true;
	};

	// A node with exactly two segments becomes a perfect tangent point: the
	// shared tangent is the line between the two far endpoints, and each
	// segment's control sits on it at a third of its chord.
	const smoothTangentThrough = (node: Node) => {
		if (node.connectedSegments.length !== 2) return;

		const ends: { segment: Segment; far: Node }[] = [];
		for (const segmentId of node.connectedSegments) {
			const segment = editor.graph.segments.get(segmentId);
			if (!segment) return;
			const farId = segment.startNodeId === node.id ? segment.endNodeId : segment.startNodeId;
			const far = editor.graph.nodes.get(farId);
			if (!far) return;
			ends.push({ segment, far });
		}

		const dirX = ends[1].far.x - ends[0].far.x;
		const dirY = ends[1].far.y - ends[0].far.y;
		const length = Math.hypot(dirX, dirY);
		if (length < 0.0001) return;

		for (const [index, { segment, far }] of ends.entries()) {
			const sign = index === 0 ? -1 : 1;
			const chord = Math.hypot(far.x - node.x, far.y - node.y);
			const reach = chord * 0.35;
			segment.setControlPoint(
				node.x + (dirX / length) * sign * reach,
				node.y + (dirY / length) * sign * reach
			);
		}
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

		// Dragging a setback handle of the selected junction. The handles sit
		// out on the stop lines, so node dragging still works at the centre.
		if (editor.selectedNodes.size === 1) {
			const handle = editor.setbackHandleAt(worldPos.x, worldPos.z);
			if (handle) {
				setbackDrag = handle;
				return;
			}
		}

		const controlPointSegment = findControlPointAt(worldPos.x, worldPos.z);
		if (controlPointSegment) {
			isDragging = true;
			dragTarget = { type: 'controlPoint', segmentId: controlPointSegment.id };
			return;
		}

		const { node, segment: pickedSegment } = pickAt(worldPos.x, worldPos.z);
		if (node) {
			if (event.shiftKey) {
				if (editor.selectedNodes.has(node.id)) {
					// Deselect only if this turns out to be a click, not a
					// shift+drag (which smooths the node's tangent instead).
					pendingShiftToggle = node.id;
				} else {
					editor.selectNode(node.id);
				}
			} else if (!editor.selectedNodes.has(node.id)) {
				editor.clearSelection();
				editor.selectNode(node.id);
			}
			isDragging = true;
			dragDistance = 0;
			dragTarget = { type: 'nodes' };
			captureControlFrames();
			return;
		}

		const segment = pickedSegment;
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

		if (setbackDrag) {
			editor.setSetbackFromDrag(setbackDrag, worldPos.x, worldPos.z);
			return;
		}

		if (marqueeStart) {
			updateMarqueeVisual(worldPos.x, worldPos.z);
			return;
		}

		if (!isDragging || !dragTarget) {
			const { node, segment } = pickAt(worldPos.x, worldPos.z);
			editor.setHoveredNode(node?.id ?? null);
			editor.setHoveredSegment(segment?.id ?? null);
			return;
		}

		const dx = worldPos.x - dragStartX;
		const dz = worldPos.z - dragStartZ;

		if (dragTarget.type === 'nodes') {
			dragDistance += Math.hypot(dx, dz);
			if (dragDistance > 1) pendingShiftToggle = null;

			for (const nodeId of editor.selectedNodes) {
				const node = editor.graph.nodes.get(nodeId);
				if (node) {
					node.x += dx;
					node.y += dz;
					editor.nodeRenderer.updateNode(node);
				}
			}
			restoreControlFrames();
			// Shift while dragging a single node: near the collinear line it
			// snaps onto it and straightens; otherwise a two-segment node
			// keeps the road perfectly tangent through it, both controls
			// re-solving every frame.
			if (event.shiftKey && editor.selectedNodes.size === 1) {
				const nodeId = [...editor.selectedNodes][0];
				const node = editor.graph.nodes.get(nodeId);
				if (node && !snapNodeStraight(node) && !snapEndNodeToContinuation(node)) {
					smoothTangentThrough(node);
				}
			}
			applyChanges();
			// Setback handles ride along with a moving junction.
			editor.refreshSetbackHandles();
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
		if (setbackDrag) {
			editor.finishSetback();
			setbackDrag = null;
			return;
		}

		if (marqueeStart) {
			const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
			applyMarquee(worldPos.x, worldPos.z);
			hideMarquee();
			marqueeStart = null;
			return;
		}

		// A shift+click on a selected node that never turned into a drag is
		// the deselect gesture.
		if (pendingShiftToggle !== null) {
			editor.deselectNode(pendingShiftToggle);
			pendingShiftToggle = null;
		}

		// Moving things never splits segments — crossings only become
		// intersections while drawing.
		if (isDragging) {
			editor.graph.save();
		}
		isDragging = false;
		dragTarget = null;
		controlFrames.clear();
	};

	// Double-clicking a junction (3+ arms) opens the lane connector for it.
	const onDoubleClick = (event: MouseEvent) => {
		if (event.button !== 0) return;
		const worldPos = editor.sceneManager.screenToWorld(event.clientX, event.clientY);
		const { node } = nodeHitAt(editor, worldPos.x, worldPos.z);
		if (node && node.connectedSegments.length >= 3) {
			editor.enterConnectorMode(node.id);
		}
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
		setbackDrag = null;
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
		onDoubleClick,
		onKeyDown,
		cleanup
	};
}
