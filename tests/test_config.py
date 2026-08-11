from mad_atc.config import AgentConfig
from mad_atc.settings import Config


def test_llm_is_configured_from_settings():
    config = AgentConfig()
    llm = config.llm

    # crewai's LLM splits "provider/model" into separate attributes.
    provider, _, model = Config.OPENAI_MODEL.partition('/')
    assert llm.provider == provider
    assert llm.model == model
    assert llm.api_key == Config.OPENAI_API_KEY


def test_llm_is_cached_per_instance():
    """@cached_property must build the LLM once and reuse it, not reconnect per access."""
    config = AgentConfig()
    assert config.llm is config.llm
