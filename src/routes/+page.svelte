<script lang="ts">
	import { setEditorContext } from '$lib/editor.svelte';
	import EditorToolbar from '$lib/components/EditorToolbar.svelte';
	import FixtureBar from '$lib/components/FixtureBar.svelte';
	import FpsCounter from '$lib/components/FpsCounter.svelte';
	import LaneEditor from '$lib/components/LaneEditor.svelte';
	import { untrack } from 'svelte';

	let containerElement: HTMLDivElement;
	const editor = setEditorContext();

	$effect(() => {
		if (!containerElement) return;

		untrack(() => {
			editor.init(containerElement);

			// Boot straight into a shared fixture: works in dev and preview
			// (fixtures are static assets), so the e2e harness and a browser
			// session render the exact same graph.
			const params = new URLSearchParams(window.location.search);
			if (params.has('topdown')) {
				editor.sceneManager.setTopDown();
			}
			const fixture = params.get('fixture');
			if (fixture) {
				fetch(`/fixtures/${fixture}.json`)
					.then((response) => (response.ok ? response.json() : null))
					.then((data) => {
						if (data) editor.replaceGraph(data);
					});
			}
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
	{#if import.meta.env.DEV}
		<FixtureBar />
	{/if}
	<div bind:this={containerElement} class="h-full w-full"></div>
</div>
