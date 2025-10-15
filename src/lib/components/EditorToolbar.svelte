<script lang="ts">
	import DrawButton from './toolbar/DrawButton.svelte';
	import SelectButton from './toolbar/SelectButton.svelte';
	import ClearButton from './toolbar/ClearButton.svelte';
	import OSMButton from './toolbar/OSMButton.svelte';
	import { Separator } from '$lib/components/ui/separator';
</script>

<div class="fixed bottom-8 left-1/2 z-50 -translate-x-1/2">
	<nav class="flex flex-row items-center gap-2">
		<DrawButton />
		<SelectButton />
		<ClearButton />
		<Separator orientation="vertical" class="h-8" />
		<OSMButton />
	</nav>
</div>
