// A small, safe Markdown subset for SKILL.md bodies: parse → AST (pure, no HTML strings), rendered by
// components/markdown.js as Preact elements. Nothing is ever inserted as HTML, so raw HTML in the source shows as text.
// Blocks: headings, paragraphs, lists, fenced code, quotes, rules and GFM pipe tables.
// Inline: `code`, **bold**, *italic* / _italic_, [text](https://… or relative) links.

const SAFE_LINK = /^(https?:\/\/|mailto:|\/(?![\/\\])|#)/i;

export function parseInline(src) {
  const out = [];
  let text = '';
  const flush = () => { if (text) { out.push({ t: 'text', v: text }); text = ''; } };
  for (let i = 0; i < src.length;) {
    const rest = src.slice(i);
    let m;
    if ((m = /^`([^`]+)`/.exec(rest))) { flush(); out.push({ t: 'code', v: m[1] }); i += m[0].length; continue; }
    if ((m = /^\*\*(.+?)\*\*/.exec(rest))) { flush(); out.push({ t: 'b', c: parseInline(m[1]) }); i += m[0].length; continue; }
    if ((m = /^(\*|_)(?!\s)(.+?)(?<!\s)\1(?![\w*])/.exec(rest)) && !(m[1] === '_' && /\w/.test(src[i - 1] || ''))) {
      flush(); out.push({ t: 'i', c: parseInline(m[2]) }); i += m[0].length; continue;
    }
    if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      flush();
      if (SAFE_LINK.test(m[2])) out.push({ t: 'a', href: m[2], c: parseInline(m[1]) });
      else out.push(...parseInline(m[1])); // unsafe scheme: keep the text, drop the link
      i += m[0].length; continue;
    }
    text += src[i]; i++;
  }
  flush();
  return out;
}

// Split unescaped pipes, including escaped pipes inside inline code/emphasis.
function tableCells(line) {
  const cells = []; let cell = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && i + 1 < line.length) {
      cell += line[i + 1] === '|' ? '|' : line[i] + line[i + 1]; i++;
    } else if (line[i] === '|') { cells.push(cell.trim()); cell = ''; }
    else cell += line[i];
  }
  cells.push(cell.trim());
  if (line.trimStart().startsWith('|')) cells.shift();
  if (line.trimEnd().endsWith('|') && cells.at(-1) === '') cells.pop();
  return cells;
}
const startsBlock = line => /^\s*$|^ {0,3}(?:#{1,6}\s|>|```|[-*+]\s|\d+[.)]\s|(?:-{3,}|\*{3,})\s*$)/.test(line);

export function parse(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flushPara = () => { if (para.length) { blocks.push({ t: 'p', c: parseInline(para.join(' ')) }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = /^```\s*([\w-]*)\s*$/.exec(line))) {
      flushPara();
      const body = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      blocks.push({ t: 'code', lang: m[1] || null, v: body.join('\n') });
      continue;
    }
    const delimiter = i + 1 < lines.length && line.includes('|') ? tableCells(lines[i + 1]) : [];
    if (delimiter.length && delimiter.every(cell => /^:?-+:?$/.test(cell))) {
      const header = tableCells(line);
      if (header.length === delimiter.length && !startsBlock(line)) {
        flushPara();
        const align = delimiter.map(cell => cell.startsWith(':') ? (cell.endsWith(':') ? 'center' : 'left') : cell.endsWith(':') ? 'right' : null);
        const rows = []; i++;
        while (i + 1 < lines.length && !startsBlock(lines[i + 1])) {
          const cells = tableCells(lines[++i]);
          rows.push(header.map((_, column) => parseInline(cells[column] || '')));
        }
        blocks.push({ t: 'table', header: header.map(parseInline), align, rows });
        continue;
      }
    }
    if (/^\s*$/.test(line)) { flushPara(); continue; }
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { flushPara(); blocks.push({ t: 'h', level: m[1].length, c: parseInline(m[2].trim()) }); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); blocks.push({ t: 'hr' }); continue; }
    if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      flushPara();
      const q = [m[1]];
      while (i + 1 < lines.length && (m = /^\s*>\s?(.*)$/.exec(lines[i + 1]))) { q.push(m[1]); i++; }
      blocks.push({ t: 'quote', c: parseInline(q.join(' ')) });
      continue;
    }
    if ((m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      flushPara();
      const ordered = /\d/.test(m[1]);
      const items = [m[2]];
      while (i + 1 < lines.length && (m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i + 1])) && /\d/.test(m[1]) === ordered) { items.push(m[2]); i++; }
      blocks.push({ t: ordered ? 'ol' : 'ul', items: items.map(parseInline) });
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  return blocks;
}

// Summary/preview text uses the same supported Markdown syntax as the full trace.
export function plainText(md) {
  const inline = (nodes) => nodes.map((n) => n.c ? inline(n.c) : n.v || '').join('');
  return parse(md).map((b) => b.t === 'table' ? [b.header, ...b.rows].map(row => row.map(inline).join(' · ')).join('\n') : b.items ? b.items.map(inline).join('\n') : b.c ? inline(b.c) : b.v || '').filter(Boolean).join('\n');
}
