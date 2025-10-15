<script lang="ts">
	interface Props {
		onModeToggle: () => void;
		onClear: () => void;
	}

	let { onModeToggle, onClear }: Props = $props();

	let isDrawMode = $state(true);

	function handleModeToggle() {
		isDrawMode = !isDrawMode;
		onModeToggle();
	}

	function handleClear() {
		if (confirm('Are you sure you want to clear all segments? This cannot be undone.')) {
			onClear();
		}
	}
</script>

<div class="fixed top-4 right-4 z-50 flex gap-3">
	<button
		class="rounded-lg border-2 px-5 py-2.5 text-sm transition-all duration-200 {isDrawMode
			? 'border-white bg-white/90 text-gray-900'
			: 'border-white/50 bg-black/70 text-white hover:border-white/80 hover:bg-black/85'}"
		onclick={handleModeToggle}
	>
		{isDrawMode ? 'Draw Mode' : 'Edit Mode'}
	</button>
	<button
		class="rounded-lg border-2 border-red-400/50 bg-red-900/70 px-5 py-2.5 text-sm text-white transition-all duration-200 hover:border-red-400/80 hover:bg-red-800/85"
		onclick={handleClear}
	>
		Clear All
	</button>
</div>
