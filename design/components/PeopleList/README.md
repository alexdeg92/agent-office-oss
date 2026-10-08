# PeopleList

The people list, titled *Personnes impliquées*, shows everyone involved in a project, grouped by kind: humans from Discord, agents (Timmy and sub-agents), and git authors.

## Groups (in this order)
1. **Humains · Discord:** avatar (Discord image or initials), name, `role` · handle, `Discord` tag.
2. **Agents:** Timmy first, then sub-agents. Each shows the agent avatar with a state ring, the `role`, and the live **state badge**.
3. **Auteurs git:** git avatar, name, email in mono, commit count.

- A git author who matches a known human is merged into the human entry.
- Clicking a human opens their Habilitations detail page. Clicking an agent opens the Bureau agent drawer.

## Data
`people[{kind: human|agent|git, name, avatar, role}]`. The live agent state and the commit count come from elsewhere: the summary and the repo.

## Tokens
type `heading-sm`, `caption`, `label-sm`, `state-*`, `border-subtle`.
