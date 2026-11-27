import { plugin } from 'bun';
import { compileModule } from 'svelte/compiler';

// The editor's own classes (`*.svelte.ts`: the graph, its nodes and segments)
// are written with Svelte's runes. Compiled here as the app compiles them, so
// tests can edit a live graph the way the editor does.
plugin({
	name: 'svelte runes',
	setup(build) {
		const transpiler = new Bun.Transpiler({ loader: 'ts' });
		build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
			const js = transpiler.transformSync(await Bun.file(path).text());
			return { contents: compileModule(js, { filename: path }).js.code, loader: 'js' };
		});
	}
});
