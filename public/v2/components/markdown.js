// Renders the md.js AST as Preact elements (no innerHTML). Headings are shifted so the page keeps one h1/h2.
import { html } from '../lib.js';
import { parse } from '../md.js';

function Inline({ nodes }) {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'code': return html`<code key=${i}>${n.v}</code>`;
      case 'b': return html`<strong key=${i}><${Inline} nodes=${n.c} /></strong>`;
      case 'i': return html`<em key=${i}><${Inline} nodes=${n.c} /></em>`;
      case 'a': return /^https?:/i.test(n.href)
        ? html`<a key=${i} href=${n.href} target="_blank" rel="noopener noreferrer"><${Inline} nodes=${n.c} /></a>`
        : html`<a key=${i} href=${n.href}><${Inline} nodes=${n.c} /></a>`;
      default: return n.v;
    }
  });
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
      case 'hr': return html`<hr key=${i} />`;
      default: return html`<p key=${i}><${Inline} nodes=${b.c} /></p>`;
    }
  })}</div>`;
}
