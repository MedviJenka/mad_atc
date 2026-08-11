import asyncio
import sys

from mad_atc.agent.main import MadAtcAgent


def main() -> None:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

    prompt = ' '.join(sys.argv[1:]) or 'tower delta alpha delta request clearance'
    agent = MadAtcAgent()
    roast = asyncio.run(agent.roast(prompt))
    print(roast)
    print('voice ->', agent.speak(roast))
