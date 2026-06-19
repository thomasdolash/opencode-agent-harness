# Live Gateway Probe

This probe now tests the real surface that matters for the streaming bug:
OpenClaw Gateway OpenAI-compatible SSE.

It compares two routes on `/v1/chat/completions` using `stream: true`:

- baseline: `openclaw/default`
- target: `openclaw/opencode`

That makes the harness question concrete. If the baseline streams many
incremental `delta.content` chunks while the target collapses to one final
chunk, the remaining defect is in the `opencode` harness path rather than in
WebUI rendering, generic gateway SSE transport, or the CLI.

## Usage

From this repository:

```bash
npm run probe:live
npm run probe:live -- --verbose
```

Useful overrides:

```bash
npm run probe:live -- --base-url http://127.0.0.1:18789
npm run probe:live -- --baseline-model openclaw/default
npm run probe:live -- --target-model openclaw/opencode
npm run probe:live -- --prompt "Write 12 very short lines about SSE."
```

The probe reads `OPENCLAW_GATEWAY_TOKEN` by default. You can also pass a token
explicitly:

```bash
npm run probe:live -- --token "$OPENCLAW_GATEWAY_TOKEN"
```

## Requirements

- a reachable OpenClaw gateway HTTP endpoint
- a valid gateway bearer token
- this plugin linked into that gateway
- routing/config that exposes `openclaw/opencode`
- a live OpenCode backend behind that route
- OpenClaw config must explicitly enable chat completions:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

Without that setting, `/v1/models` and `/v1/chat/completions` may resolve to
the Control UI shell instead of the documented Gateway API.

## What Success Looks Like

The script prints:

- baseline and target model summaries
- content chunk counts
- first and last chunk timing
- short previews of both replies
- optional per-chunk timing in `--verbose` mode
- a final comparison JSON object

The probe exits non-zero when either:

- the baseline route does not stream incrementally
- the target route does not stream incrementally

That is intentional. The script is now a direct regression check for the real
SSE streaming behavior we care about.

## Current Known Finding

On the live gateway today, the observed behavior is:

- `openclaw/default` streams many incremental `delta.content` chunks
- `openclaw/opencode` emits one role chunk and then a single final
  `delta.content` containing the whole answer

That means the generic gateway SSE transport is healthy. The remaining defect is
specific to the `opencode` harness path and how its partial replies are being
projected into gateway chat-completions streaming.

## Secondary Note About the CLI

Earlier probe iterations used `openclaw agent` CLI output timing as a proxy for
streaming. That was useful during initial debugging, but it is no longer the
primary truth source. The live HTTP SSE endpoint is the authoritative test
surface for this issue.
