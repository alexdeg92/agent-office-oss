# office-floors-1: floors + elevator, gym, entrance/smoking area — and two office bugs

Owner (2026-10-10, capture design/reports/office-stale-sofa-before.png, local).

## A. Bugs (P0, office-codex)
1. **Grey, frozen office while the chip says « Live ».** The whole scene dims and freezes with « La scène montre le dernier état observé » although the stream is up. `page.js:246-249` greys the office whenever `office.meta.stale` lists *any* source. Find which source was stale in prod (log it, redacted) and fix it:
   - one stale secondary source (e.g. transcripts capacity/limit, an enricher, herdr) must not grey the whole office; only the agents fed by that source show a small "dernier état" marker;
   - full dim/freeze only when the stream itself is down;
   - the chip and the stage must agree.

   Also note: prod shares the box with our test suites (load 12, CPU 100% in the capture). Builders and the PM run suites with `nice -n 19`.
2. **Sofa overlap:** two agents on the sofa occupy the same seat point (fox + bot merged, layering glitch). Multi-seat furniture must expose N distinct seat anchors (sofa: 2–3, bench, etc.) with correct z-order per seat. Test: 2 and 3 occupants on one sofa have distinct positions and a stable draw order.

## B. Floors and elevator (P1, decor builds; designer storyboard first)
- Replace « Annexe N » rooms below the office with **floors** (Étage 1, 2, …). Overflow agents get assigned to the next floor. The Bureau page shows one floor at a time.
- **Elevator:** an elevator door sprite on each floor plus a floor picker (elevator panel UI: buttons « RDC, 1, 2, … », plus counts of agents per floor and their status). Choosing a floor plays a short elevator transition (reduced-motion: instant).
- **Special floors/areas:**
  - **Rez-de-chaussée / Entrée:** lobby with reception, and outside the door a **smoking area** where idle agents go « en pause » (cartoon, non-graphic; ambient idle behaviour, never during work).
  - **Gym:** treadmill, weights, bench, mat; idle/long-idle agents may go there.

  These are visit destinations in the existing life/visits system: agents walk to the elevator, ride, and appear on the destination floor. Their roster status stays truthful (« en pause », « au gym » only when idle).
- Floors are data-driven (layout registry): any number of floors; each floor is a layout validated by the existing rules; furniture packs from T-0046 usable on every floor; the Store/editor edits the current floor.
- Deep links (`?etage=2`), mobile floor picker (bottom sheet), roster grouped by floor with a jump action.
- Scale: N floors × N agents; only the visible floor renders; the others are summarized.
- Tests: overflow → floor assignment, elevator navigation, visits across floors, reduced motion, mobile, budget.

Reviewers: designer (storyboard + final), critic, security (no new data exposure).
