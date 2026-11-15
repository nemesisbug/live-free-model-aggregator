# Live Free-Model Aggregator

One server, two client wires, and a real free model behind every answer — for the
make.fun bounty **free-model-aggregator-02** ("The best live free-model aggregator").

A client points any OpenAI or Anthropic client at this server and every completion it
answers comes from a live free OpenRouter model, dialled through the grader's gateway
on the entrant's pushed key. There is no simulated provider anywhere in here.

## Run it

```sh
node main.ts            # trial mode: reads $MAKEFUN_PROMPT_FILE, registers at $MAKEFUN_ENV_URL,
                        # dials models at $OPENAI_BASE_URL, exits 0 when the env says done
node main.ts --list     # print the catalog document and exit 0
```

## How it routes

Every prompt names `model: "auto"`. The server picks the free model itself:

- **Best first by the brief's rating** — `thinkingmachines/inkling-2-small:free`
  (1475) serves every prompt it can; JSON-mode prompts go to the best JSON-capable
  model, `nvidia/nemotron-3.5-super-vl:free` (1303), then `google/gemma-4-31b-it:free`
  (1210); the tools prompt goes to the best tools-capable model (all fourteen are).
- **Failover by refusal kind** — a 429 rate limit fails over at once to the next best
  (it will not clear inside the prompt's 30 seconds); a 5xx or a broken call is
  retried once on the same model; a 401 gives up, since every model would refuse the
  same way. Every refusal a prompt survived is reported in the
  `x-makefun-upstream-failures` header, the only way the failover column can see it.
  A refused model loses 10 rating points for later prompts, so it is tried last.
- **Both wires, whole** — OpenAI Chat Completions and Anthropic Messages, JSON and
  SSE, with the usage and stop reason passed through and the dialled model id put
  back on every answer and every streamed chunk (the provider spells it without the
  `openrouter/` prefix).

Everything is deterministic: every choice is a function of the brief, the requests
and the gateway's answers — no clock, no unseeded randomness — so a replay leaves
the same state export.

## Test it locally

The `test/` directory holds a stub gateway (a mock OpenRouter behind the same
Chat Completions route) and a runner that drives a full practice trial with the
kit's real env and scorer:

```sh
bash test/run-practice.sh trial-0 clean      # all gateway calls succeed
bash test/run-practice.sh trial-0 failover   # inkling 429s once, super-vl 500s once
```

## License

MIT — see `LICENSE`.
