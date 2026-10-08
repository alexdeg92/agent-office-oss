# Chat

The Discuter page is a single conversation with Timmy: user bubbles on the right, agent replies on the left with an identity header, and a composer at the bottom.

## Messages
- **`bu-msg--user`:** an accent-filled bubble with `text-on-accent` and a squared bottom-right corner. This replaces the Discord blurple.
- **`bu-msg--agent`:**
  - the head shows the avatar, *Timmy* and meta in mono (model · duration · tokens);
  - the bubble is `surface` with `bu-prose` for markdown, indented to align with the name.
  - There's no coloured left border.
- **`bu-msg--system`:** a centred pill for session markers.
- **`bu-msg--error`:** a danger-tinted bubble, used for failed sends. Never use a raw "⚠" glyph.
- **`bu-typing`:** three pulsing dots in `state-thinking`, with `role="status"` and the label *Timmy réfléchit*. They stop pulsing under reduced motion.

## Composer
- The textarea auto-grows up to 128px.
- **Enter** sends; **Maj+Entrée** adds a new line.
- The send button is an icon button with `aria-label="Envoyer"`, disabled while a reply is pending.
- On mobile the composer sits above the bottom bar and respects the safe area.

## Empty state
`bu-empty` with 2–3 `bu-suggestion` prompts that fill the composer when clicked.

## Read-only conversations
Habilitations and Journaux show conversations with **Trace**, not with Chat.

## Tokens
`accent`, `text-on-accent`, `surface`, `surface-raised`, `border-subtle`, `state-thinking`, `danger-bg`, `radius-card`, `radius-xs`, `size-prose`.
