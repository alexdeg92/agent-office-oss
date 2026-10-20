// Renders the md.js AST as Preact elements (no innerHTML). Headings are shifted so the page keeps one h1/h2.
import { html, useEffect, useRef, useState } from '../lib.js';
import { parse } from '../md.js';
import { msg } from '../i18n.js';
import '../messages/markdown.js';

const cellStyle = align => ({ padding: 'var(--bu-space-2) var(--bu-space-3)', borderBottom: '1px solid var(--bu-border-subtle)', textAlign: align || 'left' });

function Inline({ nodes }) {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'code': return html`<code key=${i}>${n.v}</code>`;
      case 'b': return html`<strong key=${i}><${Inline} nodes=${n.c} /></strong>`;
      case 'i': return html`<em key=${i}><${Inline} nodes=${n.c} /></em>`;
      case 'a': return /^(https?:|mailto:)/i.test(n.href)
        ? html`<a key=${i} href=${n.href} target="_blank" rel="noopener noreferrer"><${Inline} nodes=${n.c} /></a>`
        : html`<a key=${i} href=${n.href}><${Inline} nodes=${n.c} /></a>`;
      default: return n.v;
    }
  });
}

function Table({ block }) {
  const scroll = useRef(null);
  const [position, setPosition] = useState({ left: 0, width: 100, before: false, after: false });
  const measure = () => {
    const el = scroll.current;
    if (!el) return;
    const total = el.scrollWidth, visible = el.clientWidth, offset = el.scrollLeft;
    const next = { left: total ? offset / total * 100 : 0, width: total ? visible / total * 100 : 100,
      before: offset > 1, after: total - visible - offset > 1 };
    setPosition(old => Object.keys(next).every(key => next[key] === old[key]) ? old : next);
  };
  useEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll.current);
    observer.observe(scroll.current.firstElementChild);
    return () => observer.disconnect();
  }, [block]);
  const fade = position.before || position.after
    ? `linear-gradient(to right, ${position.before ? 'transparent, black 24px' : 'black'}, ${position.after ? 'black calc(100% - 24px), transparent' : 'black'})` : 'none';
  return html`<div class="ao-md__table-frame" style=${{ minWidth: 0, maxWidth: '100%' }}>
    <div ref=${scroll} class="ao-md__table-scroll" role="region" aria-label=${msg('markdown.table')} tabindex="0" onScroll=${measure}
      style=${{ maxWidth: '100%', minWidth: 0, overflowX: 'auto', overflowY: 'hidden', overscrollBehaviorX: 'contain', overscrollBehaviorY: 'auto', touchAction: 'pan-x pan-y', maskImage: fade,
        scrollbarWidth: 'thin', scrollbarColor: 'var(--bu-text-tertiary) var(--bu-border-subtle)' }}>
      <table class="ao-md__table" style=${{ borderCollapse: 'collapse', width: 'max-content', minWidth: '100%' }}>
        <thead><tr>${block.header.map((cell, k) => html`<th key=${k} scope="col" style=${cellStyle(block.align[k])}><${Inline} nodes=${cell} /></th>`)}</tr></thead>
        ${block.rows.length ? html`<tbody>${block.rows.map((row, r) => html`<tr key=${r}>${row.map((cell, k) => html`<td key=${k} style=${cellStyle(block.align[k])}><${Inline} nodes=${cell} /></td>`)}</tr>`)}</tbody>` : null}
      </table>
    </div>
    ${position.width < 100 ? html`<div class="ao-md__table-rail" aria-hidden="true"
      style=${{ position: 'relative', height: '4px', marginTop: '4px', borderRadius: '4px', background: 'var(--bu-border-subtle)' }}>
      <span class="ao-md__table-thumb" style=${{ position: 'absolute', height: '100%', borderRadius: 'inherit', background: 'var(--bu-text-tertiary)', left: position.left + '%', width: position.width + '%' }}></span>
    </div>` : null}
  </div>`;
}

export function Markdown({ source, headingOffset = 2 }) {
  const blocks = parse(source);
  return html`<div class="bu-prose ao-md">${blocks.map((b, i) => {
    switch (b.t) {
      case 'h': { const H = 'h' + Math.min(6, b.level + headingOffset); return html`<${H} key=${i}><${Inline} nodes=${b.c} /></${H}>`; }
      case 'ul': return html`<ul key=${i}>${b.items.map((it, k) => html`<li key=${k}><${Inline} nodes=${it} /></li>`)}</ul>`;
      case 'ol': return html`<ol key=${i}>${b.items.map((it, k) => html`<li key=${k}><${Inline} nodes=${it} /></li>`)}</ol>`;
      case 'code': return html`<pre key=${i} class="bu-code"><code>${b.v}</code></pre>`;
      case 'quote': return html`<blockquote key=${i}><${Inline} nodes=${b.c} /></blockquote>`;
      case 'table': return html`<${Table} key=${i} block=${b} />`;
      case 'hr': return html`<hr key=${i} />`;
      default: return html`<p key=${i}><${Inline} nodes=${b.c} /></p>`;
    }
  })}</div>`;
}

/** Structured VM cells are plain text, using the same bounded table scroller. */
export function DataTable({headers,rows}) {
 const cell=text=>[{t:'text',v:text}];
 return html`<${Table} block=${{header:headers.map(cell),align:headers.map(()=>null),rows:rows.map(row=>row.map(cell))}} />`;
}
