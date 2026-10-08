# CodeBlock

Code blocks show machine text (instructions, JSON, tool input/output), and `bu-prose` renders the markdown that Timmy and SKILL.md produce.

## Parts
- **`bu-code`:** `bg-sunken`, mono 12/16, soft-wrapped.
  - `bu-code__header` holds the uppercase label and a *Copier* ghost button.
  - `bu-code--scroll` caps the height at 256px.
  - Optional token classes: `tok-key`, `tok-str`, `tok-num`, for pretty-printed JSON only. No full syntax highlighter.
- **`bu-kbd`** and inline `code`: mono, radius-xs.
- **`bu-prose`:**
  - styles the HTML from `mdToHtml` (h1–h4 mapped onto `title`/`heading`, lists, code, links, blockquote);
  - line length is capped at `size-prose`;
  - this replaces the ~10 inline styles inside `mdToHtml`.

## Tokens
`bg-sunken`, `border-subtle`, `text-secondary`, `accent-text`, `success`, `warning`, type `mono-sm`, `body`, `title`, `heading`, `radius-card`, `radius-xs`, `size-prose`.
