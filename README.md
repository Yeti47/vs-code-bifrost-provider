# Bifrost Copilot Provider

A minimal VS Code Copilot Chat model provider for a self-hosted [Bifrost](https://github.com/maximhq/bifrost) gateway.

Point it at your Bifrost base URL and virtual key, and it does the rest: models and their context window sizes are discovered automatically from Bifrost's `/v1/models` endpoint — no per-model configuration required.

## Setup

1. Install the extension (see [Packaging](#packaging) below).
2. Run **Bifrost: Configure Bifrost Connection** from the Command Palette.
3. Enter your Bifrost base URL (e.g. `https://bifrost.example.com`) and virtual key.
4. Open the Copilot Chat model picker — Bifrost's models will appear under the "Bifrost" vendor.

The virtual key is stored in VS Code's encrypted Secret Storage, never in settings. The base URL is stored in the `bifrost.baseUrl` setting.

## Features

- Automatic model discovery from Bifrost's `/v1/models` endpoint, across every provider it has configured.
- Streaming chat responses.
- Tool calling (for Copilot agent/edit mode).
- Image input for vision-capable models.

### Context size resolution

Not every Bifrost provider reports `context_length`/`max_input_tokens` (its OpenRouter passthrough does; providers like Ollama, Cloudflare Workers AI, or custom OpenAI-compatible ones typically don't). When Bifrost doesn't know, the extension tries, in order:

1. **Bifrost's own metadata** — used as-is when present.
2. **Cross-referencing other providers in the same Bifrost instance** — if the exact same model is also served by another configured provider that *does* report metadata (e.g. Moonshot's Kimi K3 via both OpenRouter and a second passthrough provider), that value is reused. Same gateway, same model, so this is trusted ahead of the external registry below.
3. **Bifrost's public model registry** (`getbifrost.ai/datasheet`) — a best-effort lookup by base model name, cached locally and refreshed every 24h. This resolves many real models (e.g. common Ollama tags) but can't know about provider-specific aliases (e.g. a custom gateway's internal codename for a model), and for locally-hosted models it reports the model's architectural max, not necessarily what your server is actually configured to allow.
4. **`bifrost.contextSizeOverrides` setting** — your own correction, keyed by exact model id (e.g. `"ollama/llama3.1"`) or provider prefix (e.g. `"ollama"`), value in tokens.
5. **A conservative default** (4096) if none of the above resolve — the model's tooltip in the picker will say so explicitly.

### Sticky routing across weighted keys

Bifrost's weighted Routing Rules pick a target independently on every request — there's no session affinity, so a single conversation can hop between keys mid-stream ([maximhq/bifrost#5409](https://github.com/maximhq/bifrost/issues/5409), still open as of v1.6.11). That's harmless for stateless providers, but it can break ones that track conversation state per key — e.g. DeepSeek's requirement that thinking-mode reasoning be replayed back on every subsequent turn, which a mid-conversation key switch can silently violate.

The `bifrost.routingTargets` setting works around this from the client:

```json
"bifrost.routingTargets": { "a": 1, "b": 1 }
```

Every request in a conversation is tagged with the same one of these labels, sent as the `X-Bifrost-Route` header — chosen deterministically from the conversation's first message, so the same conversation always picks the same label. The numbers are relative weights (equal here; use e.g. `{"a": 2, "b": 1}` for a 2:1 split).

To use it, replace your weighted Routing Rule with one exact-match rule per label — condition `X-Bifrost-Route == "a"` routing to one key, `== "b"` to the other, and so on. Leave the setting empty (the default) to send nothing and opt out entirely.

## Development

```sh
npm install
npm run compile   # or: npm run watch
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

## Packaging

```sh
npx @vscode/vsce package
```

This produces a `.vsix` file. Install it via the Command Palette: **Extensions: Install from VSIX...**.
