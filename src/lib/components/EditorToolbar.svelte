<script lang="ts">
	import DrawButton from './toolbar/DrawButton.svelte';
	import SelectButton from './toolbar/SelectButton.svelte';
	import ClearButton from './toolbar/ClearButton.svelte';
</script>

<div class="fixed bottom-8 left-1/2 z-50 -translate-x-1/2">
	<nav class="flex flex-row gap-2">
		<DrawButton />
		<SelectButton />
		<ClearButton />
	</nav>
</div>
