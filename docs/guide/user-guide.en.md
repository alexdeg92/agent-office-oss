# Using Agent Office

[Lire ce guide en français](user-guide.fr.md)

Agent Office helps you follow your primary agent, its activity and the projects it contributes to. Start with the sentence at the top of a page: it tells you what needs attention. The supporting details follow, with times, sources and references in the margin.

This guide describes the features offered by each page. Availability depends on your version, the connection to your agent runtime and your instance’s permissions. A page marked as coming soon is not yet available in that version.

## Find the right page

| To… | Open… |
| --- | --- |
| See the activity reported by your agents | **Office** — Bureau |
| Track work and move it through stages | **Projects** — Projets |
| Find a conversation or inspect a run | **Logs** — Journaux, the session notebook |
| Review or manage scheduled tasks | **Workflows** — Flux de travail |
| Understand the functions available to the agent | **Skills** — Compétences |
| Read access policies and observed participants | **Access** — Habilitations |
| Send a request to your primary agent | **Chat** — Discuter, when sending is available |
| Check the server, gateway and reliability of observations | **System health** — Santé système, the health bulletin |

On a computer, use the sidebar. On a phone, the bottom bar opens the main pages; **More** contains the remaining pages and the appearance and language settings.

## Check the observation before acting

A displayed value is an observation with a time and a source. **Live** describes the portal’s connection to updates. It does not guarantee that every source is current or that every task is succeeding.

**Unconfirmed** means the portal lacks a recent or complete enough observation to establish the current state. It may keep showing the last snapshot it received. Check its time, then look at the sources in System health. An old snapshot proves neither that the agent is still working nor that it has stopped.

| Indicator | What it means |
| --- | --- |
| Loading | The snapshot has not arrived yet. This is not a count of zero. |
| Not provided, unknown or a dash | The value is unavailable. |
| No entries | The received snapshot contains no entries within the stated scope. |
| No matching results | Clear a filter or change the search; entries may exist outside this view. |
| Cached or out of date | Check the last successful observation time before relying on the value. |
| Saving | The change is still awaiting confirmation. |

Times follow the zone shown for the instance or task. It may differ from your phone’s time zone. Colours help you notice a state; the accompanying words explain it.

## Office: see reported activity

The Office brings together the illustrated room, the agents present and recent events. The opening sentence summarizes the main observation. The roster lets you find an agent even when its character is hard to distinguish in the room.

Select a character or its roster entry to open its details. Read the reported state and available references, then open its session when a link is offered. Close the panel to return to the Office.

| State | What it tells you |
| --- | --- |
| Idle, at rest | No activity is currently reported for this agent. |
| Thinking | The source reports a thinking phase. |
| Working | Activity is under way; its outcome is not yet established. |
| Researching | A research phase is reported. |
| Writing | A writing phase is reported. |
| Calling a tool | The agent is using a tool. Check the session for the result. |
| Waiting | The agent is waiting; the reason may not be available. |
| Error | An error has been reported. Open the details or session. |
| Offline | The agent is reported as unavailable. Check the snapshot’s freshness too. |

A duration describes time associated with an observed state, not time remaining. Movement and poses make the room easier to read; they do not prove that work has been delivered.

The **office notebook** records recent events and their times. Similar events may be grouped together. **Coming up** lists scheduled tasks, while **Last snapshot** provides the freshness context.

[See an example of the Office and its margin](../../design/reports/office-dev-09-bureau-en.png). This screenshot uses fictional data; your instance will have different names and activity.

## Customize the office

When **Customize** is available, open the editor from the scene or an agent’s panel.

1. In **Layout**, choose a furniture item and place it. The placement messages identify occupied spaces and blocked paths. Some layout changes require a wider screen.
2. In **Characters**, choose an appearance, colour and accessories. Assign a desk or leave assignment automatic. Default rules apply to new agents of the selected type.
3. Edit the display name or role when those fields are offered. A display name does not rename the agent in its runtime.
4. In **Theme**, choose the room’s atmosphere. Seasonal decorations depend on the available artwork.
5. Select **Save** and wait for confirmation.

