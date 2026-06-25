import { json, error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

// Dev-only: saves the posted graph as static/fixtures/<name>.json, where it
// is picked up by git, the e2e harness, and `?fixture=<name>` boots.
export async function PUT({ params, request }) {
	if (!dev) error(404, 'Not found');
	if (!NAME_PATTERN.test(params.name)) error(400, 'Fixture names are kebab-case slugs');

	const data = await request.json();
	// A city file is either a bare graph (legacy fixtures) or a { graph, camera }
	// wrapper; accept both and store whatever was posted verbatim.
	const graph = data?.graph ?? data;
	if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.segments)) {
		error(400, 'Expected a graph with nodes and segments');
	}

	const dir = join(process.cwd(), 'static', 'fixtures');
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${params.name}.json`), JSON.stringify(data, null, '\t') + '\n');

	return json({ saved: params.name });
}

// Dev-only: deletes static/fixtures/<name>.json. The kebab-case pattern refuses
// underscore-prefixed names, so the hidden test fixtures can't be removed here.
export async function DELETE({ params }) {
	if (!dev) error(404, 'Not found');
	if (!NAME_PATTERN.test(params.name)) error(400, 'Fixture names are kebab-case slugs');

	try {
		await unlink(join(process.cwd(), 'static', 'fixtures', `${params.name}.json`));
	} catch {
		error(404, 'Fixture not found');
	}

	return json({ deleted: params.name });
}
