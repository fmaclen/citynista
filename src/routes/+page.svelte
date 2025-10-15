<script lang="ts">
	import { setEditorContext } from '$lib/editor.svelte';
	import EditorToolbar from '$lib/components/EditorToolbar.svelte';

	let canvasElement: HTMLCanvasElement;
	const editor = setEditorContext();

	$effect(() => {
		if (!canvasElement) return;

		editor.initCanvas(canvasElement);
		editor.loadSavedData();
	});
</script>

<svelte:head>
	<title>Citynista - Road Drawing</title>
</svelte:head>

<div class="h-screen w-screen overflow-hidden bg-[#2a2a2a]">
	<EditorToolbar />
	<canvas id="canvas" bind:this={canvasElement}></canvas>
</div>
