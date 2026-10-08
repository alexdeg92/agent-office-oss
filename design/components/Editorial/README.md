# Editorial

Reading layouts for pages that answer a question in sentences: **Bulletin** (Santé système), **Carnet** (Journaux) and **Feuillet** (Discuter). The voice, the message rules and the per-page structure come from `design/explorations/editorial-guide.md`. This file covers the classes.

## Anatomy
- **`bu-ed`**: the page container (`size-ed-page`). It is a size container, so the columns follow the space the page actually has, sidebar included.
- **`bu-ed-masthead`**: the page title (`__title`), an eyebrow and an `__edition` block (date, scope). It closes with the strong masthead rule (`size-rule-masthead`). Below it, `bu-ed-edition-line` holds one line of context.
- **`bu-ed-article`**: three columns, folio | reading column | margin (`size-ed-folio`, `size-ed-margin`, `space-8` gaps).
  - `--lead` is the opening story.
  - Adding **`bu-ed-section`** puts a strong neutral rule on top of a numbered section (`size-rule-section`).
  - `bu-ed-body--wide` spans the reading and margin columns.
- **`bu-ed-folio`**: the section number (01, 02…) or a date folio. It is **decorative**: give it `aria-hidden="true"`; the heading says the same. `--sm` is the mono caption size.
- **`bu-ed-kicker`, `bu-ed-headline`, `bu-ed-standfirst`, `bu-ed-title`, `bu-ed-prose`**: the type roles.
  - The headline uses `ed-lead` (44/52), switching to `ed-lead-sm` (32/40) when narrow.
  - The standfirst uses `ed-standfirst` (17/30); prose uses `ed-prose` (16/28).
  - All are capped at `size-ed-measure`.
- **`bu-ed-fig`**: a figure inside a sentence. It stays prose: only weight and `text-primary`, with tabular digits. **Never a KPI tile.**
- **`bu-ed-margin`**: one note per article (an `<aside>`), with `__label`, `__fact`, `__text` and an optional `bu-ed-link`. It holds secondary facts and evidence: ids, sources, freshness, the next run. The actionable problem stays in the body.
- **`bu-ed-ledger` / `bu-ed-entry`**: records with uneven heights. Each entry has:
  - `__no`: a stable position, never a rank;
  - `__body`, with `__title` and `__text`;
  - `__meta`: the margin;
  - `__actions`.

  `bu-ed-ledger--compact` drops the number column.
- **`bu-ed-details`**: a native `<details>` for technical detail, with a descriptive `<summary>`. Errors stay outside it.
- **`bu-ed-tone--danger|warning|success|info`**: the status colour for a word or a sentence. Always pair it with explicit wording; colour never carries the meaning alone.
- **`bu-ed-link`**: a text action with a 44 px target.

## Responsive
- **Under 900 px of container width:** the folio is dropped first, and the margin stays beside the text.
- **Under 640 px:** one column. Each margin note follows its article. The headline drops to `ed-lead-sm`, and the masthead title to `title-lg`.
- No CSS `order`: reading order is source order.

## Tokens
- Type: `ed-lead`, `ed-lead-sm`, `ed-standfirst`, `ed-prose`, `ed-folio`, `display`, `title-lg`, `heading`, `body`, `body-sm`, `label`, `caption`, `mono`, `mono-sm`.
- Sizes: `size-ed-page`, `size-ed-folio`, `size-ed-margin`, `size-ed-measure`, `size-rule-section`, `size-rule-masthead`, `size-touch`.
- Colours: `text-primary`, `text-secondary`, `text-tertiary`, `accent-text`, `border-default`, `border-subtle`, `danger`, `warning`, `success`, `info`, `focus-ring`.

Every text pair is already covered by `scripts/check-contrast.mjs` (text and status colours on `bg` and the surfaces). All pairs pass WCAG AA.
