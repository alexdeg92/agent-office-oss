# The project tag (OpenClaw)

Agent Office builds the Projets board from what it can see. Part of that needs no change to the agent:
- **Conversation rooms:** a Discord channel named like a ticket (`#PIVOT-2735`) or a project (`#restaurant-banner`, `#Perroquet SaaS`).
- **Ticket keys** in a session's label or goal, or in a scheduled flow's name.
- **Working directories** outside the workspace root.
- **Code repositories** and their commits.

The **project tag** adds what only the agent knows: which project a conversation is about, and where that project stands.

The tag is **metadata only**. The agent emits it as a call to a no-op tool. The call stays in the session's history, which Agent Office reads; **it is never sent to a channel or a person**. Agent Office never shows it as conversation text either.

## How it works
1. On its own judgement, whenever it takes on substantial work, the agent runs the `projet` skill: `node <skills>/projet/projet.js tag <slug> <statut> <P0-P9> ["titre"] [note]`.
   - Substantial work means building or producing something, a long or multi-step request, or ongoing work. Not simple questions, quick lookups, small talk or one-off searches.
   - The script does nothing: it reads no file or variable, writes nothing and contacts nothing. It only prints an acknowledgement.
2. Agent Office reads the transcripts of sessions with new activity (at most 3 per refresh, newest first) and finds those calls (`src/adapters/openclaw/project-hint.js`).
3. **A tag whose slug names an existing project:**
   - the conversation is linked to that project, like a manual link. A follow-up in another conversation, with the same slug, attaches too;
   - its status and priority are set to the tagged ones, once each, by the agent;
   - a change you make after the tag wins.
4. **A tag for any other slug creates the project on the board by itself,** as the agent, with the tag's title, status and priority. The project keeps answering to its slug whatever its name.
   - A slug creates a project **once, for good**. An old tag never re-creates a project you archived, renamed or unlinked.
   - Candidates from rooms, folders and repositories stay suggestions under Projets → Importer.

Statuses:

| Tag | Projets status |
| --- | --- |
| `idee` | Idée |
| `a-faire` | À faire |
| `en-cours` | En cours |
| `en-revue` | En revue |
| `livre` | Livré |

An unknown status still links the conversation, without changing the status.

**Priority.** The agent rates it P0–P9: P0 is the most urgent and important, P9 the least, judged from urgency and impact. The board uses the same ten levels, so the value is taken as it is.

## Install: Agent Office does it
- **First-run setup** offers « Installer l’étiquette projet » for the primary agent. It's on by default; untick it to opt out.
- **Later, from the terminal** (the same configuration as the server):
  ```sh
  agent-office integrations status            # the primary agent; --agent <id>… or --all for others
  agent-office integrations install [--dry-run]
  agent-office integrations uninstall
  ```
- **What it writes**, only in the agent's workspace (never `openclaw.json`):
  - `skills/projet/` (`SKILL.md` in the instance's language, and `projet.js`);
  - the marker-delimited block near the top of `AGENTS.md`, in the instance's language. `AGENTS.md` is backed up first, into Agent Office's own data directory (`<data dir>/integrations/backups/<agent>-AGENTS.md-<time>`, the last 5 kept), never into the agent's workspace.
- **It's safe to repeat:** a second run changes nothing, and a newer release updates the block in place.
- **It doesn't overwrite what it didn't write:** a `skills/projet/` of someone else's, or broken markers, is a `conflict`, and needs `--force`.
- **Uninstall** removes exactly what install added.
- **Switching it off:** `AO_INTEGRATIONS=none` or `integrations.projet: false` in the instance config. A read-only instance never writes.
- **What it never does:** change the exec policy. It reports it (`status`, `agent-office doctor`) when the policy would ask for approval.

## Install by hand (the same result; needs the operator's OK)
**1. Check that a tool call can't reach a channel.** Read-only:
```sh
openclaw config get channels.discord.streaming
```
- With `mode` `off` (the default), tool calls are never shown.
- With `partial`, `block` or `progress`, tool activity can appear in the temporary draft. Set `streaming.preview.toolProgress` and `streaming.progress.toolProgress` to `false`. Keep `commandText` at `status`, the default. Do the same for any other streaming channel.
- `/verbose on` in a chat echoes tool summaries there. Leave it off.

**2. Install the skill.** Copy `integrations/openclaw/projet/` (`SKILL.md` and `projet.js`) into the agent's skills directory, for example `<workspace>/skills/projet/`.

**3. Allow the command.** Add `node <skills>/projet/projet.js` to the exec allowlist. Otherwise every call asks for an approval, and the approval prompt shows the command.

**4. Add the instruction.** Put it in the main agent's **`AGENTS.md`**, near the **top**.
- To find the file: `openclaw agents list --json` gives the `workspace` of `main` (default `~/.openclaw/workspace`).
- Why this file: `AGENTS.md` is the only workspace file OpenClaw 2026.9.8 loads in **every** session kind. Main, direct messages, rooms, cron sessions (which get only AGENTS, SOUL, IDENTITY and USER) and sub-agents (which get only AGENTS) all see it.
- Why near the top: the file is cut at 20,000 characters, and when that happens the head is kept.

Paste this block exactly:

```markdown
<!-- agent-office:projet:debut -->
<!-- agent-office:projet v2 -->
## Étiquette projet (Agent Office)
De ta propre initiative, même si personne ne dit « projet », tiens le tableau de projets à jour avec la compétence `projet` :
`node <skills>/projet/projet.js tag <slug> <statut> <P0-P9> ["titre"] [note]`
- Étiquette tout travail substantiel : construire ou produire quelque chose, une demande longue ou en plusieurs étapes, un travail suivi.
  Ex. : « monte une page d’accueil pour le resto », « prépare la migration de la base clients », « suis le ticket PIVOT-2735 ».
- N’étiquette pas : une question simple, une recherche rapide, une conversation légère.
  Ex. : « quelle heure est-il à Tokyo ? », « trouve le numéro du fournisseur », « merci, bonne soirée ».
- slug : court, en minuscules avec des tirets (menu-builder, pivot-2735). Pour une suite, même dans une autre conversation, reprends exactement le même slug.
- statut : idee, a-faire, en-cours, en-revue ou livre. Priorité : de P0 (le plus urgent et important) à P9, selon l’urgence et l’impact.
- Quand tu remets ton travail au demandeur (un plan, un livrable, quelque chose à valider) : en-revue, jamais livre.
- livre seulement quand le demandeur confirme que c’est terminé ou accepté, ou te demande de le clore.
- Si le demandeur demande des changements : en-cours (ou a-faire si tu ne t’y mets pas tout de suite).
- Appelle-la quand le travail commence, puis à chaque changement de statut ou de priorité.
- C’est une métadonnée pour le tableau de bord : ne la mentionne jamais dans tes réponses, à personne.
<!-- agent-office:projet:fin -->
```
Replace `<skills>` with the skill's real directory.

**5. Check.** Ask the agent, in a private session, to tag a test project. Then:
- the session's history in OpenClaw shows an `exec` call;
- Agent Office's Projets → Importer lists the slug within a minute;
- the reply you received doesn't mention it.

## Removal
1. Delete the block between `<!-- agent-office:projet:debut -->` and `<!-- agent-office:projet:fin -->` in `AGENTS.md`. New sessions stop tagging; running ones may tag until they end.
2. Remove `skills/projet/` and the allowlist entry.
3. Agent Office needs nothing. Tags already read stay as links and history. Projects keep their status.
