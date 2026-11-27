import type { Editor } from './editor.svelte';
import type { Graph } from './core/graph.svelte';
import type { JunctionData, Lane, NodeData, SegmentData } from './core/types';
import { cloneLanes } from './core/lane-template';
import { mapJunction } from './core/junction-data';
import { outOf } from './core/segment-curve';
import { carries } from './core/lane-types';
import { copyControl } from './core/crossing-controls';
import type { Node } from './core/node.svelte';
import { type Pt, shownAt, shownOff } from './core/road-line';
import { AT_ONE_SPOT } from './modes/picking';

// Copied roads as saved, with their nodes (junction edits naming the copied
// roads by their old ids), to place as a floating copy or to paste their
// lanes onto other roads.
export interface SegmentClipboard {
	kind: 'segments';
	nodes: NodeData[];
	segments: SegmentData[];
}

// A car node's junction edits with its roads named by their order round the
// node (`arm0`, `arm1`, …) and lanes by their place on the road, to paste
// onto another car node with as many roads. A footpath node holds none.
interface NodeClipboard {
	kind: 'node';
	arms: number;
	junction: JunctionData;
}

// Whether the roads at a node are car roads (a node holds one kind,
// core/separate.ts), and whether they are footpaths, none of them a car road.
export const carRoads = (roads: readonly { lanes: readonly Lane[] }[]) =>
	roads.some((s) => carries(s.lanes));
const walksOnly = (roads: readonly { lanes: readonly Lane[] }[]) =>
	roads.length > 0 && !carRoads(roads);

// The roads at a node of a graph, and at a copied node among the roads copied.
export const roadsAt = (graph: Graph, nodeId: string) =>
	(graph.nodes.get(nodeId)?.connectedSegments ?? []).flatMap((id) => graph.segments.get(id) ?? []);
export const roadsOf = (clipboard: SegmentClipboard, nodeId: string) =>
	clipboard.segments.filter((s) => s.startNodeId === nodeId || s.endNodeId === nodeId);

export type Clipboard = SegmentClipboard | NodeClipboard;

// The selected roads, or else the one selected node's junction edits; null
// when there is nothing to copy.
export function copySelection(editor: Editor): Clipboard | null {
	if (editor.selectedSegments.size > 0) return copySegments(editor);
	if (editor.selectedNodes.size === 1) return copyNodeConnections(editor);
	return null;
}

