# Identity 1 — three rendered directions

2026-10-10 · Designer leads; chars-c renders · T-0035

Purpose: give the owner three credible, finished visual directions for the whole product. Preserve the existing illustrated office and original Bureau card design. Identity comes from a repeatable relationship between type, surfaces, proportions, icons and actions. It must survive Settings, setup, empty and error views. An accent-color swap over the same generic form is insufficient.

This document is the concrete rendering brief, not an approval. Product code and shared production tokens stay untouched. T-0030 API/behavior work may continue; its visual layer waits for the owner pick. T-0034 supplies structure in current Bureau styling and does not compete as another identity.

## Ownership and comparison controls

- Designer owns this brief, [refs.md](refs.md), review reports and the review criteria in the main checkout.
- Chars-c owns static HTML/CSS, isolated direction tokens, font/license artifacts and capture manifests under `design/identity-1/bureau/`, `observatoire/` and `atelier/` in the components worktree. Shared render mechanics may live inside those reserved directories. No live endpoints, real credentials or product mutations.
- PM presents the reviewed directions on a private comparison page. Each must receive an explicit designer GO before presentation. Owner choice and later token codification remain separate work; no winner is assumed.

All directions use the same office scene, crop, occupants, screen content and states. Use the existing actual office assets, not a stock illustration or a fake grid of emoji. The stage remains un-recolored so the comparison measures the chrome's relationship to it. Use real self-hosted fonts; screenshot capture waits for fonts and images and settled transitions. Changes made to pass contrast must be logged against the palette intent below.

## 1 · Bureau — a recognizable companion workspace

**Idea.** Keep the original ink-and-paper Bureau family and make its office-and-agent identity unmistakable. The mark's room corner, restrained cobalt selection and clearly drawn pack portraits recur with a small, disciplined set of forms. The office is generous; the tools feel accurately fitted around it. This is the closest continuation of the current product, with the greatest improvement in hierarchy and craft rather than a new layout fashion.

**Type.** Sora 600 for the page/step title; Inter 400/500/600 for body, controls and section hierarchy; JetBrains Mono for readable IDs and tabular machine values. Page title 20/28, section 16/24, body 14/20, help 12/16; do not create a marketing hero inside Settings.

**Color and material.** Inherit the existing Bureau dark/light semantic palette as the comparison anchor. Ink `#0E1117` / paper `#F5F4F0`, card `#151922` / white, primary accent `#5F5FF7` / `#4B4BE3`. Keep readable secondary/tertiary text, distinct status colors and existing tested focus/control colors. Borders separate purposeful cards; light resting elevation is shallow, dark depth comes from surface steps.

**Shape and density.** Control/card/panel radii 8/12/16. Purposeful section cards with aligned rows inside; no card per field or individually boxed KPI. Avatar-led roster, 64px resting rows that grow with wrapping. Page gutters 24 desktop/16 mobile. Short selectors stay short; name and URL fields have distinct bounded widths. The signature room-corner motif belongs to the mark and topology drawings, not a diagonal decoration on every container.

**Icons/motion/voice.** Consistent rounded line icons; coherent isometric topology miniatures. Brief 140ms selection/focus and 220ms disclosure, respecting reduced motion. Voice: “Timmy travaille. Deux agents sont disponibles.” Error: “La passerelle ne répond pas. Vérifiez son adresse, puis réessayez.”

## 2 · Observatoire — a precise live instrument

**Idea.** Treat the office as a live instrument with carefully calibrated surrounding controls. Deep blue-green surfaces, crisp cyan interaction and Plex's technical humanity create a different family from the purple SaaS dashboard. The counters become a concise instrument strip; the agents remain named companions in the same illustrated room. Technical precision comes through alignment and tabular values, with plain language rather than exposed debug data.

**Type.** IBM Plex Sans 400/500/600 for titles, names and body; IBM Plex Mono for numeric summary, IDs and verified timestamps. Page title 20/28, section 16/24, body 14/20, help 12/16. Avoid monospacing whole forms or using tiny all-caps text as a substitute for hierarchy.

| Palette intent | Dark | Light |
| --- | --- | --- |
| Background | `#081117` | `#F1F6F7` |
| Card | `#101D24` | `#FFFFFF` |
| Raised surface | `#15232B` | `#F7FAFB` |
| Overlay | `#17252D` | `#FFFFFF` |
| Main text | `#ECF4F6` | `#13232C` |
| Secondary text | `#C0D0D7` | `#344E5A` |
| Tertiary text | `#97A9B2` | `#50616A` |
| Interactive fill | `#087B98` | `#006B87` |

**Shape and density.** Control/card/panel radii 6/8/12. Matte cards and compact segmented controls; clear small gutters rather than heavy boxes. One tabular KPI strip with meaningful separators and one details action. Shared roster rows start at 56–64px and keep full 44px mobile targets. Use a subtle coordinate-like frame rhythm, not decorative rulers or a cockpit of indicators. Menu/sheet controls share the same exact edge and icon anatomy.

**Icons/motion/voice.** Squarer line caps and corner joins within one coherent icon set; topology miniatures emphasize connections between host, browser and room. Motion tracks real changes: a pending verification, an opened detail, a selection. Voice: “3 agents connectés · 1 en cours.” Error: “Connexion interrompue. Relancer la vérification.” Never say connected before evidence exists.

