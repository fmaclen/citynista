import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		watch: {
			usePolling: true,
			interval: 300,
			// City auto-saves write JSON here constantly; don't full-reload on them.
			// External edits to a city file are picked up on a manual reload.
			ignored: ['**/static/fixtures/**']
		}
	}
});
