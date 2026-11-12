<script lang="ts">
	import { setEditorContext } from '$lib/editor.svelte';
	import EditorToolbar from '$lib/components/EditorToolbar.svelte';
	import CityBar from '$lib/components/CityBar.svelte';
	import FpsCounter from '$lib/components/FpsCounter.svelte';
	import LaneEditor from '$lib/components/LaneEditor.svelte';
	import NodeLabels from '$lib/components/NodeLabels.svelte';
	import ControlBadges from '$lib/components/ControlBadges.svelte';
	import { untrack } from 'svelte';

	let containerElement: HTMLDivElement;
	const editor = setEditorContext();

	$effect(() => {
		if (!containerElement) return;

		untrack(() => {
			const params = new URLSearchParams(window.location.search);
			const topdown = params.has('topdown');
			const example = params.get('example');
			const cam = params.get('cam');

			void (async () => {
				// Skip loading the default city when an example is deep-linked.
				await editor.init(containerElement, !example);
				if (topdown) editor.sceneManager.setTopDown();

				if (example) {
					// ?example=<id> opens a read-only example, untouched.
					await editor.openExample(example);
				} else if (!topdown) {
					editor.restoreCityCamera();
				}

				// ?stats exposes render costs for headless/headed perf runs.
				if (params.has('stats')) {
					const w = window as Window & {
						__renderStats?: () => unknown;
						__perfMove?: (what: string) => void;
					};
					w.__renderStats = () => editor.renderStats();
					w.__perfMove = (what) => editor.perfMove(what);
				}

				// ?model exposes the road model the drawing runs on, for scripts.
				if (params.has('model')) {
					const w = window as Window & {
						__roadModel?: () => unknown;
						__graph?: () => unknown;
						__ghostGraph?: () => unknown;
						__ghostModel?: () => unknown;
					};
					w.__roadModel = () => editor.roadRenderer.derived?.place;
					w.__graph = () => editor.graph.toJSON();
					w.__ghostGraph = () => editor.ghost?.graph.toJSON();
					w.__ghostModel = () => editor.ghost?.renderer.derived?.place;
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
	<ControlBadges />
	{#if import.meta.env.DEV}
		<NodeLabels />
	{/if}
	<div bind:this={containerElement} class="h-full w-full"></div>
</div>
