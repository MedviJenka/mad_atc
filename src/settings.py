from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field


class Settings(BaseSettings):

    model_config = SettingsConfigDict(env_file='.env', extra='allow')

    OPENAI_API_KEY:      str  = Field(...)
    OPENAI_MODEL:        str  = Field(default='openai/gpt-5.5')
    VERBOSE:             bool = Field(default=True)
    LIVEKIT_API_KEY:     str  = Field(...)  # https://docs.livekit.io/agents/models/inference/
    LIVEKIT_API_SECRET:  str  = Field(...)
    LIVEKIT_TTS_MODEL:   str   = Field(default='cartesia/sonic-2')
    LIVEKIT_TTS_EMOTION: str   = Field(default='angry')
    LIVEKIT_TTS_VOLUME:  float = Field(default=2.0)  # 2.0 is the gateway's max
    LIVEKIT_TTS_SPEED:   str   = Field(default='fast')
    LIVEKIT_STT_MODEL:   str   = Field(default='deepgram/nova-3')


@lru_cache
def get_settings() -> Settings:
    return Settings()


Config = get_settings()
