# Layout frames and scrolling

This is the rule every page follows, on desktop and mobile. It is structural: pages never fix scrolling locally.

## Why

When the document *and* an inner container can both scroll, the browser **chains** the scroll gesture. Once the inner container reaches its end, the gesture moves the page instead. On touch devices the page then rubber-bands, or keeps going, while the inner container stays put. Headers, tabs and footers drift because they live inside whatever happens to scroll. Every symptom of a page "going all around" comes from this. The fix is to make exactly one element per region able to scroll, and to make the document unable to.

## The rules

1. **The document never scrolls.**
   ```css
   html, body { height: 100%; overflow: hidden; overscroll-behavior: none; }
   ```
   `overscroll-behavior: none` on the root removes rubber-banding and pull-to-refresh on the page itself.

2. **The shell owns the viewport.**
   ```css
   .ao-app { position: fixed; inset: 0; display: grid;
             grid-template-columns: auto minmax(0, 1fr);
             height: 100vh; height: 100dvh; }
   ```
   Use `dvh` with a `vh` fallback. Respect safe areas with `env(safe-area-inset-*)` padding on the edge rows.

3. **A frame is a grid with fixed rows and one body.**
   ```css
   .ao-frame { display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; min-height: 0; height: 100%; }
   .ao-frame__head, .ao-frame__bar, .ao-frame__foot { min-height: 0; }   /* fixed rows: never scroll */
   .ao-frame__body { min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
   ```
   - The rows are head (title and actions), bar (tabs or filters), body, and foot (action bar).
   - A row that has nothing to show collapses to `auto` (0).
   - **The footer is the last grid row.** It sits at the frame's bottom edge whether the content is short or long. Footers never use `position: fixed`, nor `sticky; bottom: 0`.
   - `minmax(0, 1fr)` together with `min-height: 0` on every grid or flex ancestor is what lets the body shrink and scroll. Without them, a tall child grows the frame and the document overflows.

4. **Exactly one scroll container per region.**
   - The body scrolls. Its children don't, unless they are genuinely independent panes: a chat thread, a log viewer, a code block, or a catalogue next to a fixed preview.
   - Every independent pane gets `min-height: 0; overflow: auto; overscroll-behavior: contain`, so it never chains into its parent.
   - **Sticky is allowed only inside a scroller** (for example, section headers in a list). It is never a way to fake a frame row.

5. **Split panes** (e.g. Store: preview + catalogue) are a body with its own two-column grid.
   - Only the catalogue column scrolls.
   - The preview fits its column (`min-height: 0`, image `object-fit: contain`, `max-height: 100%`).

6. **One title per page.** The topbar carries the page title and subtitle. Frames don't repeat them in a hero, and page actions go in the topbar or at the end of the bar row.

7. **Mobile is the same frame.**
   - The bottom navigation is a shell grid row, so the frame ends above it and never under it.
   - The viewport meta tag includes `viewport-fit=cover` (for safe areas) and `interactive-widget=resizes-content`, so on Chromium the keyboard shrinks the frame instead of covering the footer.
   - There is no horizontal document scroll. Wide content scrolls inside its own container.

8. **Overlays** (sheets, dialogs, menus) are frames too: a fixed head and foot and a scrolling body with `overscroll-behavior: contain`. Because the document never scrolls, no "body scroll lock" hack is needed.

9. **Scroll position belongs to the scroller, not the window.**
   - Router code scrolls or restores `.ao-frame__body` (keyed by route plus tab), never `window`.
   - It restores after layout (in a `requestAnimationFrame`, so late content can grow).
   - Switching tabs inside a frame resets that frame's body to the top.

## How it is enforced

The browser test `test/frontend/layout.browser.test.js` checks every route at 1440×900 and 390×844, and again with short content and long content. It asserts that:
- `document.scrollingElement` can't scroll: its scrollHeight ≤ innerHeight and its scrollWidth ≤ innerWidth;
- each frame's body is the element that scrolls;
- the head, bar, foot and any fixed pane keep their bounding boxes after the body scrolls to the end;
- the foot's bottom edge equals the frame's bottom edge.

## References

- [CSS Overscroll Behavior (W3C)](https://www.w3.org/TR/css-overscroll-1)
- [Large, small and dynamic viewport units (web.dev)](https://web.dev/blog/viewport-units)
- `min-height: 0` / `minmax(0, 1fr)` for shrinkable grid and flex tracks: the [app-shell pattern](https://wiki.adom.inc/adom/adom-ui-design/files/skills/app-shell/SKILL.md)
- [Per-container scroll restoration (react-server)](https://react-server.dev/router/scroll-restoration). The app is vanilla JS, but the same principle applies.
