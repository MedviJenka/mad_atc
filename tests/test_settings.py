import pytest
from pydantic import ValidationError

from src.settings import Settings, get_settings

LIVEKIT_CREDS = {'LIVEKIT_API_KEY': 'lk-key', 'LIVEKIT_API_SECRET': 'lk-secret'}


def test_requires_openai_api_key(monkeypatch):
    """OPENAI_API_KEY has no default, so a Settings without it must fail to build."""
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **LIVEKIT_CREDS)


def test_requires_livekit_credentials(monkeypatch):
    """LIVEKIT_API_KEY/SECRET have no defaults, so a Settings without them must fail to build."""
    monkeypatch.delenv('LIVEKIT_API_KEY', raising=False)
    monkeypatch.delenv('LIVEKIT_API_SECRET', raising=False)
    with pytest.raises(ValidationError):
        Settings(_env_file=None, OPENAI_API_KEY='test-key')


def test_defaults_are_applied_when_only_the_keys_are_given(monkeypatch):
    for key in ('OPENAI_MODEL', 'VERBOSE', 'LIVEKIT_TTS_MODEL', 'LIVEKIT_TTS_EMOTION', 'LIVEKIT_STT_MODEL', 'MAD_ATC_INPUT_DEVICE'):
        monkeypatch.delenv(key, raising=False)

    settings = Settings(_env_file=None, OPENAI_API_KEY='test-key', **LIVEKIT_CREDS)

    assert settings.OPENAI_API_KEY == 'test-key'
    assert settings.OPENAI_MODEL == 'openai/gpt-5.5'
    assert settings.VERBOSE is True
    assert settings.LIVEKIT_API_KEY == 'lk-key'
    assert settings.LIVEKIT_API_SECRET == 'lk-secret'
    assert settings.LIVEKIT_TTS_MODEL == 'cartesia/sonic-2'
    assert settings.LIVEKIT_TTS_EMOTION == 'angry'
    assert settings.LIVEKIT_STT_MODEL == 'deepgram/nova-3'
    assert settings.MAD_ATC_INPUT_DEVICE is None


def test_env_vars_override_defaults(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'from-env')
    monkeypatch.setenv('OPENAI_MODEL', 'openai/custom-model')
    monkeypatch.setenv('VERBOSE', 'false')
    monkeypatch.setenv('LIVEKIT_API_KEY', 'lk-key')
    monkeypatch.setenv('LIVEKIT_API_SECRET', 'lk-secret')

    settings = Settings(_env_file=None)

    assert settings.OPENAI_API_KEY == 'from-env'
    assert settings.OPENAI_MODEL == 'openai/custom-model'
    assert settings.VERBOSE is False

    monkeypatch.setenv('MAD_ATC_INPUT_DEVICE', '18')

    settings = Settings(_env_file=None)

    assert settings.MAD_ATC_INPUT_DEVICE == '18'

def test_unknown_fields_are_allowed_not_rejected():
    """model_config sets extra='allow', so an unrelated field must not raise."""
    settings = Settings(
        _env_file=None, OPENAI_API_KEY='test-key', SOME_UNRELATED_FIELD='x', **LIVEKIT_CREDS
    )

    assert settings.SOME_UNRELATED_FIELD == 'x'


def test_get_settings_is_cached():
    assert get_settings() is get_settings()
