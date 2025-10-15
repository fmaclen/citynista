<script lang="ts">
	import SplineIcon from '@lucide/svelte/icons/spline';
	import { Button } from '$lib/components/ui/button';
	import { getGraphContext } from '$lib/context/graph.svelte';
	import { cn } from '$lib/utils';

	const ctx = getGraphContext();
	let isActive = $derived(ctx.mode === 'draw');

	function handleClick() {
		if (!isActive) {
			ctx.mode = 'draw';
		} else {
			ctx.mode = undefined;
		}
	}
</script>

<Button
	variant="outline"
	size="icon-lg"
	onclick={handleClick}
	aria-label="Draw Mode"
	class={cn('border-muted-foreground', isActive && 'bg-accent text-accent-foreground')}
>
	<SplineIcon class="size-5" />
</Button>
