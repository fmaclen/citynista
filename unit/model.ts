import { readFileSync } from 'node:fs';
import { attachShift } from '../src/lib/core/attach';
import { serializeLanes } from '../src/lib/core/lane-template';
import { PlaceBuilder } from '../src/lib/core/place';
import type { GraphData } from '../src/lib/core/types';
import { crossSection, frameAt, offsetPoint, samplePath } from '../src/lib/road-model/geometry';
import type { Road } from '../src/lib/road-model/model';
import { Drawing } from '../src/lib/road-model/drawing';

// Reading a plain saved graph in Node, without the browser: the road model
// the editor would draw from it, and points on it.

// Test-only graphs live in e2e/scenes/, outside anything the app serves.
export function readScene(name: string): GraphData {
	return JSON.parse(readFileSync(`e2e/scenes/${name}.json`, 'utf8'));
}

export const nodeOf = (graph: GraphData, id: string) => graph.nodes.find((n) => n.id === id)!;
export const segmentOf = (graph: GraphData, id: string) => graph.segments.find((s) => s.id === id)!;

// A saved graph in the shape the editor's live graph has: nodes listing
// their roads, segments with their lanes keyed and their shifts filled in.
export function liveShape(data: GraphData) {
	const nodes = new Map(data.nodes.map((n) => [n.id, { ...n, connectedSegments: [] as string[] }]));
	const segments = new Map(
		data.segments.map((s) => [
			s.id,
			{
				...s,
				hasControlPoint: s.controlX !== undefined && s.controlY !== undefined,
				offsetStart: s.offsetStart ?? 0,
				offsetEnd: s.offsetEnd ?? 0,
				lanesKey: serializeLanes(s.lanes),
				totalWidth: s.lanes.reduce((a, l) => a + l.width, 0)
			}
		])
	);
	for (const s of segments.values()) {
		nodes.get(s.startNodeId)!.connectedSegments.push(s.id);
		nodes.get(s.endNodeId)!.connectedSegments.push(s.id);
	}
	return { nodes, segments };
}

// The road model and its drawing, built the way the editor builds them.
export function buildModel(graph: GraphData) {
	const derived = new PlaceBuilder().build(liveShape(graph) as never);
	const scene = new Drawing(derived.place, derived.geos);
	scene.build();
	return { derived, scene };
}

// The editor's renderer without Three.js (rendering/road-renderer.ts, update):
// one PlaceBuilder and one Drawing kept across builds, so the caches are
// exercised as a drag exercises them.
export function editorDrawing(builder = new PlaceBuilder()) {
	let scene: Drawing | null = null;
	return (graph: ReturnType<typeof liveShape>) => {
		const derived = builder.build(graph as never);
		scene ??= new Drawing(derived.place, derived.geos);
		scene.place = derived.place;
		scene.geos = derived.geos;
		scene.build();
		return scene;
	};
}

// What the renderer is handed (rendering/road-renderer.ts, update), by piece:
// each road's description, and each junction's ends and description. A
// node's ends leave out the roads they belong to (whose keys are build
// counters): each road is a piece of its own.
export function pieces(scene: Drawing) {
	const out = new Map<string, unknown>();
	for (const r of scene.place.roads) out.set(`road:${r.id}`, scene.road(r.id));
	for (const j of scene.place.junctions) {
		const node = scene.node(j.id);
		out.set(`junction:${j.id}`, {
			ends: j.ends,
			description: node && { ...node, ends: node.ends.map((e) => ({ ...e, geo: undefined })) }
		});
	}
	return out;
}

// Where a road's end at `nodeId` shows: the node, moved to the edge it is
// attached at (core/attach.ts).
export function attachedEnd(data: GraphData, segmentId: string, nodeId: string) {
	const graph = liveShape(data);
	const node = graph.nodes.get(nodeId)!;
	const shift = attachShift(graph as never, graph.segments.get(segmentId)!, nodeId);
	return { x: node.x + shift.x, y: node.y + shift.y };
}

// The middle of a road's cross-section as drawn, at a fraction of its length.
export function drawnCentre(road: Road, f: number) {
	const path = samplePath(road);
	const d = path.length * f;
	const frame = frameAt(path, d);
	const spans = crossSection(road, d);
	return offsetPoint(frame.p, frame.n, (spans[0].left + spans.at(-1)!.right) / 2);
}
