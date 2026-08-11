from pathlib import Path
from crewai import Agent
from crewai.project import CrewBase, agent
from mad_atc.config import AgentConfig
from mad_atc.settings import Config


@CrewBase
class MadAtcAgent(AgentConfig):

    @agent
    def mad_atc(self) -> Agent:
        return Agent(config=self.agents_config['mad_atc'], llm=self.llm, verbose=Config.VERBOSE)

    async def roast(self, prompt: str) -> str:
        response = await self.mad_atc().akickoff(messages=prompt)
        return response.raw

    def speak(self, text: str, out_path: Path = Path('roast.mp3')) -> Path:
        response = self.openai_client.audio.speech.create(
            model=Config.TTS_MODEL,
            voice=Config.TTS_VOICE,
            input=text,
        )
        response.write_to_file(out_path)
        return out_path


if __name__ == '__main__':
    import asyncio
    import sys

    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

    _agent = MadAtcAgent()
    _roast = asyncio.run(_agent.roast('tower delta alpha delta request clearance'))
    print(_roast)
    print('voice ->', _agent.speak(_roast))
