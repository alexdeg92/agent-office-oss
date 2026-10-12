# Shared Bureau components

Import controls and rows from `public/v2/components/bureau/index.js` (a page module uses `../components/bureau/index.js`). Compositions in `primitives.js` are a secondary entry point, imported only by pages that use them so other routes do not pay for those examples. Direct component-module imports are also supported. A consuming route awaits the exported `loadStyles()` in its existing style-loading gate before rendering. This deduplicates `components/bureau/bureau.css`, uses the document's `buildQuery`, and reports load failures so the route can retry. Unrelated routes incur no additional stylesheet request. Component colors, typography, geometry and motion use semantic tokens, so the chosen identity can change tokens without changing the API.

## Switch

```js
import { html } from '../lib.js';
import { Switch, loadStyles as loadBureauStyles } from '../components/bureau/index.js';

// Await this alongside the route's current styles before rendering the page.
await loadBureauStyles();

// The page supplies the translated label and owns persistence.
html`<${Switch} checked=${enabled} label=${label}
  onCheckedChange=${setEnabled} busy=${saving} error=${error} />`;
```

Props: `checked`, `onCheckedChange(boolean)`, `label`, `busy=false`, `error?`, and common `id`, `class`, `testId`, `name`, `disabled=false`, `required=false`, `invalid=false`, `describedBy`.

Use Switch for an immediate preference. A page with synchronous storage can update its committed value in the callback. For an asynchronous operation, retain the committed `checked` value and set `busy` while requesting the change; adopt the requested value on success, or retain the old value and supply a translated recovery `error` on failure. The control restores native activation to the supplied value before calling the parent, so an uncommitted toggle is never displayed. It does not maintain a draft or perform persistence.

The native checkbox has `role=switch`, an associated visible label, and generated stable instance IDs when `id` is omitted. Its complete label area is the hit target (40px minimum desktop / 44px mobile), with a compact 40×24 track. Space and native label activation work. Busy exposes `aria-busy`/`aria-disabled`, shows a compact progress indicator with localized status, prevents duplicate activation and keeps keyboard focus. The switch's accessible name stays its visible label during loading. Progress motion respects reduced motion. Explicit `disabled` uses the native disabled property. `error` links an alert through `aria-describedby`; caller-provided description IDs are preserved. Missing errors emit no empty error node. Unknown props are not spread onto the control.

The page owns default-on semantics, saved-off restoration, storage, business labels and request failure handling. Use the separately specified Checkbox for staged Settings drafts. This checkpoint does not migrate Settings or office consumers.

Browser fixture and checks: `test/frontend/fixtures/bureau-switch.html` and `test/frontend/bureau-switch.browser.test.js`. The synthetic fixture is under tests, outside the shipped UI and gallery routes. Tests honor `AO_SKIP_BROWSER=1` and missing optional browser tooling through the shared lazy browser helper. Set `BUREAU_SCREENSHOTS=1` to capture current Bureau light/dark states at 1440×900, 390×844 and 375×667.

## SettingRow

Props: `label`, `description?`, `control?`, `status?`, `meta?`, `details?`, `environment?: {variable, reason?}`, and common `id`, `class`, `testId`. Desktop puts the control beside the text; mobile stacks it. Details span the row. Environment evidence is supplied by the caller and displayed in French/English.

A control callback receives `{id, describedBy}` to associate a native control with the visible row label and description. Pass those properties to the control (`describedBy` becomes `aria-describedby` on a native input). A VNode control slot must provide its own accessible label; this supports already-labelled Switch, Field and KeyValue compositions without wrapping interactive elements in a label.

```js
html`<${SettingRow} label=${portLabel} description=${portHelp}
  control=${props => html`<input id=${props.id} aria-describedby=${props.describedBy} />`} />`;
```

The native input above illustrates the association protocol; application forms use shared TextInput/Select/Checkbox controls.

## ListRow

Props: `avatar?`, `title`, `meta?`, `badges?`, `actions?`, `muted=false`, `selected=false`, `icon?`, `severity?`, `statusLabel?`, and common `id`, `class`, `testId`. Render under a semantic `ul`. The row is an `li`; actions are independent buttons or links. The whole row has no click behavior. Muted changes metadata color without reducing the row's opacity. Selected exposes `aria-current`. Names and IDs wrap. Avatar rendering remains the caller's existing shared Avatar/thumbnail responsibility; its slot is decorative because the adjacent title names the agent.

