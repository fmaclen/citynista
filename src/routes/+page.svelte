<script lang="ts">
	import EditorToolbar from '$lib/components/EditorToolbar.svelte';
	import { setGraphContext } from '$lib/context/graph.svelte';
	import { Graph } from '$lib/graph/graph.svelte';
	import { setupCanvas } from '$lib/canvas';
	import { restoreGraph } from '$lib/graph/restore';

	let canvasElement: HTMLCanvasElement;
	const ctx = setGraphContext();

	$effect(() => {
		if (!canvasElement) return;

		const canvas = setupCanvas(ctx.graph, canvasElement);
		ctx.setCanvas(canvas);

		const savedData = Graph.load();
		if (savedData) {
			restoreGraph(ctx.graph, canvas, savedData);
		}
	});
</script>

<svelte:head>
	<title>Citynista - Road Drawing</title>
</svelte:head>

<div class="h-screen w-screen overflow-hidden bg-[#2a2a2a]">
	<EditorToolbar />
	<canvas id="canvas" bind:this={canvasElement}></canvas>
</div>
