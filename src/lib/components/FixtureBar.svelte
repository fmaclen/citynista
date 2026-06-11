<script lang="ts">
	import { getEditorContext } from '$lib/editor.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { ChevronLeft, ChevronRight, RotateCcw, Save } from '@lucide/svelte';

	const editor = getEditorContext();

	let names = $state<string[]>([]);
	let current = $state('');
	let saveName = $state('');
	let status = $state('');

	async function refreshList() {
		const response = await fetch('/api/fixtures');
		if (response.ok) {
			names = await response.json();
		}
	}

	async function load(name: string) {
		if (!name) return;
		const response = await fetch(`/fixtures/${name}.json`);
		if (!response.ok) {
			status = `missing: ${name}`;
			return;
		}
		editor.replaceGraph(await response.json());
		current = name;
		saveName = name;
		status = '';
		const url = new URL(window.location.href);
		url.searchParams.set('fixture', name);
		history.replaceState(null, '', url);
	}

	function cycle(step: number) {
		if (names.length === 0) return;
		const index = names.indexOf(current);
		const next = names[(index + step + names.length) % names.length];
		load(next);
	}

	async function save() {
		const name = saveName.trim();
		if (!name) return;
		const response = await fetch(`/api/fixtures/${name}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(editor.graph.toJSON())
		});
		if (response.ok) {
			status = `saved: ${name}`;
			current = name;
			await refreshList();
		} else {
			status = 'save failed';
		}
	}

	$effect(() => {
		refreshList();
		const name = new URLSearchParams(window.location.search).get('fixture');
		if (name) {
			current = name;
			saveName = name;
		}
	});
</script>

<div
	class="fixed top-8 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-lg border bg-background p-1.5 text-xs shadow-lg"
>
	<Button
		variant="ghost"
		size="icon"
		class="h-7 w-7"
		onclick={() => cycle(-1)}
		title="Previous fixture"
	>
		<ChevronLeft class="h-4 w-4" />
	</Button>

	<select
		class="h-7 max-w-40 rounded border bg-background px-1"
		value={current}
		onchange={(e) => load(e.currentTarget.value)}
	>
		<option value="" disabled>fixture…</option>
		{#each names as name (name)}
			<option value={name}>{name}</option>
		{/each}
	</select>

	<Button variant="ghost" size="icon" class="h-7 w-7" onclick={() => cycle(1)} title="Next fixture">
		<ChevronRight class="h-4 w-4" />
	</Button>

	<Button
		variant="ghost"
		size="icon"
		class="h-7 w-7"
		onclick={() => load(current)}
		title="Reload fixture from disk"
	>
		<RotateCcw class="h-4 w-4" />
	</Button>

	<Input
		class="h-7 w-32 text-xs"
		placeholder="save as…"
		bind:value={saveName}
		onkeydown={(e) => e.key === 'Enter' && save()}
	/>
	<Button
		variant="ghost"
		size="icon"
		class="h-7 w-7"
		onclick={save}
		title="Save current graph as fixture"
	>
		<Save class="h-4 w-4" />
	</Button>

	{#if status}
		<span class="px-1 text-muted-foreground">{status}</span>
	{/if}
</div>
