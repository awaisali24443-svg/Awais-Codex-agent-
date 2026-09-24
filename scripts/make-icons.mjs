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

/**
 * The badge's own darkest tone, matching the stop at 100% of `wais-bg`.
 *
 * A maskable icon is cropped to a circle or a squircle by the launcher, and the
 * crop must not reveal anything that is not the icon — so the inset mark is
 * composited onto its own background colour rather than onto paper, and the
 * result reads as one full-bleed badge at any crop.
 */
const BADGE = { r: 0x0f, g: 0x0e, b: 0x16, alpha: 1 };

/** Render the SVG mark at `size`, optionally inset inside a filled square. */
async function mark(svg, size, scale = 1, background = PAPER) {
  const inner = Math.round(size * scale);
  const rendered = await sharp(svg, { density: 400 })
    .resize(inner, inner, { fit: 'contain', background: { ...background, alpha: 0 } })
    .png()
    .toBuffer();

  if (scale === 1) return rendered;

  return sharp({ create: { width: size, height: size, channels: 4, background } })
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
  // The large one exists because the install prompt on Android and the app
  // stores both ask for it, and a manifest that offers only a 512 gets
  // "no icon available at 1024" — which is how an installable app looks
  // unfinished at the exact moment somebody decides to install it.
  await write(path.join(dir, 'pwa-1024x1024.png'), await mark(source, 1024));
  // Maskable: the launcher crops this to a circle or a squircle that reaches the
  // edges, so the badge's own rounded corners and hairline border would show up
  // inside the crop as a seam. The maskable copy therefore squares the corners,
  // drops the border, and scales the monogram to 80% — inside Android's safe
  // zone — leaving the gradient to bleed to every edge.
  // (a Buffer, not a string: sharp() treats a string as a path)
  const bleed = Buffer.from(
    source
      .toString()
      .replace('rx="24"', 'rx="0"')
      .replace(/<rect x="\.9"[^/]*\/>/, '')
      .replace(
        '<g id="wais-mark">',
        '<g id="wais-mark" transform="translate(50 50) scale(.8) translate(-50 -50)">',
      ),
  );
  await write(path.join(dir, 'pwa-maskable-512x512.png'), await mark(bleed, 512));
  // iOS rounds the corners itself and dislikes alpha, so inset it and flatten.
  await write(
    path.join(dir, 'apple-touch-icon.png'),
    await sharp(await mark(source, 180, 0.86, BADGE)).flatten({ background: BADGE }).png().toBuffer(),
  );
}
