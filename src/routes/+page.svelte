<script lang="ts">
	import { setEditorContext } from '$lib/editor.svelte';
	import EditorToolbar from '$lib/components/EditorToolbar.svelte';
	import CityBar from '$lib/components/CityBar.svelte';
	import FpsCounter from '$lib/components/FpsCounter.svelte';
	import LaneEditor from '$lib/components/LaneEditor.svelte';
	import NodeLabels from '$lib/components/NodeLabels.svelte';
	import { dumpLaneCorrespondence } from '$lib/dev/lane-harness';
	import { untrack } from 'svelte';

	let containerElement: HTMLDivElement;
	const editor = setEditorContext();

	$effect(() => {
		if (!containerElement) return;

		untrack(() => {
			const params = new URLSearchParams(window.location.search);
			const topdown = params.has('topdown');
			const fixture = params.get('fixture');
			const harness = params.get('harness');
			const cam = params.get('cam');

			void (async () => {
				// Skip loading the default city when a fixture is deep-linked.
				await editor.init(containerElement, !fixture);
				if (topdown) editor.sceneManager.setTopDown();

				if (fixture) {
					// ?fixture=<name> opens that city from disk (works in the prod
					// preview too, so the e2e harness renders the same graph).
					await editor.loadCityById(fixture);
				} else if (!topdown) {
					editor.restoreCityCamera();
				}

				if (harness === 'lane') {
					(window as Window & { __laneHarness?: () => unknown }).__laneHarness = () =>
						dumpLaneCorrespondence(editor.graph);
				}

				// ?cam=x,z,zoom is a headless-screenshot override (top-down, no persist).
				if (cam) {
					const [x, z, zoom] = cam.split(',').map(Number);
					if ([x, z, zoom].every((n) => Number.isFinite(n))) {
						editor.sceneManager.setScreenshotCamera(x, z, zoom);
					}
				}
			})();
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
	<CityBar />
	{#if import.meta.env.DEV}
		<NodeLabels />
	{/if}
	<div bind:this={containerElement} class="h-full w-full"></div>
</div>