export function copySegments(editor: {
	graph: Graph;
	selectedSegments: Iterable<string>;
}): SegmentClipboard | null {
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
	if (!node?.junction || !carRoads(roadsAt(editor.graph, node.id))) return null;
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

// The copied road's lanes onto every selected road, as one edit
// (Graph.setLanes), each lane the copied road's and none the road's own,
// whatever its id.
function pasteLanes(editor: Editor, clipboard: SegmentClipboard) {
	const source = clipboard.segments[0];
	if (!source) return;
	editor.graph.setLanes(
		[...editor.selectedSegments].flatMap((id) => {
			const segment = editor.graph.segments.get(id);
			return segment ? [[segment, cloneLanes(source.lanes)] as const] : [];
		}),
		true
	);
	editor.rebuildRoads();
	editor.refreshSelectionVisuals();
	editor.graph.save();
}

function pasteNodeConnections(editor: Editor, clipboard: NodeClipboard) {
	const node = editor.graph.nodes.get([...editor.selectedNodes][0]);
	if (!node) return;
	const arms = sortedArms(editor, node.id);
	if (arms.length !== clipboard.arms || !carRoads(roadsAt(editor.graph, node.id))) return;
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

export interface Translation {
	dx: number;
	dy: number;
}

// Where copied roads are laid: moved by `translation`, and one copied node
// (`snap`) laid onto an existing node instead.
export interface Placement {
	translation: Translation;
	snap: { clipboardNodeId: string; existingNodeId: string } | null;
}

// How far each copied node of footpaths shows from where it lies, as it
// will once pasted: its copied footpaths' shown ends there, met as
// `nodePoint` meets a node's roads (core/road-line.ts). The same wherever
// the copy is laid.
export function shownOffsets(clipboard: SegmentClipboard) {
	const byId = new Map(clipboard.nodes.map((n) => [n.id, n]));
	const out = new Map<string, Pt>();
	for (const node of clipboard.nodes) {
		const own = roadsOf(clipboard, node.id);
		if (!walksOnly(own)) continue;
		let [x, y, n] = [0, 0, 0];
		for (const s of own) {
			const [a, b] = [byId.get(s.startNodeId), byId.get(s.endNodeId)];
			if (!a || !b || a === b) continue;
			const shifted = { ...s, offsetStart: s.offsetStart ?? 0, offsetEnd: s.offsetEnd ?? 0 };
			const p = shownAt(shifted, a, b, s.startNodeId === node.id ? 0 : 1).point;
			x += p.x - node.x;
			y += p.y - node.y;
			n++;
		}
		out.set(node.id, n ? { x: x / n, y: y / n } : { x: 0, y: 0 });
	}
	return out;
}

// Whether a copied node of footpaths showing `off` from where it lies,
// laid at the spot of `node`, shows where `node` does (within AT_ONE_SPOT,
// as a footpath's end drawn there lands on it: modes/draw.ts): so landing
// on it moves nothing drawn.
export const showsWith = (graph: Graph, node: Node, off: Pt) => {
	const own = shownOff(graph, node);
	return Math.hypot(own.x - off.x, own.y - off.y) < AT_ONE_SPOT;
};

// Lays the copied roads into `graph` where the placement puts them, a copied
// node it snaps onto taking the existing node's place (a node holding the
// other kind of road gives them one of their own there, Graph.createSegment),
// and with `edits` each new car node keeping its junction edits on the
// copied roads; a footpath node holds none. A copied node of footpaths laid
// at the spot of a footpath node, and showing where it does, lands on it, as
// a footpath's end drawn there does: no two footpath nodes lie and show at
// one spot, and one shifted off where it lies keeps a node of its own.
// Returns the new id of each copied node and road.
export function layPaste(
	graph: Graph,
	clipboard: SegmentClipboard,
	placement: Placement,
	edits = false
) {
	const nodeIds = new Map<string, string>();
	const segmentIds = new Map<string, string>();
	const offsets = shownOffsets(clipboard);
	const walkNodeAt = (x: number, y: number, off: Pt) => {
		for (const node of graph.nodes.values()) {
			if (Math.hypot(node.x - x, node.y - y) >= AT_ONE_SPOT) continue;
			if (walksOnly(roadsAt(graph, node.id)) && showsWith(graph, node, off)) return node.id;
		}
		return null;
	};
	for (const snapshot of clipboard.nodes) {
		if (placement.snap?.clipboardNodeId === snapshot.id) {
			nodeIds.set(snapshot.id, placement.snap.existingNodeId);
			continue;
		}
		const at = {
			x: snapshot.x + placement.translation.dx,
			y: snapshot.y + placement.translation.dy
		};
		const off = offsets.get(snapshot.id);
		const onto = off ? walkNodeAt(at.x, at.y, off) : null;
		nodeIds.set(snapshot.id, onto ?? graph.createNode(at.x, at.y).id);
	}
	for (const snapshot of clipboard.segments) {
		const startNodeId = nodeIds.get(snapshot.startNodeId);
		const endNodeId = nodeIds.get(snapshot.endNodeId);
		if (!startNodeId || !endNodeId || startNodeId === endNodeId) continue;
		const segment = graph.createSegment(startNodeId, endNodeId, cloneLanes(snapshot.lanes));
		segmentIds.set(snapshot.id, segment.id);
		if (startNodeId !== segment.startNodeId) nodeIds.set(snapshot.startNodeId, segment.startNodeId);
		if (endNodeId !== segment.endNodeId) nodeIds.set(snapshot.endNodeId, segment.endNodeId);
		segment.offsetStart = snapshot.offsetStart ?? 0;
		segment.offsetEnd = snapshot.offsetEnd ?? 0;
		if (snapshot.controlX !== undefined && snapshot.controlY !== undefined) {
			segment.setControlPoint(
				snapshot.controlX + placement.translation.dx,
				snapshot.controlY + placement.translation.dy
			);
		}
	}
	// Each footpath's crossing controls, naming a car road pasted with it by
	// its copy and any other by its own, and the carriageway by its car
	// lanes, whose ids a pasted road keeps (core/crossing-controls.ts): a
	// control of a carriageway the copy does not cross is dropped on saving.
	for (const snapshot of clipboard.segments) {
		const segment = graph.segments.get(segmentIds.get(snapshot.id) ?? '');
		if (!segment || carries(segment.lanes) || !snapshot.controls?.length) continue;
		segment.controls = snapshot.controls.map((c) => ({
			...copyControl(c),
			roads: c.roads.map((r) => segmentIds.get(r) ?? r)
		}));
	}
	if (edits)
		for (const snapshot of clipboard.nodes) {
			const node = graph.nodes.get(nodeIds.get(snapshot.id) ?? '');
			if (
				!node ||
				!snapshot.junction ||
				offsets.has(snapshot.id) ||
				placement.snap?.clipboardNodeId === snapshot.id
			)
				continue;
			node.junction = mapJunction(snapshot.junction, (road, end) => {
				const id = segmentIds.get(road);
				return id ? { road: id, end } : null;
			});
		}
	return { nodeIds, segmentIds };
}
