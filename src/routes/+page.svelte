<script lang="ts">
	import { setEditorContext } from '$lib/editor.svelte';
	import EditorToolbar from '$lib/components/EditorToolbar.svelte';

	let canvasElement: HTMLCanvasElement;
	const editor = setEditorContext();

	// HACK: Prevent $effect from re-running when graph changes (e.g., after clearAll).
	// Without this, loadSavedData() gets called multiple times, reloading stale data from localStorage.
	// Unable to reliably test this timing-dependent bug in Playwright.
	let initialized = false;

	$effect(() => {
		if (!canvasElement || initialized) return;

		editor.initCanvas(canvasElement);
		editor.loadSavedData();
		initialized = true;
	});
</script>

<svelte:head>
	<title>Citynista</title>
</svelte:head>

<div class="h-screen w-screen overflow-hidden bg-[#2a2a2a]">
	<EditorToolbar />
	<canvas id="canvas" bind:this={canvasElement}></canvas>
</div>
