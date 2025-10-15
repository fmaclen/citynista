<script lang="ts">
	interface Props {
		onLoad: () => void;
	}

	let { onLoad }: Props = $props();
</script>

<div class="fixed top-4 left-4 z-50">
	<button
		class="rounded-lg border-2 border-white/50 bg-black/70 px-4 py-2 text-white transition-all duration-200 hover:border-white/80 hover:bg-black/85"
		onclick={onLoad}
	>
		Load OSM Sample
	</button>
</div>
