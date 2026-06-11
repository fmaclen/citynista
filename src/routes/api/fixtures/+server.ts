import { json, error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Dev-only: fixtures are plain JSON files in static/fixtures, shared ground
// truth between the browser, the test harness, and anyone editing the repo.
export async function GET() {
	if (!dev) error(404, 'Not found');

	const dir = join(process.cwd(), 'static', 'fixtures');
	let names: string[] = [];
	try {
		const entries = await readdir(dir);
		names = entries
			.filter((entry) => entry.endsWith('.json'))
			.map((entry) => entry.slice(0, -'.json'.length))
			.sort();
	} catch {
		names = [];
	}

	return json(names);
}
