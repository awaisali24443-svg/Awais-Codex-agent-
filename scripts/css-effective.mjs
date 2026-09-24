/**
 * Effective-declaration dumper: what the browser would actually apply.
 *
 * The stylesheet has grown by appending — that is how a UI gets built in
 * rounds — so several selectors are declared more than once and later blocks
 * win. Before removing the duplicates, this prints the *effective* declaration
 * set per selector (last value per property wins), so the same output before
 * and after proves the cleanup changed nothing.
 *
 * Usage: node scripts/css-effective.mjs > /tmp/before.json
 */
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../web/styles.css', import.meta.url), 'utf-8');

/** Strip comments so a `{` inside one does not break the scan. */
const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * One brace-matching pass. Everything top-level is either a declaration block
 * or an at-rule; `@media` bodies are walked the same way and their keys carry
 * the query, so a rule inside a breakpoint can never be confused with the same
 * selector outside it.
 */
const out = {};
{
  const addDecls = (selectorText, body) => {
    for (const raw of selectorText.split(',').map((t) => t.trim()).filter(Boolean)) {
      out[raw] ??= {};
      for (const decl of body.split(';').map((d) => d.trim()).filter(Boolean)) {
        const at = decl.indexOf(':');
        if (at < 0) continue;
        out[raw][decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
      }
    }
  };

  const walkBlocks = (text, prefix) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) return;
      let depth = 1;
      let close = open + 1;
      while (close < text.length && depth > 0) {
        if (text[close] === '{') depth += 1;
        else if (text[close] === '}') depth -= 1;
        close += 1;
      }
      const selector = text.slice(i, open).trim();
      const body = text.slice(open + 1, close - 1);
      if (selector.startsWith('@media') || selector.startsWith('@supports')) {
        walkBlocks(body, `${prefix}${selector.replace(/\s+/g, ' ')} :: `);
      } else if (!selector.startsWith('@')) {
        addDecls(`${prefix}${selector}`, body);
      }
      i = close;
    }
  };

  walkBlocks(clean, '');
}

const sorted = {};
for (const key of Object.keys(out).sort()) sorted[key] = out[key];
process.stdout.write(JSON.stringify(sorted, null, 1));
