import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { EXAMPLES, SCHEMA_VERSION } from '../src/lib/core/city-store';

test('every example carries the current schema version', () => {
	for (const { id } of EXAMPLES) {
		const example = JSON.parse(readFileSync(`static/examples/${id}.json`, 'utf8'));
		expect(example.version, id).toBe(SCHEMA_VERSION);
	}
});
