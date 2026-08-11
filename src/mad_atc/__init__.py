import asyncio
import sys

from livekit.agents.utils import http_context

from mad_atc.agent.main import MadAtcAgent


async def _run(prompt: str) -> None:
    agent = MadAtcAgent()
    async with http_context.open():
        roast = await agent.roast(prompt)
        print(roast)
        print('voice ->', await agent.speak(roast))


def main() -> None:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

    prompt = ' '.join(sys.argv[1:]) or 'tower delta alpha delta request clearance'
    asyncio.run(_run(prompt))