Changes remain a draft until saved. **Undo** and **Redo** let you step through edits. Leaving without saving discards the draft.

Saved versions let you return to an earlier layout: load a version, review it, then save to restore it. Returning to the default office also requires saving. If someone else changed the office in the meantime, the conflict message lets you reload the saved version or replace it with your draft.

When customization is unavailable or read-only, you can still view the room. Repeatedly refreshing the page will not make a missing **Customize** control available.

## Projects: track the work

The board has five stages:

**Idea → To do → In progress → In review → Shipped**

These stages describe project tracking. **Shipped** is a chosen project status; it is not inferred from a successful run. **Blocked** is a risk that can accompany any stage.

Read the project name, priority and issue needing attention first. Within a column, projects are ordered by priority and then recent activity. Search and filters narrow the displayed results; a filtered view is identified as such.

Use **Move to** on an entry to change its stage. Drag and drop is also offered on desktop. On a phone, **Go to stage** helps you reach a column. Wait for the save confirmation: a rejected move may return the project to its previous stage.

Open a project to read its summary and history. Repository information, people, sources and flags provide context. A missing summary remains missing information. Read an agent-written summary alongside its date and, when needed, check it against recent events.

[See an example project board](../../design/reports/frontend-08b/projets-1280-light.png). This French-language screenshot contains fictional projects and shows a layout that may vary with your version.

### Read the flags

| Type | Purpose |
| --- | --- |
| Priority | P0 is most urgent, followed by P1, P2 and P3. Priority helps order the work. |
| Label | A user-chosen category, such as “client” or “internal”. |
| Risk | Something to check: a blocker, failed task, failing automated check or lack of recent activity. |
| Feature | An indicator found in the project’s code or configuration, shown here for reference. |

**Acknowledge** means you have seen a risk. It does not resolve it. You can remove a manual blocker when the situation changes; an automatic risk depends on new observations from its source. Feature indicators cannot be edited from this list.

### Import projects

1. Open **Import projects** from the board.
2. Review the suggestions and their sources: connected code repositories, workspace folders or session groups, depending on your instance.
3. Use the source and confidence filters. Confidence describes the import suggestion, not the project’s quality or priority.
4. Select the suggestions you want to add and review any editable fields offered.
5. Start the import, then read the result. Created projects and skipped suggestions are listed separately.

Discovering a suggestion does not automatically add it to the board. Importing creates project tracking in Agent Office; it does not deploy the project. An already-linked source may be skipped to avoid a duplicate. If there are no suggestions, check the available sources or create a project manually.

## Logs: find a session

Logs is the notebook of observed sessions. A session brings together related exchanges and events; a run is a period of work within that record.

Filter by type to find a conversation, scheduled task or subagent’s work. Times, model information and token counts help you identify an entry. Tokens measure processed volume, not result quality or a price on their own. **Show more** loads older sessions when available. Heartbeats, when offered, are periodic check activities that you can include in the list.

Open a session to read its messages and tool calls. Expand a tool call to inspect the available details, then distinguish the tool’s result from the agent’s final reply. If a **Timeline** view is offered, use it to examine event order and durations.

A truncated-content or partial-window notice means the entire exchange is not shown. A missing session may have been removed from its source; that does not establish that its work failed.

## Workflows: read and manage scheduled tasks

This page shows what is scheduled to run, when and with which instruction. Start with tasks needing attention, then check the next scheduled time and its time zone.

Open a task to read its instruction and recent results. Keep three facts separate:

- **Enabled or disabled:** is the task enabled to run on its schedule?
- **Run health:** is a failed result reported, or has no run been observed yet?
- **Delivery:** was the result sent to its destination?

A completed run does not, by itself, confirm delivery. A disabled task can retain an earlier failure. An instruction diagram describes planned work; it is not live progress.

When the actions are available, you can create a task, edit supported fields, enable or disable its schedule, or start a manual run. Review the instruction before choosing **Run**: the request goes to the agent runtime. Disabling a schedule does not mean cancelling work that has already started. Some tasks can be inspected even though their instruction or schedule cannot be edited in the portal.

If **Delete** is offered, check the task name before confirming. Removing its definition is different from temporarily disabling its schedule.

