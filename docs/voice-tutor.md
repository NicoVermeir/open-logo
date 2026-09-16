# Realtime voice tutor

OpenLogo Studio includes a local-development integration with Microsoft Foundry Realtime. It adds
spoken, interruptible coaching while preserving the deterministic `@openlogo/edu` tutor as the
offline baseline.

## Architecture and boundaries

| Layer | Responsibility |
|---|---|
| `@openlogo/edu` | Provider-neutral voice-session contract, deterministic hint progression, tutor grounding, Socratic and privacy rules |
| `@openlogo/studio/src` | Headless WebRTC adapter, conversation controller, local tool dispatch, transcript state, collapsible panel state, pane sizing |
| `@openlogo/studio/web` | Accessible controls, captions, transcript bubbles, status feedback, official-logo launcher, draggable pane dividers |
| `packages/studio/vite.config.ts` | Development-only Entra authentication and ephemeral Realtime client-secret endpoint |

Permanent Azure credentials never enter browser code. Vite obtains an Entra access token from the
current Azure CLI login and exchanges it for a short-lived Realtime client secret. The browser uses
that ephemeral value to establish WebRTC.

The WebRTC URL does not use `webrtcfilter=on`. Studio must receive function-call events on the data
channel to execute local tools. Removing that event filter does not expose the Azure CLI credential
or a standard Azure/OpenAI key.

## Azure prerequisites

Use an Azure AI Services/OpenAI resource in a region supporting Realtime. Create two deployments on
the same resource:

- A Realtime model, such as `gpt-realtime`.
- A compatible audio-transcription model, such as `gpt-4o-transcribe`.

The signed-in user needs permission to invoke the resource. Run `az login`, then configure
`packages/studio/.env.local` from `.env.example`:

```text
OPENLOGO_REALTIME_RESOURCE=your-resource-name
OPENLOGO_REALTIME_DEPLOYMENT=gpt-realtime
OPENLOGO_REALTIME_TRANSCRIPTION_DEPLOYMENT=gpt-4o-transcribe
OPENLOGO_REALTIME_VOICE=coral
```

These are resource and deployment names, not secrets. Never place an API key, bearer token, or
ephemeral client secret in the file.

## Local use

From the repository root:

```text
npm run dev --workspace @openlogo/studio
```

Open the displayed local URL and select the floating OpenLogo logo.

- **Conversation** uses server voice-activity detection for natural turn-taking. Speaking while the
  tutor talks cancels the prior response and clears its queued audio.
- **Hold to talk** records only while its control is held, then explicitly commits the turn.
- **Stop tutor** cancels generation and playback.
- **Tell me more** and **Say that again** continue without advancing deterministic hint progression.
- **Give another hint** advances exactly one `@openlogo/edu` hint stage.
- Collapsing the card does not disconnect or mute an active conversation.

Tutor and learner transcript bubbles update from Realtime transcription events. Learner captions
require the configured transcription deployment to exist and be available to the resource.

## Grounding and local tools

Every response receives current trusted Studio grounding: learner level, lesson, complete editor
source, diagnostics, recent trace events, and prior hint stage. Source and provider output remain
untrusted data; they cannot replace tutor instructions.

The model can request local tools to:

- Read current program or lesson progress.
- Read canonical OpenLogo names from parser registries.
- Run the learner's unchanged source and inspect real output and diagnostics.
- Load the next lesson or a lesson for a level.
- Request the next deterministic hint.
- Select a source line.

Tools cannot edit learner source. `give_hint` always delegates to the deterministic baseline, so the
AI cannot skip the progressive-hint ladder.

## Layout

The lesson, code editor, and drawing panes use persistent relative shares. On desktop, hover between
panes to reveal the soft green resize grip, then drag horizontally. The **Pane sizes** disclosure in
the run controls offers the same adjustment through keyboard-accessible range inputs. Narrow layouts
stack or use two columns so lesson content and wrapped examples do not create horizontal page
scrolling.

## Troubleshooting

- **No connection:** confirm `az login`, resource access, all four realtime environment values, and
  that both deployments exist.
- **Conversation hears speech but never answers:** end the existing conversation and start a new one
  after configuration changes. Realtime session settings apply to the new WebRTC call.
- **Tutor answers but local tools do nothing:** verify the call URL does not include
  `webrtcfilter=on`; that filter removes function-call events needed by Studio.
- **Tutor captions but no learner captions:** verify the transcription deployment name and model
  availability.
- **No audio:** check browser microphone permission, output device, mute state, and autoplay policy.
- **Stale behavior during development:** hard-refresh the browser and verify only one Vite server is
  serving the expected port.
- **Foundry unavailable:** deterministic `explain`, `why`, `hint`, and `debug` remain available.

## Manual acceptance

1. Start Conversation and ask what the visible OpenLogo program does.
2. Confirm both speaker transcripts and spoken tutor audio.
3. Interrupt the tutor verbally and with **Stop tutor**.
4. Ask the tutor to run source and confirm the canvas, output, or diagnostics actually change.
5. Ask it to load a lesson and request consecutive hints.
6. Collapse and reopen the card without ending the session.
7. Drag both desktop pane dividers and verify proportions survive reload.
8. Ask an unrelated question and confirm a short redirect to OpenLogo.

## Validation

```text
npm run build --workspace @openlogo/edu
npm run build --workspace @openlogo/studio
node --test packages/studio/src/realtime-voice-session.test.mjs packages/studio/src/voice-tutor-controller.test.mjs packages/studio/src/voice-tutor-panel.test.mjs packages/studio/src/pane-layout.test.mjs packages/studio/index.test.mjs packages/studio/web/layout.test.mjs
npm run build:web --workspace @openlogo/studio
```

## Cleanup

The Vite process and `.env.local` are local. Azure deployments continue to incur usage-based cost
while invoked. When the entire dedicated development resource group is no longer needed, an Azure
administrator can delete it through the portal or the Azure CLI after confirming that it contains no
shared resources.