For diagnostics, `severity: 'error' | 'warn' | 'info' | 'ok' | 'unknown'` adds a compact leading status icon with distinct canonical sprite shapes and semantic colors. Its accessible localized label defaults to Error/Needs attention/Information/Healthy/Not checked (French equivalents included); pass `statusLabel` for truthful domain wording. Unknown severities become unknown. An `icon` VNode overrides the glyph and is decorative inside the named status. A leading icon without severity or statusLabel is decorative. Diagnostic row actions may use TextAction; information and healthy rows omit actions. The component does not decide whether a fix exists or whether a check succeeded.

## Menu

Props: translated `label`, `items=[]`, and common `id`, `class`, `testId`. Each item has a stable `id`, `label`, optional `icon`, `disabled`, `reason`, `danger`, and `kind: 'action' | 'link' | 'separator'`. Actions call `onSelect`; links use a native anchor and caller-approved `href`. Disabled actions remain focusable to expose their reason and never invoke the action. Separators use the panel's full width.

The trigger opens an anchored native popover above contained scrollers, clamped to the available viewport. Arrow keys, Home/End, Enter/Space, accent-insensitive typeahead, Escape, Tab exit and outside dismissal work. Escape/action selection returns focus to the opener. If an action removes its row, focus moves to the next surviving row control, the previous final row, or the list. Persistence, navigation policy and removal confirmation stay with the caller.

## KeyValue

Props: `label`, `value`, `mono=true`, `copyable=false`, `emptyLabel?`, and common `id`, `class`, `testId`. Uses `dl/dt/dd`, wraps long values, and keeps text selectable. Zero and false are data; null, undefined and an empty string use the empty label. Copy appears only for present values. Pending blocks repeated activation and retains focus; a status announces success only after clipboard completion. Failure announces manual selection/copy recovery. A changed value or unmounted component invalidates older copy results. Copy and feedback text are localized in French/English.

## TextAction

Props: `label`, `targetName?`, `onPress?`, `href?`, `busy=false`, `disabled=false`, `error?`, and common `id`, `class`, `testId`. Short visible action text plus a decorative canonical chevron; no filled or bordered button. The full target remains at least 40px desktop / 44px mobile. Labels wrap within trailing row space. With `targetName`, the localized accessible name combines action and named target (`Configurer : Claude Code` / `Configure: Claude Code`), retaining the visible action text.

Use `onPress` for a native button or a caller-approved `href` for a native link. Details/navigation elsewhere in the row remain independent. Busy blocks activation/navigation, preserves focus and the action name, exposes aria-busy/aria-disabled, and displays progress plus a localized announcement. An error is a linked alert; a subsequent action can retry. The caller owns pending state and business effects. Explicit disabled uses native disabled on a button; an unavailable link loses its href/tab stop and exposes aria-disabled. The component performs no network call or automatic confirmation.

## CollapsedGroup

Props: translated `label`, `children`, `defaultOpen=false`, and common `id`, `class`, `testId`. A native details/summary disclosure for groups such as `3 éléments en ordre`. The caller derives count/label and supplies actual evidence; no health inference occurs. Summary is the complete 40px desktop / 44px mobile target, with no nested action. Native Enter/Space and touch expansion preserve summary focus; label/count changes preserve expansion. Empty direct children omit the disclosure. Children remain in native collapsed content and enter accessibility/navigation when expanded.

## Field and native form controls

```js
import { Field, TextInput, Checkbox, Radio, Button,
  loadStyles as loadBureauStyles } from '../components/bureau/index.js';

html`<${Field} id="settings-port" label=${portLabel} hint=${portHint} error=${portError}
  control=${props => html`<${TextInput} ...${props} type="number" name="port"
    min=${1} max=${65535} value=${draft.port} onInput=${event => setPort(event.currentTarget.value)} />`} />`;
html`<${Checkbox} checked=${draft.enabled} label=${activationLabel}
  onCheckedChange=${setDraftEnabled} />`;
html`<${Button} type="submit" form="settings-form" label=${saveLabel}
  variant="primary" busy=${saving} />`;
```

