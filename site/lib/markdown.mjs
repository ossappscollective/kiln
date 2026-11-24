// A small, dependency-free Markdown renderer for the Kiln site.
// Supports: headings (with ids), paragraphs, bullet and numbered lists (nested, tight and loose), fenced and
// indented code, tables, blockquotes (and GitHub-style alerts), horizontal rules, inline code, emphasis, links,
// images (shown as links: the site makes no third-party requests) and autolinks.
// Safety: every piece of text is HTML-escaped, raw HTML in the source is shown as text, and only http, https and
// mailto addresses (plus relative ones) survive in links.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export function unescapeHtml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Lowercase, letters and digits joined by dashes. */
export function slugify(text) {
  const slug = String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

/** Allow http, https, mailto and scheme-less addresses; everything else (javascript:, data:, vbscript:) becomes '#'. */
export function safeUrl(url) {
  const trimmed = String(url).trim();
  // Browsers ignore tabs, newlines and control characters inside a scheme: strip them before looking.
  const probe = trimmed.replace(/[\u0000- \u007f-\u009f]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(probe);
  if (scheme && !['http', 'https', 'mailto'].includes(scheme[1].toLowerCase())) return '#';
  return trimmed;
}

const NUL = '\u0000';

function resolvePlaceholders(text, stash) {
  let out = text;
  for (let guard = 0; guard < 8 && out.includes(NUL); guard++) {
    out = out.replace(/\u0000(\d+)\u0000/g, (_, n) => stash[Number(n)] ?? '');
  }
  return out;
}

function stashValue(stash, html) {
  stash.push(html);
  return `${NUL}${stash.length - 1}${NUL}`;
}

function inline(src, ctx, stash) {
  let s = src.replace(/\u0000/g, '');
  // code spans
  s = s.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _t, body) => {
    const text = /^ .*[^ ].* $/s.test(body) ? body.slice(1, -1) : body;
    return stashValue(stash, `<code>${escapeHtml(text.replace(/\n/g, ' '))}</code>`);
  });
  // backslash escapes and hard breaks
  s = s.replace(/\\\n/g, () => stashValue(stash, '<br>\n'));
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, (_, ch) => stashValue(stash, escapeHtml(ch)));
  // images become links to their source: nothing is embedded
  s = s.replace(
    /!\[([^\]]*)\]\(\s*(<[^>]*>|(?:[^\s()]|\([^\s()]*\))*)(?:\s+"[^"]*")?\s*\)/g,
    (_, alt, url) => {
      const href = linkHref(url, ctx);
      const label = escapeHtml(alt || 'image');
      return stashValue(stash, `<a href="${escapeHtml(href)}">${label}</a>`);
    },
  );
  // links
  s = s.replace(
    /\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*(<[^>]*>|(?:[^\s()]|\([^\s()]*\))*)(?:\s+"([^"]*)")?\s*\)/g,
    (_, text, url, title) => {
      const href = linkHref(url, ctx);
      const inner = inline(text, ctx, stash);
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return stashValue(stash, `<a href="${escapeHtml(href)}"${t}>${inner}</a>`);
    },
  );
  // autolinks <https://...>
  s = s.replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi, (_, url) =>
    stashValue(stash, `<a href="${escapeHtml(safeUrl(url))}">${escapeHtml(url)}</a>`),
  );
  s = escapeHtml2(s);
  // emphasis
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<![\w])__(?=\S)([\s\S]*?\S)__(?![\w])/g, '<strong>$1</strong>');
  s = s.replace(/\*(?=[^\s*])([^*]*?[^\s*])\*/g, '<em>$1</em>');
  s = s.replace(/(?<![\w])_(?=[^\s_])([^_]*?[^\s_])_(?![\w])/g, '<em>$1</em>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  s = s.replace(/ {2,}\n/g, '<br>\n');
  return s;
}

// escapeHtml leaves the NUL placeholders (and the HTML already stashed behind them) intact.
const escapeHtml2 = escapeHtml;

function linkHref(rawUrl, ctx) {
  let url = rawUrl.trim();
  if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1);
  url = unescapeHtml(url);
  const resolved = ctx.resolveLink ? ctx.resolveLink(url) : url;
  return safeUrl(resolved);
}

/** Render inline Markdown to HTML. */
export function renderInline(src, ctx = {}) {
  const stash = [];
  return resolvePlaceholders(inline(src, ctx, stash), stash);
}

