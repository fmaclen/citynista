<script lang="ts">
	import { setEditorContext } from '$lib/editor.svelte';
	import EditorToolbar from '$lib/components/EditorToolbar.svelte';
	import FpsCounter from '$lib/components/FpsCounter.svelte';
	import LaneEditor from '$lib/components/LaneEditor.svelte';
	import { untrack } from 'svelte';

	let containerElement: HTMLDivElement;
	const editor = setEditorContext();

	$effect(() => {
		if (!containerElement) return;

		untrack(() => {
			editor.init(containerElement);
		});

		return () => {
			editor.dispose();
		};
	});
</script>

<svelte:head>
	<title>Citynista</title>
</svelte:head>

<div class="h-screen w-screen overflow-hidden bg-[#2a2a2a]">
	<EditorToolbar />
	<FpsCounter />
	<LaneEditor />
	<div bind:this={containerElement} class="h-full w-full"></div>
</div>
