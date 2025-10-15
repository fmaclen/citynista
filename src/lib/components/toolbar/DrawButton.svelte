<script lang="ts">
	import SplineIcon from '@lucide/svelte/icons/spline';
	import { Toggle } from '$lib/components/ui/toggle';
	import { setMode } from '$lib/canvas';

	let drawMode = $state(false);

	$effect(() => {
		if (drawMode) {
			setMode('draw');
		} else {
			setMode(null);
		}
	});
</script>

<Toggle
	variant="outline"
	size="lg"
	bind:pressed={drawMode}
	aria-label="Draw Mode"
	class="border-muted-foreground"
>
	<SplineIcon class="size-5 text-muted-foreground" />
</Toggle>
