import { expect, test, type Page } from '@playwright/test';
import { openScene } from './scenes';

// Every handle rests white over a dark outline and takes the selection
// palette's tint for its state. The scene, at 4× zoom: a curved road a–b
// (offset 2 m right of its line), a straight road through node t, where a
// narrow street widens into an avenue over a 20 m taper, and a T junction j
// with a crossing on one arm and a switched-off one on another.
const ZOOM = 4;
const PX = (720 / 500) * ZOOM;
const toScreen = (x: number, y: number) => ({ x: 640 + x * PX, y: 360 + y * PX });

// Mean red, green and blue (0-255) of the 3x3 screen pixels around a point.
async function colourAt(page: Page, at: { x: number; y: number }) {
	const png = await page.screenshot({
		clip: { x: at.x - 1.5, y: at.y - 1.5, width: 3, height: 3 }
	});
	return page.evaluate(async (data) => {
		const img = new Image();
		img.src = `data:image/png;base64,${data}`;
		await img.decode();
		const canvas = document.createElement('canvas');
		canvas.width = img.width;
		canvas.height = img.height;
		const ctx = canvas.getContext('2d');
		if (!ctx) return [-1, -1, -1];
		ctx.drawImage(img, 0, 0);
		const px = ctx.getImageData(0, 0, img.width, img.height).data;
		const sum = [0, 0, 0];
		for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += px[i + c];
		return sum.map((v) => Math.round(v / (px.length / 4)));
	}, png.toString('base64'));
}

// The colour a handle shows in each state (editor-palette.ts).
const tone = ([r, g, b]: number[]) =>
	r > 225 && g > 225 && b > 225
		? 'rest'
		: r < 140 && g > 200 && b > 220
			? 'hover'
			: r > 220 && g > 180 && b < 90
				? 'active'
				: `rgb(${r}, ${g}, ${b})`;
const toneAt = async (page: Page, at: { x: number; y: number }) => tone(await colourAt(page, at));

test('every handle rests white and is tinted for its state', async ({ page }, testInfo) => {
	await openScene(page, 'handles', `topdown&cam=0,0,${ZOOM}`);
	await expect(page.locator('nav')).toBeVisible();

	// The curved road: its curvature handle on the control point (moved by
	// the offset), and its offset handle a quarter of the way along.
	const curve = toScreen(-65, -3);
	const offset = toScreen(-76.61, 12.41);
	const road = toScreen(-53.4, 12.41);
	await page.mouse.click(road.x, road.y);
	await expect(page.locator('aside')).toBeVisible();
	await expect.poll(() => toneAt(page, curve)).toBe('rest');
	expect(await toneAt(page, offset)).toBe('rest');
	const roadShot = await page.screenshot({ clip: { x: 80, y: 290, width: 380, height: 230 } });

	await page.mouse.move(curve.x, curve.y);
	await expect.poll(() => toneAt(page, curve)).toBe('hover');
	expect(await toneAt(page, offset)).toBe('rest');
	await page.mouse.down();
	await expect.poll(() => toneAt(page, curve)).toBe('active');
	await page.mouse.up();
	await expect.poll(() => toneAt(page, curve)).toBe('hover');

	// Node t: a taper handle on each road where the 20 m taper ends.
	await page.keyboard.press('Escape');
	const node = toScreen(25, 20);
	await page.mouse.click(node.x, node.y);
	const tapers = [toScreen(15, 20), toScreen(35, 20)];
	for (const at of tapers) await expect.poll(() => toneAt(page, at)).toBe('rest');
	await page.mouse.move(tapers[1].x, tapers[1].y);
	await expect.poll(() => toneAt(page, tapers[1])).toBe('hover');
	expect(await toneAt(page, tapers[0])).toBe('rest');
	await page.mouse.move(tapers[1].x, tapers[1].y + 60);
	await expect.poll(() => toneAt(page, tapers[1])).toBe('rest');
	const taperShot = await page.screenshot({ clip: { x: 660, y: 400, width: 250, height: 150 } });

	// Junction j in the lane connector: a crossing switched on (striped) on
	// its east arm, one switched off (a hollow frame) on its west arm.
	await page.keyboard.press('Escape');
	const junction = toScreen(70, -30);
	await page.mouse.dblclick(junction.x, junction.y);
	await page.mouse.move(junction.x, junction.y + 150);
	const crossingShot = await page.screenshot({ clip: { x: 900, y: 80, width: 300, height: 200 } });
	await page.keyboard.press('Escape');

	// The circle tool's direction arrow, on the ring under the cursor and
	// pointing up the screen (counter-clockwise): its head is just above.
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'One-way lane' }).click();
	await page.getByRole('button', { name: 'Circle', exact: true }).click();
	const centre = toScreen(-60, -35);
	const rim = toScreen(-45, -35);
	await page.mouse.click(centre.x, centre.y);
	await page.mouse.move(rim.x, rim.y);
	await expect.poll(() => toneAt(page, { x: rim.x, y: rim.y - 3 })).toBe('rest');
	const circleShot = await page.screenshot({ clip: { x: 190, y: 50, width: 220, height: 220 } });

	// All of them side by side, in one picture.
	const sheet = await page.context().newPage();
	const img = (png: Buffer, label: string) =>
		`<figure style="margin:0"><img src="data:image/png;base64,${png.toString('base64')}"><figcaption>${label}</figcaption></figure>`;
	await sheet.setContent(
		`<main style="display:flex;align-items:flex-start;gap:12px;padding:12px;background:#222;font:12px sans-serif;color:#ddd;width:max-content">
			${img(roadShot, 'Curved road: curve + offset')}
			${img(taperShot, 'Two-road node: tapers')}
			${img(circleShot, 'Circle: direction')}
			${img(crossingShot, 'Connector: crossings on and off')}
		</main>`
	);
	await sheet.locator('main').screenshot({ path: testInfo.outputPath('handles.png') });
	await sheet.close();
});