Field props: `label`, `control(fieldProps)`, `hint?`, `error?`, `environment?:{variable,reason?}`, `required=false`, common `id`, `class`, `testId`. Its supplied `id` is **the native control ID**, preserving Settings selectors, rather than a wrapper ID. Omission generates a stable instance ID. The callback receives `{id,labelledBy,describedBy,invalid,required}`. Forward these to exactly one shared control. A visible label associates through `for`; optional hint, alert error and environment explanation have linked IDs. Removing evidence removes nodes and description references. Environment is evidence only: the page decides `readOnly`/`disabled` from its contract. Field does not fetch, validate or write data.

TextInput props: controlled `value`, `onValueChange(string)?`, native `onInput(event)?` and `onChange(event)?`, `type='text'`, `width='full'` (`content|short|medium|full`), `id`, `name`, `form`, `autoComplete` (or `autocomplete`), `min`, `max`, `step`, `maxLength` (or `maxlength`), `minLength`, `pattern`, `placeholder`, `inputMode`, `spellCheck` (or `spellcheck`), `readOnly=false`. Native events expose the actual requested value, including number drafts as strings. A declined or transformed edit restores the supplied value after callbacks; accepted edits retain the caret. Null/undefined value renders an empty string. Use **either** the controlled callback or a native event callback to update the draft; if both are supplied they both run, controlled first, then native. Neither stores or persists state.

TextArea has the same controlled/native value protocol, `rows=3`, `maxLength`/`maxlength`, `minLength`, `mono=false`, placeholder, spellCheck/spellcheck, autoComplete/autocomplete, native name/form and readOnly. It is a native resizable textarea, not an additional page scroller. Select uses native `select/option`, `value`, `onValueChange(string)?`, `onChange(event)?`, `onInput(event)?`, `options:[{value,label,disabled?}]`, `width='content'`, name/form and common association props. The controlled callback runs before the native change callback. The page supplies translated labels and converts numeric values itself.

All three accept `label` or Field's `labelledBy`, `describedBy`, `invalid`, `required`, `disabled`, `busy`, `onBlur`, `onFocus`, `class`, `testId`. A placeholder is not a label. Explicit disabled is native. Pending retains focus, exposes busy/unavailable semantics, displays progress, suppresses edits and restores the committed value. Text inputs become read-only while pending; pending Select blocks its native opening/selection without disabling the focused element. Busy never initiates a request. Inputs retain native autocomplete, password, number/URL validation and form association.

## Checkbox and Radio

Props: controlled `checked`, `onCheckedChange(boolean)?`, native `onInput(event)?`/`onChange(event)?`, `label`, native `id`, `name`, `value`, `form`, `required`, `disabled`, `busy`, `labelledBy`, `describedBy`, `invalid`, `onBlur`, `onFocus`, `class`, `testId`. Checkbox also accepts `mixed=false` (native indeterminate). Checkbox represents staged selection; immediate preferences use Switch. Both use a native input and associated label as a complete 40px desktop / 44px mobile target. The glyph is decorative geometry within that hit region. Supplied labels name the control; Field/SettingRow may supply association instead.

Radio is an individual native radio, not a new custom group widget. The page uses the same `name` and form for the intended group, a semantic fieldset/legend, distinct values and a controlled selected value. Native arrow navigation and FormData grouping remain intact. A declined radio edit restores the prior checked library sibling in the same native group. Mixed state remains parent-owned. Native input events run first according to browser order; on change, the controlled callback runs before the native change callback. Callbacks see the requested checked state before controlled restoration. Use one callback to update the parent. Busy blocks keyboard/touch activation, retains focus/name and shows progress; explicit disabled remains native. No toggle performs persistence.

## Button

Props: translated `label`, `variant='secondary'` (`primary|secondary|ghost|danger`), `size='md'` (`sm|md|lg`), `type='button'`, native `form`, `name`, `value`, `formAction`, `formMethod`, `formEncType`, `formTarget`, `formNoValidate`, `onPress()?`, native `onClick(event)?`, `icon?`, `iconOnly=false`, `title?`, `busy=false`, `busyLabel?`, `disabled`, `describedBy`, `onBlur`, `onFocus`, `id`, `class`, `testId`. The label stays the accessible name while pending. Icon-only usage requires the same label and exposes it in a title; the icon slot is decorative. Choose a single primary action in each area; danger fill is for an explicit destructive confirmation. Small still meets the 40/44 target minimum; large is at least 48px.

