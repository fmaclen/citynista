import type { Editor } from './editor.svelte';
import type { JunctionData, NodeData, SegmentData } from './core/types';
import { cloneLanes } from './core/lane-template';
import { mapJunction } from './core/junction-data';
import { outOf } from './core/segment-curve';

// Copied roads as saved, with their nodes (junction edits naming the copied
// roads by their old ids), to place as a floating copy or to paste their
// lanes onto other roads.
export interface SegmentClipboard {
	kind: 'segments';
	nodes: NodeData[];
	segments: SegmentData[];
}

// A node's junction edits with its roads named by their order round the
// node (`arm0`, `arm1`, …) and lanes by their place on the road, to paste
// onto another node with as many roads.
interface NodeClipboard {
	kind: 'node';
	arms: number;
	junction: JunctionData;
}

export type Clipboard = SegmentClipboard | NodeClipboard;

// The selected roads, or else the one selected node's junction edits; null
// when there is nothing to copy.
export function copySelection(editor: Editor): Clipboard | null {
	if (editor.selectedSegments.size > 0) return copySegments(editor);
	if (editor.selectedNodes.size === 1) return copyNodeConnections(editor);
	return null;
}

export function copySegments(editor: Editor): SegmentClipboard | null {
	const { graph } = editor;
	const nodes = new Map<string, NodeData>();
	const segments: SegmentData[] = [];
	for (const id of editor.selectedSegments) {
		const segment = graph.segments.get(id);
		const ends = segment && [segment.startNodeId, segment.endNodeId].map((n) => graph.nodes.get(n));
		if (!segment || !ends?.[0] || !ends[1]) continue;
		for (const node of ends) if (node && !nodes.has(node.id)) nodes.set(node.id, node.toJSON());
		segments.push(segment.toJSON());
	}
	return segments.length ? { kind: 'segments', nodes: [...nodes.values()], segments } : null;
}

// A node's roads in order of the angle they leave it at (straight toward
// the far node where a curve's control point sits on the node).
function sortedArms(editor: Editor, nodeId: string) {
	const { graph } = editor;
	const node = graph.nodes.get(nodeId);
	const arms: { segmentId: string; angle: number }[] = [];
	for (const segmentId of node?.connectedSegments ?? []) {
		const segment = graph.segments.get(segmentId);
		const far =
			segment &&
			graph.nodes.get(segment.startNodeId === nodeId ? segment.endNodeId : segment.startNodeId);
		if (!node || !segment || !far) continue;
		const out = outOf(graph, segment, nodeId) ?? { x: far.x - node.x, y: far.y - node.y };
		arms.push({ segmentId, angle: Math.atan2(out.y, out.x) });
	}
	return arms.sort((a, b) => a.angle - b.angle).map((a) => a.segmentId);
}

function copyNodeConnections(editor: Editor): NodeClipboard | null {
	const node = editor.graph.nodes.get([...editor.selectedNodes][0]);
	if (!node?.junction) return null;
	const arms = sortedArms(editor, node.id);
	const junction = mapJunction(
		node.junction,
		(road, end) => {
			const index = arms.indexOf(road);
			return index < 0 ? null : { road: `arm${index}`, end };
		},
		(road, lane) => {
			const index = editor.graph.segments.get(road)?.lanes.findIndex((l) => l.id === lane) ?? -1;
			return index < 0 ? null : String(index);
		}
	);
	return junction ? { kind: 'node', arms: arms.length, junction } : null;
}

// Pastes onto the selection: a node's junction edits onto the one selected
// node with as many roads; copied lanes onto selected roads other than the
// ones copied; else the copied roads to place as a floating copy.
export function paste(editor: Editor, clipboard: Clipboard) {
	if (clipboard.kind === 'node') {
		if (editor.selectedNodes.size === 1 && editor.selectedSegments.size === 0) {
			pasteNodeConnections(editor, clipboard);
		}
		return;
	}
	// Pasting onto (only) the roads just copied means "make a floating copy".
	const copiedIds = clipboard.segments.map((segment) => segment.id);
	if ([...editor.selectedSegments].some((id) => !copiedIds.includes(id))) {
		pasteLanes(editor, clipboard);
		return;
	}
	editor.startPlacement(clipboard);
}

function pasteLanes(editor: Editor, clipboard: SegmentClipboard) {
	const source = clipboard.segments[0];
	if (!source) return;
	for (const id of editor.selectedSegments) {
		const segment = editor.graph.segments.get(id);
		if (segment) segment.lanes = cloneLanes(source.lanes);
	}
	editor.rebuildRoads();
	editor.refreshSelectionVisuals();
	editor.graph.save();
}

function pasteNodeConnections(editor: Editor, clipboard: NodeClipboard) {
	const node = editor.graph.nodes.get([...editor.selectedNodes][0]);
	if (!node) return;
	const arms = sortedArms(editor, node.id);
	if (arms.length !== clipboard.arms) return;
	const segmentOf = (road: string) => editor.graph.segments.get(arms[Number(road.slice(3))] ?? '');
	node.junction = mapJunction(
		clipboard.junction,
		(road) => {
			const segment = segmentOf(road);
			if (!segment) return null;
			return { road: segment.id, end: segment.startNodeId === node.id ? 'start' : 'end' };
		},
		(road, lane) => segmentOf(road)?.lanes[Number(lane)]?.id ?? null
	);
	editor.rebuildRoads();
	editor.graph.save();
}
