import { getContext, setContext } from 'svelte';
import { Graph } from '$lib/graph/graph.svelte';
import { setMode } from '$lib/canvas';
import type { Canvas } from 'fabric';

const CONTEXT_KEY = 'graph';

export class GraphContext {
	graph: Graph;
	canvas: Canvas | null = null;
	mode = $state<'draw' | 'edit' | undefined>(undefined);

	constructor() {
		this.graph = new Graph();

		$effect(() => {
			setMode(this.mode);
		});
	}

	setCanvas(canvas: Canvas) {
		this.canvas = canvas;
	}

	get hasSegments() {
		return this.graph.segments.size > 0;
	}
}

export function setGraphContext() {
	const context = new GraphContext();
	setContext(CONTEXT_KEY, context);
	return context;
}

export function getGraphContext() {
	const context = getContext<GraphContext>(CONTEXT_KEY);
	if (!context) {
		throw new Error('Graph context not found. Make sure to call setGraphContext() first.');
	}
	return context;
}
