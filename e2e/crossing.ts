import type { Page } from '@playwright/test';
import { liveGraph } from './app';

// Reading what the drawing holds where footpaths cross streets: its pieces,
// the lines drawn across car lanes and the zebras (unit/crossing-reads.ts),
// and the crossing controls the footpaths store.

export { linesAt, linesNear, piecesOf, zebras } from '../unit/crossing-reads';

// Every crossing control the editor's graph stores, footpath by footpath.
export const storedControls = async (page: Page) =>
	(await liveGraph(page)).segments.flatMap((s) => s.controls ?? []);
