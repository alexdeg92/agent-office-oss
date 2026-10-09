// State markers for the fx layer (README §4.2). Icons are Lucide paths (ISC licence), drawn inline.
// Colour comes from the --bu-state-* token of the occupant's state (office.css), never from here.

const icon = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const ICONS = {
  // lucide: book-open
  reading: icon('<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>'),
  // lucide: pen-line
  pen: icon('<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>'),
  // lucide: phone
  phone: icon('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.91.69 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.33 1.85.56 2.81.69A2 2 0 0 1 22 16.92z"/>'),
  // lucide: hourglass
  hourglass: icon('<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>'),
};

/** Inner HTML for a marker kind. Decorative: the nameplate carries the accessible state. */
export function markerHtml(kind) {
  switch (kind) {
    case 'thought':
      return '<span class="ao-mk ao-mk--thought"><i></i><i></i><i></i></span>';
    case 'question':
      return `<span class="ao-mk ao-mk--pill"><b>?</b>${ICONS.hourglass}</span>`;
    case 'alert':
      return '<span class="ao-mk ao-mk--pill ao-mk--solid"><b>!</b></span>';
    case 'zz':
      return '<span class="ao-mk ao-mk--pill ao-mk--zz"><b>z</b><b>z</b></span>';
    case 'reading':
    case 'pen':
    case 'phone':
      return `<span class="ao-mk ao-mk--pill ao-mk--${kind}">${ICONS[kind]}</span>`;
    default:
      return '';
  }
}