## Skills: understand what the agent can use

The skills directory describes each skill’s purpose and availability. Search for a skill and open its details to read its description, documented steps, outputs and requirements.

**Active** describes configured availability, not current use. **Disabled** means the skill has been disabled. For **Unavailable**, check the known reason and requirements; if those details have not arrived, the cause remains unconfirmed.

Visibility to the model or availability as a command does not, on its own, establish permission to use it. A skill’s documented steps are not an execution trace.

If you enable or disable a skill, wait for the save result. A message may indicate that a restart is still required: the saved change has not yet taken full effect. Follow your instance’s guidance before treating the skill as available.

## Access: distinguish permission from participation

Start with the reported policies for direct messages, groups and tool execution. Then review the agents and observed participants. Search and filters help you find a person or channel.

An entry means an identity or participation has been observed. **It does not prove current permission.** Likewise, enabling a channel does not necessarily grant access to everyone in it.

Open a participant to see the available information, associated sessions and known rules. An identity still being identified, an identity that could not be found or an unspecified access state remains unconfirmed. If no editing control is offered, ask the administrator to change the policy; this view does not replace its configuration.

## Chat: send a request

Chat lets you talk to your primary agent through the portal. **If the page still says it is coming soon, sending is not available in that version.** You can inspect previously observed exchanges in Logs.

When the composer is available, write a request with the goal, useful context and the expected result, then send it. A turn can take several minutes, particularly when the agent uses tools. A running indicator describes a state, not an estimated completion time.

Read the activity events and tool calls when they are exposed. A finished tool call is not necessarily a final answer. If updates stop, check the turn state and connection before sending the same request again: a reply missing from the screen does not prove that sending failed.

To find earlier exchanges, open the corresponding session in Logs. Your version may also offer a thread history within Chat; its absence does not mean that sessions have disappeared.

## System health: read the bulletin

The bulletin separates server health from the quality of the information received. Read the opening sentence, then follow its link to the issue or source needing attention.

| Part of the bulletin | What it helps you understand |
| --- | --- |
| Gateway | Is the connection to the agent runtime available? |
| Processor and memory | How much of these resources is in use in the snapshot? |
| Disk | How much disk space is occupied? |
| Event loop | Is the service processing events within the expected delay? The p99 value is the delay at or below which 99% of measured observations fall. |
| Uptime | How long has the server been running without a restart? |
| Tasks and plugins | What states are reported for scheduled tasks and loaded plugins? |
| Channels | Which connections are connected, running, stopped or reporting errors? |
| Sources | When did each source last provide a successful observation? |
| Data quality | Which observations could not be interpreted or validated as expected? |

Issues are classified as **errors**, **warnings** or **information**. Open the details to read the reference, occurrence count and dates. A data issue can limit the reliability of a view without meaning that the whole server is down.

Muting an issue removes it from the usual view; it does not fix it. Use the **Muted** filter to find it again. Errors cannot be muted. An empty filtered list does not certify that every source is healthy.

## Language, appearance and read-only access

Choose **FR** or **EN** in the user settings on desktop, or under **More** on mobile. The portal uses your saved choice; otherwise it selects a supported browser language, falling back to French. Project names, instructions and messages stay in their original language.

The interface offers **System**, **Light** and **Dark** themes. System follows your device preference. The **illustrated office** has its own theme: automatic mode follows the day and night hours configured for the instance. Changing the room’s atmosphere does not change the agent’s actual activity.

**Read-only** means that certain changes are prohibited. The restriction may cover actions sent to the agent, portal data, or both. You may therefore be able to read results, and sometimes manage a project, while being unable to start a task. Read the message attached to the action: a missing or disabled control, or an explicit refusal, explains the limit.

Read-only mode does not stop tasks already configured in the runtime. It also does not turn real data into a demonstration. A view marked **Mock** or **Maquette**, on the other hand, uses fictional data.

If a change is refused, read the reason rather than treating the new state as saved. For a conflict, reload the information before making your change again. For a lost connection or an unconfirmed state, start with System health and the source times.

For installation and administration, see the [installation](install.md), [configuration](config.md) and [upgrade](upgrading.md) guides.
