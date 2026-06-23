<script lang="ts">
	import { getEditorContext } from '$lib/editor.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import { ChevronLeft, ChevronRight, RotateCcw, Save, Trash2 } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';

	const editor = getEditorContext();

	let names = $state<string[]>([]);
	let current = $state('');
	let saveName = $state('');

	async function refreshList() {
		const response = await fetch('/api/fixtures');
		if (response.ok) {
			const all: string[] = await response.json();
			names = all.filter((name) => !name.startsWith('_'));
		}
	}

	async function load(name: string) {
		if (!name) return;
		const response = await fetch(`/fixtures/${name}.json`);
		if (!response.ok) {
			toast.error(`Fixture not found: ${name}`);
			return;
		}
		editor.replaceGraph(await response.json());
		current = name;
		saveName = name;
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

	async function del() {
		const name = current;
		if (!name) return;
		const response = await fetch(`/api/fixtures/${name}`, { method: 'DELETE' });
		if (!response.ok) {
			toast.error('Delete failed');
			return;
		}
		const index = names.indexOf(name);
		await refreshList();
		if (names.length > 0) {
			await load(names[Math.min(index, names.length - 1)]);
		} else {
			current = '';
			saveName = '';
		}
		toast.success(`Deleted ${name}`);
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
			toast.success(`Saved ${name}`);
			current = name;
			await refreshList();
		} else {
			toast.error('Save failed');
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

<div class="fixed top-8 left-1/2 z-50 -translate-x-1/2">
	<nav class="flex flex-row items-center gap-2 rounded-lg border bg-background p-2 shadow-lg">
		<Button variant="ghost" size="icon" onclick={() => cycle(-1)} title="Previous fixture">
			<ChevronLeft class="h-4 w-4" />
		</Button>

		<Button variant="ghost" size="icon" onclick={() => cycle(1)} title="Next fixture">
			<ChevronRight class="h-4 w-4" />
		</Button>

		<Select.Root type="single" value={current} onValueChange={(value) => load(value)}>
			<Select.Trigger class="w-40">{current || 'fixture…'}</Select.Trigger>
			<Select.Content>
				{#each names as name (name)}
					<Select.Item value={name} label={name} />
				{/each}
			</Select.Content>
		</Select.Root>

		<div class="mx-1 h-6 w-px bg-border"></div>

		<Button
			variant="ghost"
			size="icon"
			onclick={() => load(current)}
			title="Reload fixture from disk"
		>
			<RotateCcw class="h-4 w-4" />
		</Button>

		<Button
			variant="ghost"
			size="icon"
			disabled={!current}
			onclick={del}
			title="Delete this fixture from disk"
		>
			<Trash2 class="h-4 w-4" />
		</Button>

		<div class="mx-1 h-6 w-px bg-border"></div>

		<Input
			class="w-32"
			placeholder="save as…"
			bind:value={saveName}
			onkeydown={(e) => e.key === 'Enter' && save()}
		/>
		<Button variant="ghost" size="icon" onclick={save} title="Save current graph as fixture">
			<Save class="h-4 w-4" />
		</Button>
	</nav>
</div>
