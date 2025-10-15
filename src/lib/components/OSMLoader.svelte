<script lang="ts">
	interface Props {
		onLoad: () => void;
	}

	let { onLoad }: Props = $props();
</script>

<div class="fixed top-4 left-4 z-50">
	<button
		class="px-4 py-2 rounded-lg bg-black/70 text-white border-2 border-white/50 hover:border-white/80 hover:bg-black/85 transition-all duration-200"
		onclick={onLoad}
	>
		Load OSM Sample
	</button>
</div>