This is a native button: external `form` association, submit/implicit Enter, constraint validation, submitter name/value and reset behavior remain native. onPress runs first, then onClick; native onClick can prevent default when the caller deliberately manages submission. Avoid duplicate effects when passing both. Pending shows contrasting progress, announces localized status, keeps focus and blocks explicit/implicit activation. Native disabled is reserved for explicit disabled. Unknown props are not spread onto any native control, so they cannot override internal roles, associations or guarded event handlers. Services, actual busy lifecycle, translations, confirmation and draft conversion belong to the caller.

Browser evidence: `test/frontend/bureau-forms.browser.test.js` and its synthetic test-only fixture cover association cleanup, native attributes/events, accepted/declined/transformed input, mixed checkbox, native radio keyboard/decline restoration, external form submit/validation, busy activation and the light/dark 1440/390/375 matrix. `BUREAU_SCREENSHOTS=1` writes local source-pinned review artifacts; optional browser tooling and AO_SKIP_BROWSER use the existing shared helper.

## TabButton

Props: `id`, translated `label`, `selected=false` → native `aria-selected`, `controls?` → native `aria-controls`, `tabIndex` (defaults to selected ? 0 : -1), `disabled=false`, `title?`, native `onClick(event)`, `onKeyDown(event)`, `onFocus(event)`, `onBlur(event)`, `class`, `testId`. Use Preact's `key` on the component for stable keyed identity. The native button always has `type=button` and `role=tab`; ordinary Button continues to represent actions rather than tab selection.

The parent SettingsTabs/tablist still owns roving keyboard behavior, active-tab scroll, actual selected state, panel IDs and navigation. TabButton forwards native events unchanged and does not select, focus, scroll, submit or persist on its own. It preserves the existing native tab semantics and has a 40px desktop/44px mobile target, a token-colored active underline and visible keyboard focus. Disabled remains native. Do not use it outside a named tablist; the controlled panel has `role=tabpanel` and is named by the selected tab's id.

```js
html`<${TabButton} key=${tab.id} id=${tab.id} label=${tab.label}
  selected=${tab.id === activeTab} controls=${panelId} tabIndex=${rovingIndex}
  onClick=${event => selectTab(tab.id, event)} onKeyDown=${onTabKeyDown} />`;
```

## Compositions

`SettingsSection` provides a titled semantic section and optional description/actions. `Badge` distinguishes neutral metadata from the primary marker. `StatusChip` accepts `ok|warn|error|info|unknown|checking|disabled|unsupported`; only the first four use semantic severity colors, and every state includes text plus an icon. `Banner` accepts `info|success|warning|danger`, a cause/message, optional details and an action. Routine outcomes use `role=status`; blocking errors use `role=alert`.

`InlineEditableText` is an in-memory draft affordance: `value`, `label`, `onCommit(value)`, optional `emptyLabel`, `maxLength`, and `disabled`. Enter or Valider sends the valid value to the parent draft; Escape or Annuler restores the edit-start value. It never saves to the server. `SecretField` accepts `label`, `tokenSet`, `replacement`, `onReplacementChange`, optional environment/error and `disabled`; a stored value is only represented by “Jeton configuré”, never read into the DOM. `null` means preserve the stored token; typed text is a replacement draft owned and cleared by the parent.

`ConfirmDialog` composes the shared Frame-based Modal and Button. Its controlled `open`, title/description, confirm/cancel labels, callbacks, `busy`, error and optional children are presentation only; the parent owns the operation and confirmation scope. `Disclosure` is for caller-owned evidence and never infers status. `Link`, `EmptyState`, `Icon`, and `Frame` expose the existing canonical shared primitives through the Bureau API.

The owner-only living gallery is at `/v2/design-system` (with the runtime frontend base applied). It shows component families and state examples in the active light/dark identity tokens. The combined server protects the shell and its example assets; `/api/v2/design-system/access` ties access to the active owner account. A standalone static server omits the route and example assets unless an upstream owner-authenticated proxy explicitly enables them. The gallery is deliberately hidden from navigation. Candidate captures are written under `design/reports/bureau-components-1-gallery/`; pixel baselines remain pending designer approval.

The raw-control lint recursively scans runtime JavaScript outside this directory. Settings, the shared UI helpers and new pages must use these exports. Pre-existing non-Settings surfaces remain listed with per-file ceilings while they migrate; the scan rejects controls in new files and any increase in a legacy file.