## 3 · Atelier — a warm, durable place to work

**Idea.** Give the illustrated wood-and-ink office a surrounding material family: warm stone, deep brown-black and a controlled oxide accent. Soft cards remain visibly structured and purposeful. Names and values receive a more open human rhythm, while controls remain compact and precise. This is a material variation of Bureau's card design, not the previously rejected Carnet/Bulletin editorial direction.

**Type.** Manrope 600 for titles and agent names; Source Sans 3 400/600 for body and controls; JetBrains Mono for machine values. Page title 20/28, section 16/24, body 15/20, help 12/16. Maintain the same information budget; warmth does not justify bigger empty cards.

| Palette intent | Dark | Light |
| --- | --- | --- |
| Background | `#191513` | `#F6F1E9` |
| Card | `#231D19` | `#FFFCF7` |
| Raised surface | `#2A221D` | `#FAF5ED` |
| Overlay | `#2D251F` | `#FFFCF7` |
| Main text | `#F5EFE9` | `#30251F` |
| Secondary text | `#D2C2B5` | `#5F4C40` |
| Tertiary text | `#BAA797` | `#715C4D` |
| Interactive fill | `#B55A32` | `#A14425` |

**Shape and density.** Control/card/panel radii 10/16/20. Shallow material elevation in light; distinct matte surfaces in dark. A generous stage card, compact roster grouping and concise configuration card produce hierarchy through scale. Resting agent rows start at 64px; 16px card padding and a 4px spacing grid remain. No paper texture, ornamental dividers, manuscript typography or colored-border cards.

**Icons/motion/voice.** Softer consistent line caps with the same architectural topology logic. Purposeful 180–220ms sheet/detail movement, reduced-motion alternative. Voice: “Votre bureau est prêt. Timmy peut commencer.” Only use that success sample after actual verification. Error: “Le moteur est injoignable. Vérifiez qu'il est démarré, puis réessayez.”

## Same screens and content in every direction

| Screen | Required composition/content |
| --- | --- |
| Bureau | Same room and three occupants. Timmy primary, Scout and Scribe. Compact summary “3 agents · 1 en cours”. Desktop: generous scene, clearly secondary roster. Mobile390/375: scene visible immediately after the single title and concise summary; primary-led compact roster; options in a sheet. |
| Settings → Runtimes et agents | Timmy/Scout/Scribe avatar roster first. Timmy Principal; one hidden agent and a long-name variant. Readable ID captions; runtime picker fits content. Compact evidence below roster: OpenClaw detected with true fixture timestamp, another connector Non vérifié. Menu/confirmation and staged save contract from T-0030. Include a short port/language control specimen in expanded configuration so fit can be judged. |
| Onboarding Accès | One step title and visible step/progress context; six named topology choices from the access brief, coherent original icons and useful one-line descriptions. Local selected. Proper card selection affordance and Retour/Continuer frame footer; mobile body scrolls. No fake DNS/TLS success or invented percent. This is one identity screen, not approval of the complete T-0033 flow. |
| Empty | “Aucun agent connecté”, concise setup cause, “Configurer un moteur”. The office stage remains a meaningful empty scene. No fabricated occupants or cheerful success indicator. |
| Error | “La passerelle ne répond pas”, useful next action, “Réessayer”. Retain a previous scene only if visibly labelled “Dernier état vérifié”; no En direct badge that contradicts the error. Use semantic status treatment, not the interaction accent. |

Each of these five screens: 1440×900, 390×844 and 375×667, both themes. Also capture mobile options sheet, expanded KPI state and long roster/name state in both themes at 390/375. Static examples must clearly remain synthetic review artifacts without putting implementation/debug notes into the product composition.

### Owner correction — surprise animations belong in Settings

The owner requests that “Animations surprises” live in Settings, enabled by default. This supersedes the earlier T-0034 proposal to put that toggle in the Bureau options sheet. Keep the office focused on the scene; place the control in Settings → Appearance as an immediate preference, with a concise explanation. The default is `true` when no preference is stored; preserve an explicit saved `false` across reloads. Current `surprisesEnabled()` already implements this default. Use the shared Switch contract for an immediate preference; do not add it to staged runtime configuration. All three direction studies and the T-0034 storyboard must reflect this placement. Implementation remains with the builder; designer reviews the resulting Settings placement and office captures at 1440/390/375 in both themes.

## Review and handoff

Chars-c supplies complete inherited semantic tokens per direction, generated local CSS, local font/license manifest, screenshots with scenario/viewport/theme/revision, and contrast output. Every normal small text pair must meet 4.5:1; focus/control boundaries 3:1. Use the canonical checker against each isolated token set, including semantic status/state separation; preserve or adapt the inherited status palette when surfaces change. Record any palette adjustment. Geometry and contrast checks do not replace visual inspection.

Designer opens every capture and judges scene priority, primary-agent identity, typography, fit of controls, mobile roster/sheet, meaningful cards, empty/error honesty, and whether each direction has a distinct family resemblance across office, Settings and access. Findings name exact screenshots and a concrete correction. **GO means suitable for owner comparison, not approval to ship or apply production tokens.**

Then PM presents the three directions side by side. After the owner chooses or mixes, map the chosen source tokens into Bureau, update its identity guidance, and resume the T-0030 visual layer and T-0033 complete storyboard. The owner pick cannot be inferred from elapsed time or a designer preference.
