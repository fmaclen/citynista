import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), '');
	return {
		plugins: [tailwindcss(), sveltekit()],
		server: {
			host: '127.0.0.1',
			port: Number(env.PORT) || 5173,
			strictPort: true,
			allowedHosts: ['.ts.net'],
			watch: {
				usePolling: true,
				interval: 300,
				// City auto-saves write JSON here constantly; don't full-reload on them.
				// External edits to a city file are picked up on a manual reload.
				ignored: ['**/static/fixtures/**']
			}
		},
		preview: { host: '127.0.0.1', port: Number(env.PREVIEW_PORT) || 4173, strictPort: true }
	};
});
