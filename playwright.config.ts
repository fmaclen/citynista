import { defineConfig } from '@playwright/test';
import { loadEnv } from 'vite';

const env = loadEnv('test', process.cwd(), '');

export default defineConfig({
	webServer: {
		command: 'bun run build && bun run preview',
		port: Number(env.PREVIEW_PORT) || 4173
	},
	testDir: 'e2e',
	use: {
		screenshot: 'on',
		trace: 'retain-on-failure'
	}
});
