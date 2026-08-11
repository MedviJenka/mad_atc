import asyncio
import sys

from livekit.agents.utils import http_context

from mad_atc.agent.main import MadAtcAgent
from mad_atc.logging import configure_cli_logging


async def _run(prompt: str) -> None:
    logger = configure_cli_logging()
    agent = MadAtcAgent()
    async with http_context.open() as http_session:
        agent.bind_http_session(http_session)
        roast = await agent.roast(prompt)
        logger.info('%s', roast)
        logger.info('voice -> %s', await agent.speak(roast))


def main() -> None:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

    prompt = ' '.join(sys.argv[1:]) or 'tower delta alpha delta request clearance'
    asyncio.run(_run(prompt))