/** Plain text of an inline Markdown string (for ids, search and descriptions). */
export function inlineText(src) {
  return unescapeHtml(
    renderInline(src)
      .replace(/<br>/g, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Blocks

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])( +|$)/;
const QUOTE = /^ {0,3}>/;
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

const isBlank = (line) => /^\s*$/.test(line);
const indentOf = (line) => /^ */.exec(line)[0].length;

function isTableStart(lines, i) {
  return (
    i + 1 < lines.length &&
    lines[i].includes('|') &&
    lines[i + 1].includes('-') &&
    TABLE_DELIM.test(lines[i + 1]) &&
    (lines[i + 1].includes('|') || lines[i].trim().startsWith('|'))
  );
}

function startsBlock(lines, i, inParagraph) {
  const line = lines[i];
  if (FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line)) return true;
  if (/^\s*<!--/.test(line)) return true;
  const m = LIST.exec(line);
  if (m) {
    if (!inParagraph) return true;
    // an item may interrupt a paragraph if it is a bullet or the number 1, and has content
    const marker = m[2];
    const hasContent = line.trim().length > marker.length;
    return hasContent && (/^[-*+]$/.test(marker) || /^1[.)]$/.test(marker));
  }
  return isTableStart(lines, i);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let tick = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      cur += s.slice(i, i + n);
      i += n - 1;
      tick = tick === 0 ? n : tick === n ? 0 : tick;
    } else if (c === '|' && tick === 0) {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function alignOf(cell) {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return '';
}

function parseBlocks(lines, ctx, opts) {
  const out = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    // html comment: dropped
    if (/^\s*<!--/.test(line)) {
      while (i < n && !lines[i].includes('-->')) i++;
      i++;
      continue;
    }
    // fenced code
    let m = FENCE.exec(line);
    if (m) {
      const indent = m[1].length;
      const fence = m[2];
      const lang = m[3].replace(/[^\w+#.-]/g, '');
      const body = [];
      i++;
      while (i < n) {
        const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
        if (close.test(lines[i])) {
          i++;
          break;
        }
        body.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ''));
        i++;
      }
      const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      out.push(
        `<div class="code-block"${langAttr}><pre tabindex="0"><code${cls}>${escapeHtml(body.join('\n'))}</code></pre></div>`,
      );
      continue;
    }
    // heading
    m = HEADING.exec(line);
    if (m) {
      const level = m[1].length;
      const text = m[2];
      i++;
      if (opts.top && level === 1 && ctx.title === undefined) {
        ctx.title = inlineText(text);
        if (ctx.dropFirstH1) continue;
      }
      const html = renderInline(text, ctx);
      if (opts.top) {
        const plain = inlineText(text);
        let id = slugify(plain);
        const base = id;
        for (let k = 2; ctx.ids.has(id); k++) id = `${base}-${k}`;
        ctx.ids.add(id);
        ctx.headings.push({ level, text: plain, id });
        out.push(
          `<h${level} id="${escapeHtml(id)}">${html}<a class="anchor" href="#${escapeHtml(id)}" aria-label="Link to this section">#</a></h${level}>`,
        );
      } else out.push(`<h${level}>${html}</h${level}>`);
      continue;
    }
    // hr
    if (HR.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    // table
    if (isTableStart(lines, i)) {
      const head = splitRow(lines[i]);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      const rows = [];
      while (i < n && !isBlank(lines[i]) && lines[i].includes('|') && !startsBlock(lines, i, false)) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const cell = (tag, text, k) => {
        const a = aligns[k] ? ` style="text-align:${aligns[k]}"` : '';
        return `<${tag}${a}>${renderInline(text ?? '', ctx)}</${tag}>`;
      };
      const thead = `<thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map((r) => `<tr>${head.map((_, k) => cell('td', r[k], k)).join('')}</tr>`)
        .join('')}</tbody>`;
      out.push(
        `<div class="table-wrap" role="region" aria-label="Table" tabindex="0"><table>${thead}${tbody}</table></div>`,
      );
      continue;
    }
    // blockquote
    if (QUOTE.test(line)) {
      const inner = [];
      while (i < n && !isBlank(lines[i])) {
        if (QUOTE.test(lines[i])) inner.push(lines[i].replace(/^ {0,3}> ?/, ''));
        else if (!startsBlock(lines, i, true)) inner.push(lines[i]);
        else break;
        i++;
      }
      const alert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(inner[0] ?? '');
      if (alert) {
        const kind = alert[1].toLowerCase();
        const label = kind[0].toUpperCase() + kind.slice(1);
        const body = parseBlocks(inner.slice(1), ctx, { top: false });
        out.push(
          `<aside class="callout callout-${kind}"><p class="callout-title">${label}</p>${body}</aside>`,
        );
      } else {
        out.push(`<blockquote>${parseBlocks(inner, ctx, { top: false })}</blockquote>`);
      }
      continue;
    }
    // list
    if (LIST.test(line)) {
      const res = parseList(lines, i, ctx);
      out.push(res.html);
      i = res.next;
      continue;
    }
    // indented code
    if (/^( {4}|\t)/.test(line)) {
      const body = [];
      while (i < n && (isBlank(lines[i]) || /^( {4}|\t)/.test(lines[i]))) {
        body.push(lines[i].replace(/^( {4}|\t)/, ''));
        i++;
      }
      while (body.length && isBlank(body[body.length - 1])) body.pop();
      out.push(
        `<div class="code-block"><pre tabindex="0"><code>${escapeHtml(body.join('\n'))}</code></pre></div>`,
      );
      continue;
    }
    // paragraph
    const para = [line.replace(/^\s+/, '')];
    i++;
    while (i < n && !isBlank(lines[i]) && !startsBlock(lines, i, true)) {
      para.push(lines[i].replace(/^\s+/, ''));
      i++;
    }
    const text = para.join('\n');
    if (ctx.firstParagraph === undefined && opts.top) ctx.firstParagraph = inlineText(text);
    const html = renderInline(text, ctx);
    out.push(opts.tight ? html : `<p>${html}</p>`);
  }
  return out.join('\n');
}

function parseList(lines, start, ctx) {
  const n = lines.length;
  const first = LIST.exec(lines[start]);
  const ordered = /\d/.test(first[2]);
  const startNumber = ordered ? Number.parseInt(first[2], 10) : 1;
  const items = [];
  let loose = false;
  let i = start;
  while (i < n) {
    const m = LIST.exec(lines[i]);
    if (!m || /\d/.test(m[2]) !== ordered) break;
    const spaces = m[3].length;
    const gap = spaces === 0 || spaces > 4 ? 1 : spaces;
    const contentIndent = m[1].length + m[2].length + gap;
    const itemLines = [lines[i].slice(contentIndent)];
    let blankInside = false;
    i++;
    while (i < n) {
      const ln = lines[i];
      if (isBlank(ln)) {
        let j = i + 1;
        while (j < n && isBlank(lines[j])) j++;
        if (j < n && indentOf(lines[j]) >= contentIndent) {
          for (let k = i; k < j; k++) itemLines.push('');
          blankInside = true;
          i = j;
          continue;
        }
        break;
      }
      if (indentOf(ln) >= contentIndent) {
        itemLines.push(ln.slice(contentIndent));
        i++;
      } else if (LIST.test(ln)) {
        break; // the next item of this list, or of the parent
      } else if (!startsBlock(lines, i, true) && !isBlank(itemLines[itemLines.length - 1] ?? '')) {
        itemLines.push(ln.trim()); // lazy continuation
        i++;
      } else break;
    }
    items.push({ lines: itemLines, blankInside });
    if (i < n && isBlank(lines[i])) {
      let j = i;
      while (j < n && isBlank(lines[j])) j++;
      const next = j < n ? LIST.exec(lines[j]) : null;
      if (next && /\d/.test(next[2]) === ordered && indentOf(lines[j]) < contentIndent) {
        loose = true;
        i = j;
        continue;
      }
      break;
    }
  }
  const tight = !loose && !items.some((it) => itemHasBlankBetweenBlocks(it.lines));
  const rendered = items.map((it) => {
    const body = parseBlocks(it.lines, ctx, { top: false, tight });
    return `<li>${body}</li>`;
  });
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && startNumber !== 1 ? ` start="${startNumber}"` : '';
  return { html: `<${tag}${startAttr}>${rendered.join('')}</${tag}>`, next: i };
}

/** True when an item holds two block-level parts separated by a blank line outside a code fence. */
function itemHasBlankBetweenBlocks(itemLines) {
  let inFence = false;
  let sawContent = false;
  let blank = false;
  for (const l of itemLines) {
    if (FENCE.test(l)) inFence = !inFence;
    if (inFence) {
      sawContent = true;
      continue;
    }
    if (isBlank(l)) {
      if (sawContent) blank = true;
    } else {
      if (blank && !/^ {2,}([-*+]|\d+[.)])\s/.test(l) && !/^([-*+]|\d+[.)])\s/.test(l)) return true;
      sawContent = true;
      blank = false;
    }
  }
  return false;
}

/**
 * Render a Markdown document.
 * @param {string} source
 * @param {{ resolveLink?: (url: string) => string, dropFirstH1?: boolean }} [options]
 * @returns {{ html: string, title: string | undefined, headings: {level:number,text:string,id:string}[], firstParagraph: string }}
 */
export function renderMarkdown(source, options = {}) {
  const ctx = {
    resolveLink: options.resolveLink,
    dropFirstH1: options.dropFirstH1 ?? false,
    headings: [],
    ids: new Set(options.reservedIds ?? []),
    title: undefined,
    firstParagraph: undefined,
  };
  const lines = String(source)
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .split('\n')
    .map((l) => l.replace(/^(\t+)/, (t) => '    '.repeat(t.length)));
  const html = parseBlocks(lines, ctx, { top: true });
  return {
    html,
    title: ctx.title,
    headings: ctx.headings,
    firstParagraph: ctx.firstParagraph ?? '',
  };
}
