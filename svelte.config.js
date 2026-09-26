import adapter from '@sveltejs/adapter-vercel';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	kit: {
		// An explicit runtime pins production and lets the build run on any local
		// Node; without it the adapter refuses Node versions Vercel does not offer.
		adapter: adapter({ runtime: 'nodejs24.x' })
	}
};

export default config;
