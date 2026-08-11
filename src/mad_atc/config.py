from dataclasses import dataclass
from functools import cached_property
from crewai import LLM
from openai import OpenAI
from mad_atc.settings import Config


@dataclass
class AgentConfig:

    agents_config: dict = 'config/agents.yaml'  # auto-loaded by @CrewBase

    @cached_property
    def llm(self) -> LLM:
        return LLM(model=Config.OPENAI_MODEL, api_key=Config.OPENAI_API_KEY)

    @cached_property
    def openai_client(self) -> OpenAI:
        return OpenAI(api_key=Config.OPENAI_API_KEY)
