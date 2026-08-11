from dataclasses import dataclass
from functools import cached_property
from crewai import LLM
from .settings import Config


@dataclass
class AgentConfig:

    agents_config: dict = 'config/agents.yaml'

    @cached_property
    def llm(self) -> LLM:
        return LLM(model=Config.OPENAI_MODEL, api_key=Config.OPENAI_API_KEY)
