# settings-ia-1: rethink Settings so anyone understands it — P0 (owner, 2026-10-10)

Owner: "Rethink the settings page with all the runtimes/agents, connection and integrations. They all seem so complicated to understand: what is what, and how do we set anything? It's over-complex and doesn't make sense; even I am lost."

## Problem
Today: 7 tabs, Diagnostic / Runtimes et agents / Connexion / Intégrations / Instance / Apparence / Compte. One connector (e.g. Claude Code) is spread over 3 tabs: detected in « Runtimes », configured in « Connexion », extended in « Intégrations ». The vocabulary (runtime, instance, adapter, integration) is engineering-speak.

## Proposed model (validate with the owner, then storyboard)
One sentence the UI teaches everywhere: **Connecteur → Agents → Bureau.** (Connect a tool, choose its agents, they appear in your office.)

New top-level sections (5, plain French):
1. **Connecteurs**: the gallery from connectors-gallery-1 (cards + logo + Actif badge). Detail sheet per connector with sub-tabs: **Connexion** (status, test, fields) · **Agents** (this connector's agents: in the office / discovered / excluded, auto-add) · **Extensions** (what used to be Intégrations for this connector: skills, hooks, with plan → confirm → apply). « Ajouter un connecteur » = guided setup (detect → test → choose agents → done).
2. **Agents**: every agent from every connector in one list: name, look, connector, in office yes/no, rename, appearance shortcut. Filter by connector.
3. **Santé**: today's Diagnostic + « Tout corriger » + restart, written as plain problems with one action each.
4. **Mon espace**: Instance + Apparence (identity themes, mode, animations, language).
5. **Utilisateurs et rôles** (admin, T-0047) + **Compte** (personal).

Rules: no word « runtime » or « instance » in the UI (use connecteur / connexion supplémentaire). Every screen answers "what is this, what's its state, what can I do". Empty states explain the next step. A first-run « Ajouter votre premier connecteur » path.

## Order
1. Designer: IA map + desktop/mobile storyboard of the 5 sections and the connector detail (all states), built on the Bureau components. PM shows it to the owner for a yes before any build.
2. Build split: access-codex (Connecteurs + detail + Agents, absorbing T-0053 UI and connectors-gallery-1), chars-b (Utilisateurs et rôles placement), office-codex (Santé). Reviewers: designer, critic, security.
