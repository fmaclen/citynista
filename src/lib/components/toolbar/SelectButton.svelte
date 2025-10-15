<script lang="ts">
	import SquareDashedMousePointerIcon from '@lucide/svelte/icons/square-dashed-mouse-pointer';
	import { Toggle } from '$lib/components/ui/toggle';
	import { setMode } from '$lib/canvas';

	let selectMode = $state(false);

	$effect(() => {
		if (selectMode) {
			setMode('edit');
		} else {
			setMode(null);
		}
	});
</script>

<Toggle
	variant="outline"
	size="lg"
	bind:pressed={selectMode}
	aria-label="Select Mode"
	class="bg-background"
>
	<SquareDashedMousePointerIcon class="size-5" />
</Toggle>
