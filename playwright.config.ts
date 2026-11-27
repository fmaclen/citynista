import { defineConfig } from '@playwright/test';
import { loadEnv } from 'vite';

const env = loadEnv('test', process.cwd(), '');

export default defineConfig({
	webServer: {
		command: 'bun run build && bun run preview',
		port: Number(env.PREVIEW_PORT) || 4173
	},
	testDir: 'e2e',
	// On CI a test that fails once is run again, and reported flaky if it then
	// passes; a local run shows every failure.
	retries: process.env.CI ? 1 : 0,
	use: {
		screenshot: 'on',
		trace: 'retain-on-failure',
		// The browser reaches nothing but the preview server. The page loads an
		// analytics script from the internet (src/app.html), and `page.goto`
		// waits for the load event, which waits for that script: on a slow
		// connection opening the page could use up a test's 30 s.
		launchOptions: { args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'] }
	}
});
