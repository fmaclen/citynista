<script lang="ts">
	import SquareDashedMousePointerIcon from '@lucide/svelte/icons/square-dashed-mouse-pointer';
	import { Button } from '$lib/components/ui/button';
	import { getGraphContext } from '$lib/context/graph.svelte';
	import { cn } from '$lib/utils';

	const ctx = getGraphContext();
	let isActive = $derived(ctx.mode === 'edit');

	function handleClick() {
		if (!isActive) {
			ctx.mode = 'edit';
		} else {
			ctx.mode = undefined;
		}
	}
</script>

<Button
	variant="outline"
	size="icon-lg"
	onclick={handleClick}
	aria-label="Select Mode"
	class={cn('border-muted-foreground', isActive && 'bg-accent text-accent-foreground')}
>
	<SquareDashedMousePointerIcon class="size-5" />
</Button>
