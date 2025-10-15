<script lang="ts">
	import TractorIcon from '@lucide/svelte/icons/tractor';
	import { Button } from '$lib/components/ui/button';
	import { getGraphContext } from '$lib/context/graph.svelte';

	const ctx = getGraphContext();

	let hasSegments = $derived(ctx.hasSegments);

	function handleClear() {
		if (confirm('Are you sure you want to clear all segments? This cannot be undone.')) {
			if (ctx.canvas) {
				ctx.graph.clear();
				ctx.canvas.clear();
				ctx.canvas.backgroundColor = '#2a2a2a';
				ctx.canvas.renderAll();
			}
		}
	}
</script>

<Button
	variant="outline"
	size="icon-lg"
	disabled={!hasSegments}
	onclick={handleClear}
	aria-label="Clear All"
>
	<TractorIcon class="size-5" />
</Button>
