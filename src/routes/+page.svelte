<script lang="ts">
	import { onMount } from 'svelte';
	import Toolbar from '$lib/components/Toolbar.svelte';
	import OSMLoader from '$lib/components/OSMLoader.svelte';
	import { ReactiveGraph } from '$lib/graph/graph.svelte';
	import { setupCanvas, toggleMode } from '$lib/canvas';
	import { restoreGraph } from '$lib/graph/restore';
	import { fetchOSMData } from '$lib/osm/import';
	import { importOSMToGraph } from '$lib/osm/import-to-graph';
	import type { Canvas } from 'fabric';

	let canvasElement: HTMLCanvasElement;
	let graph: ReactiveGraph;
	let canvas: Canvas;

	onMount(() => {
		graph = new ReactiveGraph();
		canvas = setupCanvas(graph);

		const savedData = ReactiveGraph.load();
		if (savedData) {
			restoreGraph(graph, canvas, savedData);
		}
	});

	function handleModeToggle() {
		toggleMode();
	}

	function handleClear() {
		if (graph && canvas) {
			graph.clear();
			canvas.clear();
			canvas.backgroundColor = '#2a2a2a';
			canvas.renderAll();
		}
	}

	async function handleLoadOSM() {
		const osmData = await fetchOSMData(25.618, -80.3465, 25.62, -80.344);
		console.log('Loaded OSM data:', osmData);
		importOSMToGraph(osmData, graph, canvas);
	}
</script>

<svelte:head>
	<title>Citynista - Road Drawing</title>
</svelte:head>

<div class="h-screen w-screen overflow-hidden bg-[#2a2a2a]">
	<Toolbar onModeToggle={handleModeToggle} onClear={handleClear} />
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
