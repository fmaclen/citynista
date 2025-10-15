<script lang="ts">
	import MapPlusIcon from '@lucide/svelte/icons/map-plus';
	import { Button } from '$lib/components/ui/button';
	import { getGraphContext } from '$lib/context/graph.svelte';
	import { fetchOSMData } from '$lib/osm/import';
	import { importOSMToGraph } from '$lib/osm/import-to-graph';

	const ctx = getGraphContext();

	async function handleLoadOSM() {
		const osmData = await fetchOSMData(25.618, -80.3465, 25.62, -80.344);
		console.log('Loaded OSM data:', osmData);
		if (ctx.canvas) {
			importOSMToGraph(osmData, ctx.graph, ctx.canvas);
		}
	}
</script>

<Button variant="outline" size="icon-lg" onclick={handleLoadOSM} aria-label="Load OSM Data">
	<MapPlusIcon class="size-5" />
</Button>
