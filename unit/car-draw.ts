import { createLanesFrom } from '../src/lib/core/lane-template';
import type { GraphData } from '../src/lib/core/types';

// Car-only draw gestures, each done with the Street preset on a street along
// y = 0 (or a curved, shifted avenue) through a driver: the editor in Node
// (unit/car-draw.test.ts) or the page (e2e/car-draw.test.ts). What each
// leaves is recorded twice: in e2e/car-draw.json as the page drew it before
// footpaths were a network of their own, and in unit/car-draw.json as the
// editor in Node draws it.

export const FILE = 'unit/car-draw.json';

const base: GraphData = {
	nodes: [
		{ id: 'w', x: -65, y: 0 },
		{ id: 'e', x: 65, y: 0 }
	],
	segments: [{ id: 'street', startNodeId: 'w', endNodeId: 'e', lanes: createLanesFrom('street') }]
};
// An avenue bowed north and shown 5 m right of its line.
const shifted: GraphData = {
	nodes: [
		{ id: 'w', x: -45, y: 0 },
		{ id: 'e', x: 45, y: 0 }
	],
	segments: [
		{
			id: 'avenue',
			startNodeId: 'w',
			endNodeId: 'e',
			lanes: createLanesFrom('avenue'),
			controlX: 5,
			controlY: 12,
			offsetStart: 5,
			offsetEnd: 5
		}
	]
};

// What a gesture does, in world metres at the top-down camera at zoom 4: a
// click (the pointer moved there first), the pointer moved in four steps,
// the Street preset armed in a draw style, Escape twice, Undo, Redo, the
// Split tool armed, one Escape, and the toolbar's Join on the selected node.
export interface Driver {
	street(style?: 'Straight' | 'Curve'): Promise<void>;
	click(x: number, y: number): Promise<void>;
	hover(x: number, y: number): Promise<void>;
	escape(): Promise<void>;
	undo(): Promise<void>;
	redo(): Promise<void>;
	split(): Promise<void>;
	key(name: 'Escape'): Promise<void>;
	join(): Promise<void>;
}
// What a gesture notes on the way, under a label: the graph as it stands,
// or the roads the preview lays.
export type Note = (label: string, what?: 'graph' | 'preview') => Promise<void>;
export type Gesture = { graph: GraphData; run: (d: Driver, note: Note) => Promise<void> };

const on = (run: Gesture['run'], graph = base): Gesture => ({ graph, run });
export const gestures: Record<string, Gesture> = {
	'one road': on(async (d, note) => {
		await d.street();
		await d.click(-30, 20);
		await d.hover(10, 25);
		await note('preview', 'preview');
		await d.click(10, 25);
		await d.escape();
	}),
	'a chain': on(async (d) => {
		await d.street();
		await d.click(-30, 20);
		await d.click(0, 25);
		await d.click(25, 12);
		await d.escape();
	}),
	'a curved chain from the street': on(async (d, note) => {
		await d.street('Curve');
		await d.click(-20, 0);
		await d.hover(-10, 25);
		await note('preview from the cut', 'preview');
		await d.click(-10, 25);
		await d.hover(20, 30);
		await note('preview on', 'preview');
		await d.click(20, 30);
		await d.escape();
	}),
	'two clicks on one spot of the street': on(async (d) => {
		await d.street();
		await d.click(0, 0);
		await d.click(0, 0);
		await d.escape();
	}),
	'a second click 3 px away': on(async (d) => {
		await d.street();
		await d.click(0, 0);
		await d.click(0.5, 0);
		await d.escape();
	}),
	'the start clicked again, then a road laid': on(async (d) => {
		await d.street();
		await d.click(0, 0);
		await d.click(0.5, 0);
		await d.click(0, 25);
		await d.escape();
	}),
	'a road from the street': on(async (d, note) => {
		await d.street();
		await d.click(0, 0);
		await note('cut');
		await d.hover(0, 25);
		await note('preview', 'preview');
		await d.hover(30, 0);
		await note('preview along the street', 'preview');
		await d.click(0, 25);
		await d.escape();
	}),
	'a start on the street escaped': on(async (d) => {
		await d.street();
		await d.click(0, 0);
		await d.escape();
	}),
	'undo with a start pending and no history': on(async (d, note) => {
		await d.street();
		await d.click(0, 0);
		await d.undo();
		await note('undo');
		await d.redo();
		await note('redo');
		await d.click(0, 25);
		await d.click(20, 25);
		await d.escape();
	}),
	'undo with a start pending after a road': on(async (d, note) => {
		await d.street();
		await d.click(-35, 20);
		await d.click(-20, 25);
		await d.escape();
		await d.street();
		await d.click(0, 0);
		await d.undo();
		await note('undo');
		await d.redo();
		await note('redo');
		await d.click(0, 25);
		await d.click(20, 25);
		await d.escape();
	}),
	'undo and redo a chain from a cut': on(async (d, note) => {
		await d.street();
		await d.click(-18, 0);
		await d.click(-18, 26);
		await d.click(15, 33);
		await d.undo();
		await note('undo');
		await d.undo();
		await note('undo twice');
		await d.redo();
		await note('redo');
		await d.redo();
		await note('redo twice');
		await d.escape();
	}),
	'redo with a new start on the street': on(async (d, note) => {
		await d.street();
		await d.click(-19, 20);
		await d.click(14, 24);
		await d.undo();
		await note('undo');
		await d.click(-3, 0);
		await d.redo();
		await note('redo');
		await d.click(1, -22);
		await d.click(30, -25);
		await d.escape();
	}),
	'a loop closed on the street': on(async (d) => {
		await d.street();
		await d.click(-10, 0);
		await d.click(-15, 23);
		await d.click(10, 23);
		await d.click(-10, 0);
		await d.escape();
	}),
	'two cuts on a curved shifted avenue': on(async (d, note) => {
		await d.street('Curve');
		await d.click(-24, 9);
		await d.hover(25, 11);
		await note('preview', 'preview');
		await d.click(25, 11);
		await note('second cut');
		await d.click(10, 32);
		await d.escape();
	}, shifted),
	'a cut': on(async (d) => {
		await d.split();
		await d.click(35, 0);
		await d.key('Escape');
	}),
	'a cut joined again': on(async (d) => {
		await d.split();
		await d.click(35, 0);
		await d.key('Escape');
		await d.click(35, 0);
		await d.join();
		await d.key('Escape');
	})
};

// A graph with its segments by id, in any order: a cut lists its halves
// where the road was (Graph.putAt).
export const byId = (graph: GraphData) => ({
	...graph,
	segments: [...graph.segments].sort((a, b) => (a.id < b.id ? -1 : 1))
});

// The roads a preview lays among those it copies, by their ends, in any
// order.
export const previewOf = (graph: GraphData | undefined) => {
	const nodes = new Map(graph?.nodes.map((n) => [n.id, n]));
	return (graph?.segments ?? [])
		.map((s) => [nodes.get(s.startNodeId), nodes.get(s.endNodeId)])
		.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
};
