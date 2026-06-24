import { test } from '@playwright/test';

// Throwaway visual harness (not committed): renders shared fixtures from
// static/fixtures/ and screenshots them to /tmp for inspection. The same
// fixtures load in the browser via /?fixture=<name>, so these captures show
// exactly what the user sees.
const SCENARIOS: { fixture: string; zoom: number }[] = [
	{ fixture: 'setback-demo', zoom: 12 },
	{ fixture: '_connectors-demo', zoom: 16 },
	{ fixture: 'downtown', zoom: 6 },
	{ fixture: 'downtown', zoom: 16 },
	{ fixture: 'connector-carve-demo', zoom: 16 }
];

for (const { fixture, zoom } of SCENARIOS) {
	test(`capture ${fixture} z${zoom}`, async ({ page }) => {
		await page.goto(`/?fixture=${fixture}&topdown`);
		await page.waitForSelector('canvas');
		await page.mouse.move(640, 360);
		for (let i = 0; i < zoom; i++) {
			await page.mouse.wheel(0, -100);
		}
		await page.mouse.move(1265, 5);
		await page.waitForTimeout(500);
		await page.locator('canvas').screenshot({ path: `/tmp/visual-${fixture}-z${zoom}.png` });
	});
}

test('connector mode: enter and screenshot overlay', async ({ page }) => {
	await page.goto('/?fixture=_connectors-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length === 5;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 18; i++) await page.mouse.wheel(0, -100);
	await page.mouse.dblclick(640, 360);
	await page.waitForTimeout(300);
	// Idle: mouse away from the dots so nothing is hovered.
	await page.mouse.move(950, 180);
	await page.waitForTimeout(200);
	await page.locator('canvas').screenshot({ path: '/tmp/connector-idle.png' });
	// Hover the North incoming (filled disc) dot — should turn blue and enlarge.
	await page.mouse.move(619, 281);
	await page.waitForTimeout(200);
	await page.locator('canvas').screenshot({ path: '/tmp/connector-hover.png' });
});

test('transition taper symmetry diagonal', async ({ page }) => {
	page.on('console', (msg) => {
		if (msg.text().startsWith('DIAG')) console.log(msg.text());
	});
	await page.goto('/?fixture=transition-diag&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 15; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/transition-diag.png' });
});

test('transition taper symmetry', async ({ page }) => {
	await page.goto('/?fixture=transition-demo&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 11; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/transition-symmetry.png' });
});

test('transition taper handle', async ({ page }) => {
	await page.goto('/?fixture=transition-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length === 3;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 9; i++) await page.mouse.wheel(0, -100);
	// Select the transition node 'mid' at world origin = viewport centre.
	await page.mouse.click(640, 360);
	await page.waitForTimeout(200);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(150);
	await page.locator('canvas').screenshot({ path: '/tmp/transition-handle.png' });

	// Drag the handle (on the wide side, right of centre) further out — the
	// taper should lengthen.
	const setback = () =>
		page.evaluate(() => {
			const s = JSON.parse(localStorage.getItem('citynista-graph-v2')!).segments.find(
				(x: { id: string }) => x.id === 'wide'
			);
			return s.setbackStart;
		});
	console.log('SETBACK_BEFORE', await setback());
	await page.mouse.move(779, 360); // the auto taper-start handle
	await page.mouse.down();
	await page.mouse.move(950, 360, { steps: 8 });
	await page.mouse.up();
	await page.waitForTimeout(200);
	console.log('SETBACK_AFTER', await setback());
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(150);
	await page.locator('canvas').screenshot({ path: '/tmp/transition-handle-dragged.png' });
});

test('setback-demo-2 protrusion check', async ({ page }) => {
	await page.goto('/?fixture=setback-demo-2&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 9; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/setback-demo-2.png' });
});

