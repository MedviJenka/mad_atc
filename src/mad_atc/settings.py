from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field


class Settings(BaseSettings):

    model_config = SettingsConfigDict(env_file='.env', extra='allow')

    OPENAI_API_KEY: str  = Field(...)
    OPENAI_MODEL:   str  = Field(default='openai/gpt-5.5')
    VERBOSE:        bool = Field(default=True)

    TTS_MODEL: str = Field(default='gpt-4o-mini-tts')
    TTS_VOICE: str = Field(default='onyx')


@lru_cache
def get_settings() -> Settings:
    return Settings()


Config = get_settings()
