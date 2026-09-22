/**
 * Regenerate the icon set from `web/icon.svg`.
 *
 *   npm run icons
 *
 * Installing a PWA on Android needs real PNGs at 192 and 512, plus a maskable
 * variant that survives being cropped to a circle or a squircle; iOS wants a
 * flattened apple-touch-icon with no transparency of its own. Hand-drawing four
 * sizes of the same mark is how icons drift, so they are all rendered from one
 * source at one moment.
 *
 * `web/` only. v1's `public/` folder belongs to a server that no longer runs and
 * is left exactly as it was.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

/** The app's paper colour, matching `--paper` in web/styles.css. */
const PAPER = { r: 0xf5, g: 0xf3, b: 0xef, alpha: 1 };

/** Render the SVG mark at `size`, optionally inset inside a paper square. */
async function mark(svg, size, scale = 1) {
  const inner = Math.round(size * scale);
  const rendered = await sharp(svg, { density: 400 })
    .resize(inner, inner, { fit: 'contain', background: { ...PAPER, alpha: 0 } })
    .png()
    .toBuffer();

  if (scale === 1) return rendered;

  return sharp({ create: { width: size, height: size, channels: 4, background: PAPER } })
    .composite([{ input: rendered, gravity: 'center' }])
    .png()
    .toBuffer();
}

async function write(target, buffer) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  console.log(`  ${target} (${(buffer.length / 1024).toFixed(1)} KB)`);
}

for (const dir of ['web']) {
  const source = fs.readFileSync(path.join(dir, 'icon.svg'));
  console.log(`icons from ${dir}/icon.svg`);

  await write(path.join(dir, 'pwa-192x192.png'), await mark(source, 192));
  await write(path.join(dir, 'pwa-512x512.png'), await mark(source, 512));
  // 62% keeps the mark inside the safe zone Android may crop to a circle.
  await write(path.join(dir, 'pwa-maskable-512x512.png'), await mark(source, 512, 0.62));
  // iOS rounds the corners itself and dislikes alpha, so inset it and flatten.
  await write(
    path.join(dir, 'apple-touch-icon.png'),
    await sharp(await mark(source, 180, 0.7)).flatten({ background: PAPER }).png().toBuffer(),
  );
}