test('setback gap minimal repro', async ({ page }) => {
	await page.goto('/?fixture=setback-gap-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length === 4;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(200);
	await page.locator('canvas').screenshot({ path: '/tmp/setback-gap-min.png' });
});

test('setback gap + stacked handles repro', async ({ page }) => {
	await page.goto('/?fixture=connector-carve-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.some((n: { id: string }) => n.id === 'node-4');
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(200);
	await page.locator('canvas').screenshot({ path: '/tmp/setback-gap.png' });

	// node-4 is at world (40,0) → ~(764,360) at zoom 8; select it for the handles.
	await page.mouse.click(764, 360);
	await page.waitForTimeout(200);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(200);
	await page.locator('canvas').screenshot({ path: '/tmp/setback-handles-node4.png' });
});

test('node selection suppresses segment hover', async ({ page }) => {
	await page.goto('/?fixture=setback-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length === 4;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -100);

	// No selection: hovering the left road highlights it.
	await page.mouse.move(501, 360);
	await page.waitForTimeout(150);
	await page.locator('canvas').screenshot({ path: '/tmp/hover-unselected.png' });

	// Select the junction node, then hover the same road — no highlight.
	await page.mouse.click(640, 360);
	await page.waitForTimeout(150);
	await page.mouse.move(501, 360);
	await page.waitForTimeout(150);
	await page.locator('canvas').screenshot({ path: '/tmp/hover-node-selected.png' });
});

test('editor lines: setback stems and bezier guide are beaded', async ({ page }) => {
	await page.goto('/?fixture=setback-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length === 4;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -100);

	// Select the junction → beaded setback stems.
	await page.mouse.click(640, 360);
	await page.waitForTimeout(200);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(150);
	await page.locator('canvas').screenshot({ path: '/tmp/editor-setback.png' });

	// Select a road → beaded bezier guide + control diamond.
	await page.mouse.click(500, 360);
	await page.waitForTimeout(200);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(150);
	await page.locator('canvas').screenshot({ path: '/tmp/editor-guide.png' });
});

test('connector mode: drag feedback green/red', async ({ page }) => {
	await page.goto('/?fixture=_connectors-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length === 5;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 18; i++) await page.mouse.wheel(0, -100);
	await page.mouse.dblclick(640, 360);
	await page.waitForTimeout(200);

	await page.mouse.move(619, 281); // North incoming
	await page.mouse.down();
	await page.mouse.move(717, 379, { steps: 6 }); // East outgoing — valid
	await page.waitForTimeout(150);
	await page.locator('canvas').screenshot({ path: '/tmp/connector-drag-valid.png' });
	await page.mouse.move(717, 339, { steps: 6 }); // East incoming — invalid
	await page.waitForTimeout(150);
	await page.locator('canvas').screenshot({ path: '/tmp/connector-drag-invalid.png' });
	await page.mouse.up();
});

test('connector mode: corner node on the slip-lane fixture', async ({ page }) => {
	await page.goto('/?fixture=connector-carve-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.some((n: { id: string }) => n.id === 'node-0');
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 16; i++) await page.mouse.wheel(0, -100);
	// node-0 is at world (0,21); at z16 that is ~(640, 499).
	await page.mouse.dblclick(640, 499);
	await page.waitForTimeout(300);
	await page.mouse.move(950, 180);
	await page.waitForTimeout(200);
	await page.locator('canvas').screenshot({ path: '/tmp/connector-corner.png' });
});

test('connector mode: disabling both N-E movements carves the corner', async ({ page }) => {
	await page.goto('/?fixture=_connectors-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length === 5;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 18; i++) await page.mouse.wheel(0, -100);
	await page.mouse.dblclick(640, 360);
	await page.waitForTimeout(300);

	const drag = async (fromX: number, fromY: number, toX: number, toY: number) => {
		await page.mouse.move(fromX, fromY);
		await page.mouse.down();
		await page.mouse.move((fromX + toX) / 2, (fromY + toY) / 2, { steps: 5 });
		await page.mouse.move(toX, toY, { steps: 5 });
		await page.mouse.up();
		await page.waitForTimeout(150);
	};

	await drag(619, 281, 717, 379); // North incoming -> East outgoing
	await drag(717, 339, 659, 281); // East incoming -> North outgoing

	const disabled = await page.evaluate(() => {
		const r = JSON.parse(localStorage.getItem('citynista-graph-v2')!);
		const c = r.nodes.find((n: { id: string }) => n.id === 'c');
		return c?.disabledConnections?.length ?? 0;
	});
	console.log('DISABLED_COUNT', disabled);

	await page.mouse.move(1265, 5);
	await page.waitForTimeout(200);
	await page.locator('canvas').screenshot({ path: '/tmp/connector-carved.png' });

	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
	const afterEscape = await page.evaluate(
		() => localStorage.getItem('citynista-graph-v2') !== null
	);
	console.log('ESCAPED', afterEscape);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(200);
	await page.locator('canvas').screenshot({ path: '/tmp/connector-carved-bare.png' });
});

test('undo works after loading a fixture', async ({ page }) => {
	await page.goto('/?fixture=_connectors-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length === 5;
	});
	const before = await page.evaluate(() => localStorage.getItem('citynista-graph-v2'));

	await page.mouse.click(640, 360); // select centre node
	await page.waitForTimeout(150);
	await page.mouse.move(640, 360);
	await page.mouse.down();
	await page.mouse.move(690, 405, { steps: 6 });
	await page.mouse.up();
	await page.waitForTimeout(150);
	const moved = await page.evaluate(() => localStorage.getItem('citynista-graph-v2'));

	await page.keyboard.press('ControlOrMeta+z');
	await page.waitForTimeout(250);
	const after = await page.evaluate(() => localStorage.getItem('citynista-graph-v2'));

	console.log('MOVED_DIFFERS', moved !== before);
	console.log('UNDO_REVERTED', after === before);
});

test('undo reverts a connector toggle', async ({ page }) => {
	await page.goto('/?fixture=_connectors-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length === 5;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 18; i++) await page.mouse.wheel(0, -100);
	await page.mouse.click(640, 360); // select centre node
	await page.waitForTimeout(200);
	await page.mouse.click(620, 330); // toggle a connector
	await page.waitForTimeout(200);
	const toggled = await page.evaluate(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && r.includes('disabledConnections');
	});
	await page.keyboard.press('ControlOrMeta+z');
	await page.waitForTimeout(250);
	const afterUndo = await page.evaluate(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && r.includes('disabledConnections');
	});
	console.log('CONNECTOR_TOGGLED', toggled);
	console.log('UNDO_CLEARED_IT', toggled && !afterUndo);
});

test('drag from a source dot to a target dot routes a movement', async ({ page }) => {
	await page.goto('/?fixture=_connectors-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length === 5;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 18; i++) await page.mouse.wheel(0, -100);
	await page.mouse.click(640, 360); // select centre node
	await page.waitForTimeout(250);

	// Drag the North source dot (cyan, ~659,281) to the East target dot
	// (white 'out', ~719,341).
	await page.mouse.move(659, 281);
	await page.mouse.down();
	await page.mouse.move(690, 320, { steps: 6 });
	await page.mouse.move(719, 341, { steps: 6 });
	await page.mouse.up();
	await page.waitForTimeout(250);

	const routed = await page.evaluate(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && r.includes('disabledConnections');
	});
	console.log('DRAG_ROUTED', routed);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(200);
	await page.locator('canvas').screenshot({ path: '/tmp/visual-drag-connect.png' });
});

test('setback handle shows and drags', async ({ page }) => {
	await page.goto('/?fixture=setback-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length === 4;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -100);
	await page.mouse.click(640, 360); // select the junction node
	await page.waitForTimeout(300);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(200);
	await page.locator('canvas').screenshot({ path: '/tmp/visual-setback-handles.png' });

	const seg = () =>
		page.evaluate(() => {
			const s = JSON.parse(localStorage.getItem('citynista-graph-v2')!).segments.find(
				(x: { id: string }) => x.id === 'seg-b'
			);
			return s.setbackEnd;
		});
	const before = await seg();
	await page.mouse.move(640, 438); // the avenue arm's handle (~22m down)
	await page.mouse.down();
	await page.mouse.move(640, 500, { steps: 6 });
	await page.mouse.up();
	await page.waitForTimeout(200);
	const after = await seg();
	console.log('SETBACK_BEFORE', before, 'AFTER', after, 'INCREASED', after > before);
	await page.locator('canvas').screenshot({ path: '/tmp/visual-setback-dragged.png' });
});

test('capture setback-demo', async ({ page }) => {
	await page.goto('/?fixture=setback-demo&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(600);
	await page.locator('canvas').screenshot({ path: '/tmp/visual-setback-demo.png' });
});

test('capture connection-mesh spike', async ({ page }) => {
	for (const { fixture, zoom } of [
		{ fixture: '_connectors-demo', zoom: 16 },
		{ fixture: 'setback-demo', zoom: 12 }
	]) {
		await page.goto(`/?fixture=${fixture}&topdown&mesh`);
		await page.waitForSelector('canvas');
		await page.mouse.move(640, 360);
		for (let i = 0; i < zoom; i++) await page.mouse.wheel(0, -100);
		await page.mouse.move(1265, 5);
		await page.waitForTimeout(700);
		await page.locator('canvas').screenshot({ path: `/tmp/visual-mesh-${fixture}.png` });
	}
});

test('capture downtown', async ({ page }) => {
	await page.goto('/?fixture=downtown&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 4; i++) {
		await page.mouse.wheel(0, 100); // zoom out to frame the whole network
	}
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(700);
	await page.locator('canvas').screenshot({ path: '/tmp/visual-downtown.png' });
});

test('capture downtown center', async ({ page }) => {
	await page.goto('/?fixture=downtown&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 6; i++) {
		await page.mouse.wheel(0, -100);
	}
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(700);
	await page.locator('canvas').screenshot({ path: '/tmp/visual-downtown-center.png' });
});

test('connector toggles off on click', async ({ page }) => {
	await page.goto('/?fixture=_connectors-demo&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 18; i++) {
		await page.mouse.wheel(0, -100);
	}
	await page.mouse.click(640, 360); // select the centre node
	await page.waitForTimeout(400);
	// Click across a band of the junction where connectors run, toggling some
	// of them off.
	for (const dx of [-40, -20, 20, 40]) {
		await page.mouse.click(640 + dx, 330);
		await page.waitForTimeout(120);
	}
	await page.waitForTimeout(300);
	const persisted = await page.evaluate(() => {
		const raw = localStorage.getItem('citynista-graph-v2');
		return raw ? raw.includes('disabledConnections') : false;
	});
	console.log('TOGGLE_PERSISTED', persisted);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/visual-connector-toggle.png' });
});

test('capture _connectors-demo (node selected)', async ({ page }) => {
	await page.goto('/?fixture=_connectors-demo&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 18; i++) {
		await page.mouse.wheel(0, -100);
	}
	// The centre node sits at the world origin = viewport centre; clicking it
	// selects it and draws the lane connectors.
	await page.mouse.click(640, 360);
	await page.waitForTimeout(500);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/visual-_connectors-demo.png' });
});

test('transition bend', async ({ page }) => {
	page.on('console', (msg) => {
		if (msg.text().startsWith('DIAG')) console.log(msg.text());
	});
	await page.goto('/?fixture=transition-bend&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 13; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/transition-bend.png' });
});

for (const fx of ['angle-junction', 'median-junction']) {
	test(`repro ${fx}`, async ({ page }) => {
		await page.goto(`/?fixture=${fx}&topdown`);
		await page.waitForSelector('canvas');
		await page.mouse.move(640, 360);
		for (let i = 0; i < 11; i++) await page.mouse.wheel(0, -100);
		await page.mouse.move(1265, 5);
		await page.waitForTimeout(300);
		await page.locator('canvas').screenshot({ path: `/tmp/repro-${fx}.png` });
	});
}

test('repro angle6', async ({ page }) => {
	await page.goto('/?fixture=angle6-junction&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 11; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/repro-angle6.png' });
});

test('repro merge45', async ({ page }) => {
	await page.goto('/?fixture=merge45-junction&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/repro-merge45.png' });
});

test('repro downtown-diag', async ({ page }) => {
	await page.goto('/?fixture=downtown&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 11; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(400);
	await page.locator('canvas').screenshot({ path: '/tmp/repro-downtown-diag.png' });
});

test('repro diag-zoom', async ({ page }) => {
	await page.goto('/?fixture=downtown&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 14; i++) await page.mouse.wheel(0, -100);
	// Middle-drag to bring g(2,2) (world -47.5,-47.5) toward viewport centre.
	await page.mouse.move(300, 200);
	await page.mouse.down({ button: 'middle' });
	await page.mouse.move(560, 460, { steps: 10 });
	await page.mouse.up({ button: 'middle' });
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(400);
	await page.locator('canvas').screenshot({ path: '/tmp/repro-diag-zoom.png' });
});

test('repro diag33', async ({ page }) => {
	await page.goto('/?fixture=downtown&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 16; i++) await page.mouse.wheel(0, -100);
	// g(3,3) world (47.5,47.5) → centre it.
	await page.mouse.move(700, 500);
	await page.mouse.down({ button: 'middle' });
	await page.mouse.move(386, 186, { steps: 10 });
	await page.mouse.up({ button: 'middle' });
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(400);
	await page.locator('canvas').screenshot({ path: '/tmp/repro-diag33.png' });
});

test('repro diag33b', async ({ page }) => {
	await page.goto('/?fixture=downtown&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 14; i++) await page.mouse.wheel(0, -100);
	await page.keyboard.down('Space');
	await page.mouse.move(800, 560);
	await page.mouse.down();
	await page.mouse.move(540, 300, { steps: 10 });
	await page.mouse.up();
	await page.keyboard.up('Space');
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(400);
	await page.locator('canvas').screenshot({ path: '/tmp/repro-diag33b.png' });
});

test('repro median45', async ({ page }) => {
	await page.goto('/?fixture=median45-junction&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 15; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/repro-median45.png' });
});

test('repro median-t', async ({ page }) => {
	await page.goto('/?fixture=median-junction&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 13; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/repro-median-t.png' });
});

test('repro diag22', async ({ page }) => {
	await page.goto('/?fixture=downtown&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 16; i++) await page.mouse.wheel(0, -100);
	// g(2,2) world (-47.5,-47.5) → centre it (space-drag pan, no rotate).
	await page.keyboard.down('Space');
	await page.mouse.move(380, 200);
	await page.mouse.down();
	await page.mouse.move(694, 514, { steps: 10 });
	await page.mouse.up();
	await page.keyboard.up('Space');
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(400);
	await page.locator('canvas').screenshot({ path: '/tmp/repro-diag22.png' });
});

test('repro _median-corner', async ({ page }) => {
	await page.goto('/?fixture=_median-corner&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 11; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/repro-_median-corner.png' });
});

test('ztmp mediantrans', async ({ page }) => {
	await page.goto('/?fixture=ztmp-mediantrans&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 15; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-mediantrans.png' });
});

test('ztmp mediantrans2', async ({ page }) => {
	await page.goto('/?fixture=ztmp-mediantrans&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 18; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-mediantrans2.png' });
});

test('ztmp link', async ({ page }) => {
	await page.goto('/?fixture=transition-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length === 3;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 9; i++) await page.mouse.wheel(0, -100);
	await page.mouse.click(640, 360); // select node 'mid'
	await page.waitForTimeout(200);
	const setbacks = () =>
		page.evaluate(() => {
			const segs = JSON.parse(localStorage.getItem('citynista-graph-v2')!).segments;
			return segs.map((s: { id: string; setbackStart?: number; setbackEnd?: number }) => ({
				id: s.id,
				s: s.setbackStart,
				e: s.setbackEnd
			}));
		});
	console.log('LINK_BEFORE', JSON.stringify(await setbacks()));
	// Drag the right-side handle (narrow side) outward.
	await page.mouse.move(709, 360);
	await page.mouse.down();
	await page.mouse.move(880, 360, { steps: 8 });
	await page.mouse.up();
	await page.waitForTimeout(200);
	console.log('LINK_AFTER', JSON.stringify(await setbacks()));
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(150);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-link.png' });
});

test('ztmp straddle-zoom', async ({ page }) => {
	await page.goto('/?fixture=transition-demo&topdown');
	await page.waitForSelector('canvas');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 17; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-straddle-zoom.png' });
});

test('ztmp straddle-handles', async ({ page }) => {
	await page.goto('/?fixture=transition-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length === 3;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 11; i++) await page.mouse.wheel(0, -100);
	await page.mouse.click(640, 360);
	await page.waitForTimeout(200);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(150);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-straddle-handles.png' });
});

test('ztmp straddle-link', async ({ page }) => {
	await page.goto('/?fixture=transition-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length === 3;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 11; i++) await page.mouse.wheel(0, -100);
	await page.mouse.click(640, 360);
	await page.waitForTimeout(200);
	const setbacks = () =>
		page.evaluate(() =>
			JSON.parse(localStorage.getItem('citynista-graph-v2')!).segments.map(
				(s: { id: string; setbackStart?: number; setbackEnd?: number }) =>
					`${s.id}:${s.setbackStart ?? '-'}/${s.setbackEnd ?? '-'}`
			)
		);
	console.log('SB_BEFORE', JSON.stringify(await setbacks()));
	// Drag the left handle further left (lengthen the taper).
	await page.mouse.move(550, 360);
	await page.mouse.down();
	await page.mouse.move(430, 360, { steps: 8 });
	await page.mouse.up();
	await page.waitForTimeout(200);
	console.log('SB_AFTER', JSON.stringify(await setbacks()));
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(150);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-straddle-link.png' });
});

test('ztmp median-conn', async ({ page }) => {
	await page.goto('/?fixture=ztmp-median-conn&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length === 4;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 13; i++) await page.mouse.wheel(0, -100);
	await page.mouse.dblclick(640, 360);
	await page.waitForTimeout(300);
	await page.mouse.move(950, 120);
	await page.waitForTimeout(150);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-median-conn.png' });
});

test('ztmp median-conn2', async ({ page }) => {
	await page.goto('/?fixture=ztmp-median-conn&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length === 4;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 19; i++) await page.mouse.wheel(0, -100);
	await page.mouse.dblclick(640, 360);
	await page.waitForTimeout(300);
	await page.mouse.move(1100, 120);
	await page.waitForTimeout(150);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-median-conn2.png' });
});

test('ztmp trans-conn', async ({ page }) => {
	await page.goto('/?fixture=transition-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length === 3;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 13; i++) await page.mouse.wheel(0, -100);
	await page.mouse.dblclick(640, 360);
	await page.waitForTimeout(300);
	const mode = () =>
		page.evaluate(() => (window as unknown as { __editor?: { mode: string } }).__editor?.mode);
	console.log('MODE_AFTER_DBLCLICK', await mode());
	await page.mouse.move(1100, 120);
	await page.waitForTimeout(150);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-trans-conn.png' });
});

test('ztmp uturn-add', async ({ page }) => {
	await page.goto('/?fixture=transition-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length === 3;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 13; i++) await page.mouse.wheel(0, -100);
	await page.mouse.dblclick(640, 360);
	await page.waitForTimeout(300);
	const enabled = () =>
		page.evaluate(() =>
			JSON.parse(localStorage.getItem('citynista-graph-v2')!).nodes.map(
				(n: { id: string; enabledConnections?: unknown[] }) =>
					`${n.id}:${(n.enabledConnections ?? []).length}`
			)
		);
	console.log('ENABLED_BEFORE', JSON.stringify(await enabled()));
	// Drag between two wide-side dots (same segment) — a U-turn.
	for (const [sx, sy, ex, ey] of [
		[680, 325, 678, 415],
		[680, 392, 680, 325],
		[678, 415, 680, 392]
	]) {
		await page.mouse.move(sx, sy);
		await page.mouse.down();
		await page.mouse.move(ex, ey, { steps: 6 });
		await page.mouse.up();
		await page.waitForTimeout(120);
		const e = await enabled();
		if (e.some((x: string) => !x.endsWith(':0'))) {
			console.log('ENABLED_AFTER', JSON.stringify(e), 'drag', sx, sy, '->', ex, ey);
			break;
		}
	}
});

test('ztmp uturn-add2', async ({ page }) => {
	await page.goto('/?fixture=transition-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length === 3;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 13; i++) await page.mouse.wheel(0, -100);
	await page.mouse.dblclick(640, 360);
	await page.waitForTimeout(300);
	const enabled = () =>
		page.evaluate(() =>
			JSON.parse(localStorage.getItem('citynista-graph-v2')!)
				.nodes.map(
					(n: { id: string; enabledConnections?: unknown[] }) => (n.enabledConnections ?? []).length
				)
				.reduce((a: number, b: number) => a + b, 0)
		);
	// 4 wide-side travel dots at x~670, y in {334,351,369,386}. Try IN->OUT pairs.
	const ys = [334, 351, 369, 386];
	let done = false;
	for (let i = 0; i < ys.length && !done; i++) {
		for (let j = 0; j < ys.length && !done; j++) {
			if (i === j) continue;
			await page.mouse.move(670, ys[i]);
			await page.mouse.down();
			await page.mouse.move(670, ys[j], { steps: 5 });
			await page.mouse.up();
			await page.waitForTimeout(100);
			if ((await enabled()) > 0) {
				console.log('UTURN_OK drag', ys[i], '->', ys[j], 'enabled=', await enabled());
				done = true;
			}
		}
	}
	if (!done) console.log('UTURN_NONE');
	await page.mouse.move(1100, 120);
	await page.waitForTimeout(150);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-uturn.png' });
});

test('ztmp branch', async ({ page }) => {
	page.on('console', (m) => {
		if (m.text().startsWith('DIAG')) console.log(m.text());
	});
	await page.goto('/?fixture=ztmp-branch&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length === 4;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 15; i++) await page.mouse.wheel(0, -100);
	await page.mouse.dblclick(640, 360);
	await page.waitForTimeout(300);
	await page.mouse.move(1100, 120);
	await page.waitForTimeout(150);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-branch.png' });
});

test('ztmp merge-lines', async ({ page }) => {
	await page.goto('/?fixture=connector-carve-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.some((n: { id: string }) => n.id === 'node-4');
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 13; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(1265, 5);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-merge-lines.png' });
});

test('ztmp center-break', async ({ page }) => {
	for (const fx of ['ztmp-nobreak', 'ztmp-break']) {
		await page.goto(`/?fixture=${fx}&topdown`);
		await page.waitForFunction(() => {
			const r = localStorage.getItem('citynista-graph-v2');
			return !!r && JSON.parse(r).nodes.length === 3;
		});
		await page.mouse.move(640, 360);
		for (let i = 0; i < 16; i++) await page.mouse.wheel(0, -100);
		await page.mouse.move(1100, 120);
		await page.waitForTimeout(250);
		await page.locator('canvas').screenshot({ path: `/tmp/${fx}.png` });
	}
});

test('ztmp node1', async ({ page }) => {
	await page.goto('/?fixture=connector-carve-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.some((n: { id: string }) => n.id === 'node-1');
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -100);
	// node-1 at world (-23,0); space-drag it toward centre.
	await page.keyboard.down('Space');
	await page.mouse.move(300, 360);
	await page.mouse.down();
	await page.mouse.move(560, 360, { steps: 8 });
	await page.mouse.up();
	await page.keyboard.up('Space');
	await page.mouse.move(1100, 120);
	await page.waitForTimeout(250);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-node1.png' });
});

test('ztmp downtown-yellow', async ({ page }) => {
	await page.goto('/?fixture=downtown&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length > 5;
	});
	await page.mouse.move(640, 360);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-downtown-yellow.png' });
});

test('ztmp downtown-zoom', async ({ page }) => {
	await page.goto('/?fixture=downtown&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length > 5;
	});
	await page.mouse.move(640, 300);
	for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(1100, 120);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-downtown-zoom.png' });
});

test('ztmp diagx', async ({ page }) => {
	const lines: string[] = [];
	page.on('console', (m) => {
		if (m.text().startsWith('DIAGX')) lines.push(m.text());
	});
	await page.goto('/?fixture=connector-carve-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.some((n: { id: string }) => n.id === 'node-7');
	});
	await page.waitForTimeout(400);
	console.log('---DIAGX-START---');
	for (const l of [...new Set(lines)]) console.log(l);
	console.log('---DIAGX-END---');
});

test('ztmp node7', async ({ page }) => {
	await page.goto('/?fixture=connector-carve-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.some((n: { id: string }) => n.id === 'node-7');
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 16; i++) await page.mouse.wheel(0, -100);
	// node-7 at world (0,44); pan it up toward centre.
	await page.keyboard.down('Space');
	await page.mouse.move(640, 600);
	await page.mouse.down();
	await page.mouse.move(640, 320, { steps: 8 });
	await page.mouse.up();
	await page.keyboard.up('Space');
	await page.mouse.move(1100, 120);
	await page.waitForTimeout(250);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-node7.png' });
});

test('ztmp divided-junction', async ({ page }) => {
	await page.goto('/?fixture=downtown&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length > 5;
	});
	// g-2-4 (142,-48) is at ~ (844,291) at default zoom; pan it to centre first.
	await page.keyboard.down('Space');
	await page.mouse.move(600, 400);
	await page.mouse.down();
	await page.mouse.move(396, 469, { steps: 8 });
	await page.mouse.up();
	await page.keyboard.up('Space');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 13; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(20, 690);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-divided-junction.png' });
});

test('ztmp medlog', async ({ page }) => {
	const lines: string[] = [];
	page.on('console', (m) => {
		if (m.text().startsWith('DIAGMED')) lines.push(m.text());
	});
	await page.goto('/?fixture=downtown&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length > 5;
	});
	await page.waitForTimeout(400);
	console.log('---MEDSTART---');
	for (const l of [...new Set(lines)]) console.log(l);
	console.log('---MEDEND---');
});

test('ztmp diag-merge', async ({ page }) => {
	await page.goto('/?fixture=downtown&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length > 5;
	});
	// g-2-2 (-48,-48) ~ (571,291) at default; pan to centre then zoom.
	await page.keyboard.down('Space');
	await page.mouse.move(500, 400);
	await page.mouse.down();
	await page.mouse.move(569, 469, { steps: 8 });
	await page.mouse.up();
	await page.keyboard.up('Space');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 11; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(20, 690);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-diag-merge.png' });
});

test('ztmp vstub', async ({ page }) => {
	await page.goto('/?fixture=downtown&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length > 5;
	});
	// vertical approach north of g-2-3: midpoint (48,-95) ~ (709,223) default.
	await page.keyboard.down('Space');
	await page.mouse.move(700, 300);
	await page.mouse.down();
	await page.mouse.move(631, 437, { steps: 8 });
	await page.mouse.up();
	await page.keyboard.up('Space');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(20, 690);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-vstub.png' });
});

test('ztmp material-seam', async ({ page }) => {
	await page.goto('/?fixture=material-seam&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).segments.length === 2;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(20, 690);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-material-seam.png' });
});

test('ztmp divided-transition', async ({ page }) => {
	await page.goto('/?fixture=divided-transition&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).segments.length === 2;
	});
	await page.mouse.move(640, 360);
	for (let i = 0; i < 13; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(20, 690);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-divided-transition.png' });
});

test('ztmp g23', async ({ page }) => {
	await page.goto('/?fixture=downtown&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length > 5;
	});
	// g-2-3 (48,-48) ~ (709,291) default; pan to centre then zoom.
	await page.keyboard.down('Space');
	await page.mouse.move(600, 400);
	await page.mouse.down();
	await page.mouse.move(531, 469, { steps: 8 });
	await page.mouse.up();
	await page.keyboard.up('Space');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(20, 690);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-g23.png' });
});

test('ztmp median-meet', async ({ page }) => {
	await page.goto('/?fixture=median-meet&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).segments.length === 4;
	});
	// g-2-4 (142,-48) ~ (844,291) default; pan to centre then zoom.
	await page.keyboard.down('Space');
	await page.mouse.move(700, 300);
	await page.mouse.down();
	await page.mouse.move(496, 369, { steps: 8 });
	await page.mouse.up();
	await page.keyboard.up('Space');
	await page.mouse.move(640, 360);
	for (let i = 0; i < 16; i++) await page.mouse.wheel(0, -100);
	await page.mouse.move(20, 690);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-median-meet.png' });
});

test('ztmp paste-visual', async ({ page }) => {
	await page.goto('/?fixture=transition-demo&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).segments.length === 2;
	});
	// select the narrow segment a(-70,0)->mid(0,0), midpoint (-35,0)
	const S = 720 / 500;
	await page.locator('canvas').click({ position: { x: 640 + -35 * S, y: 360 } });
	await page.keyboard.press('Meta+c');
	await page.keyboard.press('Escape');
	await page.keyboard.press('Meta+v');
	await page.mouse.move(1100, 120);
	await page.waitForTimeout(300);
	await page.locator('canvas').screenshot({ path: '/tmp/ztmp-paste-visual.png' });
});

test('ztmp perf-drag', async ({ page }) => {
	const lines: string[] = [];
	page.on('console', (m) => {
		if (m.text().startsWith('PERF') || m.text().startsWith('BRK')) lines.push(m.text());
	});
	await page.goto('/?fixture=downtown&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length > 5;
	});
	const S = 720 / 500;
	// drag a horizontal avenue segment (around world (90,-48))
	const sx = 640 + 90 * S,
		sy = 360 + -48 * S;
	await page.mouse.move(sx, sy);
	await page.mouse.down();
	for (let i = 1; i <= 10; i++) await page.mouse.move(sx, sy + i * 3);
	await page.mouse.up();
	await page.waitForTimeout(200);
	await page.screenshot({ path: '/tmp/ztmp-drag-result.png' });
	console.log('---PERF---');
	for (const l of lines.slice(-12)) console.log(l);
});

test('ztmp memo-check', async ({ page }) => {
	await page.goto('/?fixture=downtown&topdown');
	await page.waitForFunction(() => {
		const r = localStorage.getItem('citynista-graph-v2');
		return !!r && JSON.parse(r).nodes.length > 5;
	});
	await page.screenshot({ path: '/tmp/ztmp-memo-downtown.png' });
});
