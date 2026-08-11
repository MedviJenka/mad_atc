import base64

import pytest
from pydantic import ValidationError

from src.web import VoiceTurnRequest, handle_voice_turn


class FakeHttpSession:
    pass


class FakeHttpContext:
    def __init__(self):
        self.session = FakeHttpSession()
        self.events = []

    async def __aenter__(self):
        self.events.append('enter')
        return self.session

    async def __aexit__(self, *_exc):
        self.events.append('exit')


class FakeAgent:
    def __init__(self, context):
        self.context = context
        self.bound_session = None

    def bind_http_session(self, http_session):
        self.bound_session = http_session
        return self

    async def transcribe(self, pcm_bytes, sample_rate):
        assert pcm_bytes == b'pcm-bytes!'
        assert sample_rate == 48_000
        assert self.bound_session is self.context.session
        return 'tower request immediate takeoff'

    async def roast(self, transcript):
        assert transcript == 'tower request immediate takeoff'
        return 'Hold short. Fresh response generated.'

    async def synthesize(self, roast):
        assert roast == 'Hold short. Fresh response generated.'
        return b'wav-bytes'


def test_voice_turn_request_rejects_empty_audio():
    with pytest.raises(ValidationError):
        VoiceTurnRequest(audioPcmBase64='', sampleRate=48_000)


async def test_handle_voice_turn_returns_generated_audio_for_request_audio():
    context = FakeHttpContext()
    request = VoiceTurnRequest(
        audioPcmBase64=base64.b64encode(b'pcm-bytes!').decode('ascii'),
        sampleRate=48_000,
    )

    response = await handle_voice_turn(
        request,
        agent_factory=lambda: FakeAgent(context),
        http_session_context=lambda: context,
    )

    assert response.transcript == 'tower request immediate takeoff'
    assert response.roast == 'Hold short. Fresh response generated.'
    assert response.audioContentType == 'audio/wav'
    assert base64.b64decode(response.audioBase64) == b'wav-bytes'
    assert context.events == ['enter', 'exit']
