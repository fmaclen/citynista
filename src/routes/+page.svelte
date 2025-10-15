<script lang="ts">
	import { onMount } from 'svelte';
	import EditorToolbar from '$lib/components/EditorToolbar.svelte';
	import OSMLoader from '$lib/components/OSMLoader.svelte';
	import { setGraphContext } from '$lib/context/graph.svelte';
	import { Graph } from '$lib/graph/graph.svelte';
	import { setupCanvas, setMode } from '$lib/canvas';
	import { restoreGraph } from '$lib/graph/restore';
	import { fetchOSMData } from '$lib/osm/import';
	import { importOSMToGraph } from '$lib/osm/import-to-graph';

	let canvasElement: HTMLCanvasElement;
	const ctx = setGraphContext();

	onMount(() => {
		const canvas = setupCanvas(ctx.graph);
		ctx.setCanvas(canvas);

		const savedData = Graph.load();
		if (savedData) {
			restoreGraph(ctx.graph, canvas, savedData);
		}
	});

	async function handleLoadOSM() {
		const osmData = await fetchOSMData(25.618, -80.3465, 25.62, -80.344);
		console.log('Loaded OSM data:', osmData);
		if (ctx.canvas) {
			importOSMToGraph(osmData, ctx.graph, ctx.canvas);
		}
	}
</script>

<svelte:head>
	<title>Citynista - Road Drawing</title>
</svelte:head>

<div class="h-screen w-screen overflow-hidden bg-[#2a2a2a]">
	<EditorToolbar />
	<OSMLoader onLoad={handleLoadOSM} />
	<canvas id="canvas" bind:this={canvasElement}></canvas>
</div>

<style>
	:global(body) {
		margin: 0;
		padding: 0;
		overflow: hidden;
	}
</style>
