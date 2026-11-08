<script lang="ts">
	import { onMount } from 'svelte';
	import { contains } from '$lib/lab/clip';
	import { dragFrom, dragStart } from '$lib/lab/edit';
	import { project } from '$lib/lab/geometry';
	import { endKey, type Align, type Control, type Place } from '$lib/lab/model';
	import { PLACES } from '$lib/lab/places';
	import { SCENES } from '$lib/lab/scenes';
	import { crossSection } from '$lib/lab/geometry';
	import { Scene, type Handle, type View } from '$lib/lab/scene';

	const params = new URL(location.href).searchParams;
	const saved = SCENES.find((x) => x.id === params.get('scene'));
	const placeId = saved?.place ?? params.get('place') ?? 'sw136';
	const make = PLACES.find((f) => f().id === placeId) ?? PLACES[0];

	let canvas: HTMLCanvasElement;
	let wrap: HTMLDivElement;
	const initial = make();
	let place: Place = $state.raw(initial);
	let scene = new Scene(initial);
	const view: View = { ...(saved?.view ?? initial.view), width: 800, height: 600 };
	let showConnections = $state(params.has('connections'));
	let showOutlines = $state(params.has('outlines'));
	let showHandles = $state(!params.has('clean'));
	let selected = $state<{ road: string; index: number } | null>(null);
	let selectedAlign = $state<Align | null>(null);
	let selectedInfo = $state('');
	let buildMs = $state(0);
	let status = $state('');

	const CONTROLS: Control[] = ['stop', 'yield', 'signal', 'none'];

	let frame = 0;
	function redraw() {
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			scene.build();
			buildMs = Math.round(scene.lastBuildMs);
			const ctx = canvas.getContext('2d')!;
			const dpr = window.devicePixelRatio || 1;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			scene.render(ctx, view, {
				connections: showConnections,
				outlines: showOutlines,
				handles: showHandles,
				selected: selected ?? undefined
			});
		});
	}

	function resize() {
		const r = wrap.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		view.width = r.width;
		view.height = r.height;
		canvas.width = Math.round(r.width * dpr);
		canvas.height = Math.round(r.height * dpr);
		canvas.style.width = `${r.width}px`;
		canvas.style.height = `${r.height}px`;
		redraw();
	}

	const toWorld = (sx: number, sy: number) => ({
		x: (sx - view.width / 2) / view.zoom + view.x,
		y: (sy - view.height / 2) / view.zoom + view.y
	});
	const toScreen = (x: number, y: number) => ({
		x: (x - view.x) * view.zoom + view.width / 2,
		y: (y - view.y) * view.zoom + view.height / 2
	});

	function updateSelection() {
		if (!selected) {
			selectedAlign = null;
			selectedInfo = '';
			return;
		}
		const road = place.roads.find((r) => r.id === selected!.road)!;
		const s = road.stretches[selected.index];
		selectedAlign = s.align;
		const next = road.stretches[selected.index + 1];
		const length = scene.geos.get(road.id)?.path.length ?? 0;
		const lanes = crossSection(road, Math.min(length, (next ? next.at : length) - 0.01))
			.map((x) => `${x.lane.id} ${(x.right - x.left).toFixed(1)}`)
			.join(' · ');
		selectedInfo = `${road.id}, stretch ${selected.index + 1} of ${road.stretches.length} (${s.at.toFixed(1)} m, taper ${s.taper} m): ${lanes}`;
	}

	function setAlign(align: Align) {
		if (!selected) return;
		const road = place.roads.find((r) => r.id === selected!.road)!;
		road.stretches[selected.index].align = align;
		scene.touch(`road:${road.id}`);
		updateSelection();
		redraw();
	}

	type Drag =
		| {
				kind: 'end';
				road: string;
				end: 'start' | 'end';
				grab: { x: number; y: number };
				start: ReturnType<typeof dragStart>;
		  }
		| { kind: 'stretch'; road: string; index: number }
		| {
				kind: 'pan';
				sx: number;
				sy: number;
				vx: number;
				vy: number;
				moved: boolean;
				world: { x: number; y: number };
		  };
	let drag: Drag | null = null;

	function hitHandle(sx: number, sy: number): Handle | null {
		const handles = scene.handles();
		const order: Handle['kind'][] = ['end', 'stretch', 'badge'];
		for (const kind of order) {
			let best: Handle | null = null;
			let bestD = kind === 'badge' ? 11 : 10;
			for (const h of handles) {
				if (h.kind !== kind) continue;
				const s = toScreen(h.x, h.y);
				const d = Math.hypot(s.x - sx, s.y - sy);
				if (d < bestD) {
					best = h;
					bestD = d;
				}
			}
			if (best) return best;
		}
		return null;
	}

	function onDown(e: PointerEvent) {
		const r = canvas.getBoundingClientRect();
		const sx = e.clientX - r.left;
		const sy = e.clientY - r.top;
		const world = toWorld(sx, sy);
		canvas.setPointerCapture(e.pointerId);
		const h = showHandles ? hitHandle(sx, sy) : null;
		if (h?.kind === 'end') {
			drag = {
				kind: 'end',
				road: h.road!,
				end: h.end!,
				grab: { x: world.x - h.x, y: world.y - h.y },
				start: dragStart(place)
			};
			return;
		}
		if (h?.kind === 'stretch') {
			drag = { kind: 'stretch', road: h.road!, index: h.index! };
			selected = { road: h.road!, index: h.index! };
			updateSelection();
			redraw();
			return;
		}
		if (h?.kind === 'badge') {
			const j = scene.effective.find((x) => x.id === h.junction)!;
			const current = j.control[h.key!] ?? 'none';
			const next = CONTROLS[(CONTROLS.indexOf(current) + 1) % CONTROLS.length];
			scene.setControl(j.id, h.key!, next);
			status = `${h.key}: ${next}`;
			redraw();
			return;
		}
		drag = { kind: 'pan', sx, sy, vx: view.x, vy: view.y, moved: false, world };
	}

	function onMove(e: PointerEvent) {
		if (!drag) return;
		const r = canvas.getBoundingClientRect();
		const sx = e.clientX - r.left;
		const sy = e.clientY - r.top;
		const world = toWorld(sx, sy);
		if (drag.kind === 'pan') {
			if (Math.hypot(sx - drag.sx, sy - drag.sy) > 3) drag.moved = true;
			view.x = drag.vx - (sx - drag.sx) / view.zoom;
			view.y = drag.vy - (sy - drag.sy) / view.zoom;
		} else if (drag.kind === 'end') {
			// The road end follows the pointer as far as it stays valid.
			const target = { x: world.x - drag.grab.x, y: world.y - drag.grab.y };
			// A drag can move neighbouring ends too (making room): redraw every
			// road that changed.
			// Worked out from the drag's start every frame, so bringing the
			// pointer back puts everything back.
			const before = place.roads.map((r) => JSON.stringify(r.points));
			dragFrom(place, drag.start, drag.road, drag.end, target);
			place.roads.forEach((r, i) => {
				if (JSON.stringify(r.points) !== before[i]) scene.touch(`road:${r.id}`);
			});
		} else if (drag.kind === 'stretch') {
			const road = place.roads.find((x) => x.id === (drag as { road: string }).road)!;
			const geo = scene.geos.get(road.id)!;
			const s = project(geo.path, world).s;
			const prev = road.stretches[drag.index - 1];
			const next = road.stretches[drag.index + 1];
			road.stretches[drag.index].at = Math.max(
				prev.at + 0.5,
				Math.min(next ? next.at - 0.5 : geo.path.length - 0.5, s)
			);
			scene.touch(`road:${road.id}`);
			updateSelection();
		}
		redraw();
	}

	function onUp() {
		if (drag?.kind === 'pan' && !drag.moved) click(drag.world);
		drag = null;
	}

	// A click on a crossing switches it; on a road picks the stretch there.
	function click(world: { x: number; y: number }) {
		for (const j of scene.effective) {
			const draw = scene.junctionDraw(j.id);
			for (const c of draw?.crossings ?? []) {
				if (!c.hit.some((path) => contains(path, world))) continue;
				const on = scene.toggleWalkway(j.id, c.id);
				status = `${c.id}: ${on ? 'on' : 'off'}`;
				redraw();
				return;
			}
		}
		let best: { road: string; index: number; d: number } | null = null;
		for (const road of place.roads) {
			const geo = scene.geos.get(road.id)!;
			const hit = project(geo.path, world);
			const spans = crossSection(road, hit.s);
			const half = Math.max(...spans.map((s) => Math.max(Math.abs(s.left), Math.abs(s.right))));
			if (hit.d > half) continue;
			let index = 0;
			while (index + 1 < road.stretches.length && road.stretches[index + 1].at <= hit.s) index++;
			if (!best || hit.d < best.d) best = { road: road.id, index, d: hit.d };
		}
		selected = best ? { road: best.road, index: best.index } : null;
		updateSelection();
		redraw();
	}

	function onWheel(e: WheelEvent) {
		e.preventDefault();
		const r = canvas.getBoundingClientRect();
		const sx = e.clientX - r.left;
		const sy = e.clientY - r.top;
		const before = toWorld(sx, sy);
		view.zoom = Math.max(0.5, Math.min(80, view.zoom * Math.pow(1.0015, -e.deltaY)));
		const after = toWorld(sx, sy);
		view.x += before.x - after.x;
		view.y += before.y - after.y;
		redraw();
	}

	function reset() {
		place = make();
		scene = new Scene(place);
		Object.assign(view, place.view);
		selected = null;
		updateSelection();
		status = 'reset';
		resize();
	}

	$effect(() => {
		void showConnections;
		void showOutlines;
		void showHandles;
		redraw();
	});

	onMount(() => {
		const observer = new ResizeObserver(resize);
		observer.observe(wrap);
		resize();
		// Hooks for scripted checks: handle positions in screen pixels, and the
		// view so a script can frame a close-up.
		Object.assign(window, {
			__lab: {
				handles: () => {
					scene.build();
					const r = canvas.getBoundingClientRect();
					return scene.handles().map((h) => {
						const s = toScreen(h.x, h.y);
						const inJunction = h.kind !== 'end' || !!scene.junctionOf(h.road!, h.end!);
						return { ...h, inJunction, sx: s.x + r.left, sy: s.y + r.top };
					});
				},
				setView: (x: number, y: number, zoom: number) => {
					Object.assign(view, { x, y, zoom });
					redraw();
				},
				screen: (x: number, y: number) => {
					const r = canvas.getBoundingClientRect();
					const s = toScreen(x, y);
					return { x: s.x + r.left, y: s.y + r.top };
				},
				junctions: () =>
					place.junctions.map((j) => ({
						id: j.id,
						connections: j.connections.length,
						walkways: j.walkways.map(
							(w) => `${w.id}:${w.on ? 'on' : 'off'}${w.paved ? ':paved' : ''}`
						),
						control: j.ends.map((e) => `${endKey(e)}=${j.control[endKey(e)] ?? 'none'}`)
					})),
				buildMs: () => scene.lastBuildMs,
				zoom: () => view.zoom
			}
		});
		return () => observer.disconnect();
	});
