# mad_atc

A mad air traffic controller, powered by an LLM. Send it a pilot radio call; it
roasts you and still gives you a valid ATC instruction — in text and voice.

## Setup

```bash
uv sync
```

Create a `.env` file (see `src/mad_atc/settings.py` for the full list of keys):

```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=openai/gpt-5.5

LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

The LLM (`roast()`) still runs on OpenAI via crewai. Voice — `transcribe()` (Deepgram)
and `synthesize()` (Cartesia) — runs on [LiveKit Inference](https://docs.livekit.io/agents/models/inference/),
which only needs your LiveKit API key/secret; no separate Deepgram/Cartesia accounts.

## Run

One-shot, text + saved voice file:

```bash
uv run mad-atc "tower this is delta alpha delta requesting immediate takeoff"
```

Prints the roast and writes it to `roast.wav`.

Live voice terminal — speak to it with your mic, hear it roast you back:

```bash
uv run python main.py
```

Press ENTER to key the mic, speak, press ENTER again to transmit. Ctrl+C to sign off.

## Layout

- `src/mad_atc/settings.py` — env-driven config (`Config`): OpenAI model, LiveKit TTS/STT models + TTS emotion
- `src/mad_atc/agent/main.py` — `MadAtcAgent`: `roast()` (text, OpenAI), `transcribe()` (mic → text, Deepgram), `synthesize()`/`speak()` (text → angry voice, Cartesia)
- `src/mad_atc/agent/config/agents.yaml` — role/goal/backstory, auto-loaded by crewai's `@CrewBase`
- `src/mad_atc/agent/skills/mad-atc/SKILL.md` — persona reference doc (temper, profession, strict rules)
- `main.py` — live voice terminal: mic in → transcript → roast → angry voice out
