# Login

The login page is the one place where the office illustration meets the chrome: the brand panel on the left, a single form on the right.

## Layout
- `bu-login`: two columns on desktop.
- `bu-login__art` (desktop only) holds:
  - the brand;
  - the pitch (`display`, Sora);
  - the lede;
  - `bu-login__stage` with the day-office illustration, via `--art` with a fallback list of image URLs;
  - a footer line.
- **Mobile:** the art panel is hidden and the form sits at the top, respecting the safe area.

## Form
- *Courriel*, *Mot de passe*, then *Se connecter* (`--lg`, full width).
- The error is a `bu-banner--danger` linked with `aria-describedby`. It never reveals whether the account exists.
- **No pre-filled email** (the current app ships one).
- Use `autocomplete="username"` / `"current-password"` so password managers work. The current `autocomplete="off"` blocks them.

## Copy
Use *Agent Office* as the product name and *Timmy* as the agent. Drop "banc d'essai" and the version tag.

## Tokens
`bg`, `bg-sunken`, `surface`, `border-subtle`, `radius-panel`, type `display`, `body-lg`, `title-lg`, `space-12`.