</script>

<svelte:head><title>Road model lab</title></svelte:head>

<div class="lab">
	<header>
		<span class="brand">Road model lab</span>
		{#each PLACES as f (f)}
			{@const p = f()}
			<button
				class="place"
				class:current={p.id === place.id}
				onclick={() => (location.search = `?place=${p.id}`)}>{p.title}</button
			>
		{/each}
	</header>
	<div class="body">
		<div class="stage" bind:this={wrap}>
			<canvas
				bind:this={canvas}
				onpointerdown={onDown}
				onpointermove={onMove}
				onpointerup={onUp}
				onwheel={onWheel}
			></canvas>
			<div class="status">{place.title} · rebuild {buildMs} ms {status ? `· ${status}` : ''}</div>
		</div>
		<aside>
			{#if place.photo}
				<img src={place.photo} alt="Reference for {place.title}" />
			{/if}
			{#if place.note}<p class="note">{place.note}</p>{/if}
			<div class="row">
				<label><input type="checkbox" bind:checked={showConnections} /> connections</label>
				<label><input type="checkbox" bind:checked={showOutlines} /> junction edges</label>
				<label><input type="checkbox" bind:checked={showHandles} /> handles</label>
				<button onclick={reset}>Reset</button>
			</div>
			<p class="hint">
				Drag a blue circle to move a road end, a yellow diamond to move a stretch boundary. Click a
				road to pick its stretch, a crossing to switch it, a badge to cycle stop, yield, signal and
				none.
			</p>
			{#if selected}
				<div class="panel">
					<p>{selectedInfo}</p>
					<div class="row">
						{#each ['left', 'centre', 'right'] as const as a (a)}
							<button class:on={selectedAlign === a} onclick={() => setAlign(a)}>{a}</button>
						{/each}
					</div>
				</div>
			{/if}
		</aside>
	</div>
</div>

<style>
	.lab {
		display: flex;
		flex-direction: column;
		height: 100vh;
		background: #171717;
		color: #f5f5f5;
		font:
			13px/1.4 system-ui,
			sans-serif;
	}
	header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		padding: 6px 10px;
		border-bottom: 1px solid #404040;
	}
	.brand {
		font-weight: 600;
		margin-right: 8px;
	}
	header .place {
		background: none;
		padding: 3px 8px;
	}
	header .place:hover {
		background: #404040;
	}
	header .place.current {
		background: #f5f5f5;
		color: #171717;
	}
	.body {
		display: flex;
		flex: 1;
		min-height: 0;
	}
	.stage {
		position: relative;
		flex: 3;
		min-width: 0;
	}
	canvas {
		position: absolute;
		inset: 0;
		touch-action: none;
	}
	.status {
		position: absolute;
		left: 8px;
		bottom: 8px;
		background: rgb(0 0 0 / 0.6);
		padding: 2px 8px;
		border-radius: 4px;
		pointer-events: none;
	}
	aside {
		width: 38%;
		min-width: 320px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px;
		overflow-y: auto;
		border-left: 1px solid #404040;
	}
	aside img {
		width: 100%;
		border-radius: 4px;
	}
	.note {
		color: #d4d4d4;
		margin: 0;
	}
	.hint {
		color: #a3a3a3;
		margin: 0;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
	}
	button {
		background: #404040;
		color: inherit;
		border: 0;
		border-radius: 4px;
		padding: 3px 8px;
		cursor: pointer;
	}
	button.on {
		background: #fde047;
		color: #171717;
	}
	.panel {
		border: 1px solid #525252;
		border-radius: 4px;
		padding: 8px;
	}
	.panel p {
		margin: 0 0 6px;
		color: #d4d4d4;
	}
</style>
