import asyncio
import sys

from livekit.agents.utils import http_context

from .agent.main import MadAtcAgent
from .cli_output import create_cli_logger, labeled_line, log_colored


async def _run(prompt: str) -> None:
    logger = create_cli_logger()
    agent = MadAtcAgent()
    async with http_context.open() as http_session:
        agent.bind_http_session(http_session)
        roast = await agent.roast(prompt)
        logger.info(str(roast))
        log_colored(logger, 'voice -> ', await agent.speak(roast), 'bold blue')


def main() -> None:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

    prompt = ' '.join(sys.argv[1:]) or 'tower delta alpha delta request clearance'
    asyncio.run(_run(prompt))
