/**
 * Where does this code think it is?
 *
 * This one file exists because getting it wrong broke production twice in the
 * same way. `import.meta.url` is the obvious way to find your own directory and
 * it is the wrong one here: the server is bundled to CommonJS for production,
 * where `import.meta.url` is undefined. Worse, the candidates were built
 * eagerly, so `new URL(import.meta.url)` threw before the list was ever
 * examined — discarding a perfectly good path sitting in position one.
 *
 * None of it showed up under `tsx`, because tsx runs the TypeScript directly
 * and `import.meta.url` is perfectly valid there. That is the whole lesson:
 * when the development command and the production command take different
 * paths, only one of them is ever being tested.
 *
 * So: no `import.meta`, every probe defensive, and both layouts always checked.
 */
import fs from 'node:fs';
import path from 'node:path';

// Present in the bundled CommonJS output, absent under tsx. Declared so the
// probe below type-checks in an ES module.
declare const __dirname: string | undefined;

/** Directories that might contain what we are looking for, most likely first. */
export function moduleDirs(): string[] {
  const dirs: string[] = [process.cwd()];

  if (typeof __dirname === 'string' && __dirname) dirs.push(__dirname);

  const script = process.argv[1];
  if (script) dirs.push(path.dirname(path.resolve(script)));

  return [...new Set(dirs)];
}

/**
 * Find a directory by trying each candidate location.
 *
 * @param relatives paths to try under each module directory, e.g. `web` or
 *                  `server/migrations`
 * @param marker    a file that must exist inside it, to avoid matching an empty
 *                  directory of the same name
 */
export function findDir(relatives: string[], marker?: string): string | null {
  const tried: string[] = [];

  for (const dir of moduleDirs()) {
    for (const relative of relatives) {
      // Both `dist/../web` and `dist/web` are plausible, so check the parent too.
      for (const candidate of [path.join(dir, relative), path.join(dir, '..', relative)]) {
        tried.push(candidate);
        try {
          if (!fs.existsSync(candidate)) continue;
          if (marker && !fs.existsSync(path.join(candidate, marker))) continue;
          return candidate;
        } catch {
          // A candidate we cannot stat is simply not the one.
        }
      }
    }
  }

  console.warn(`[paths] nothing found for ${relatives.join(' | ')}. Looked in:\n  ${tried.join('\n  ')}`);
  return null;
}
