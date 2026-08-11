import inspect
import wave
from io import BytesIO
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock
import subprocess
import sys

import pytest

from livekit.agents import stt as lk_stt
from src.agent.main import MadAtcAgent
from src.settings import Config


@pytest.fixture
def agent():
    return MadAtcAgent()


def test_agent_module_can_be_run_directly_from_project_root():
    result = subprocess.run(
        [sys.executable, 'src/agent/main.py'],
        cwd=Path(__file__).resolve().parent.parent,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr


class _FakeAudioFrame:
    """Stand-in for rtc.AudioFrame as returned by ChunkedStream.collect()."""

    def __init__(self, pcm_bytes: bytes, sample_rate: int = 24_000, num_channels: int = 1):
        self.sample_rate = sample_rate
        self.num_channels = num_channels
        self.data = MagicMock(tobytes=MagicMock(return_value=pcm_bytes))


class _FakeSpeechStream:
    """Stand-in for the LiveKit Inference SpeechStream: push/end + async-iterable events."""

    def __init__(self, events):
        self._events = list(events)
        self.push_frame = MagicMock()
        self.end_input = MagicMock()
        self.aclose = AsyncMock()

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._events:
            raise StopAsyncIteration
        return self._events.pop(0)


def _final_transcript_event(text: str):
    event = MagicMock()
    event.type = lk_stt.SpeechEventType.FINAL_TRANSCRIPT
    event.alternatives = [MagicMock(text=text)]
    return event


async def test_roast_returns_the_crew_outputs_raw_text(agent):
    fake_output = MagicMock(raw='Cleared to land, readback correct. Watch your descent rate, cowboy.')
    fake_crew_agent = MagicMock()
    fake_crew_agent.akickoff = AsyncMock(return_value=fake_output)
    agent.mad_atc = MagicMock(return_value=fake_crew_agent)

    result = await agent.roast('tower delta alpha delta request clearance')

    assert result == fake_output.raw
    fake_crew_agent.akickoff.assert_awaited_once_with(messages='tower delta alpha delta request clearance')


def test_tts_is_configured_from_settings(agent):
    assert agent.tts.model == Config.LIVEKIT_TTS_MODEL


def test_stt_is_configured_from_settings(agent):
    assert agent.stt.model == Config.LIVEKIT_STT_MODEL


def test_bind_http_session_passes_session_to_livekit_clients(agent):
    fake_session = object()

    agent.bind_http_session(fake_session)

    assert agent.stt._session is fake_session
    assert agent.tts._session is fake_session


async def test_synthesize_wraps_the_gateways_audio_frame_as_wav(agent):
    fake_stream = MagicMock()
    fake_stream.collect = AsyncMock(return_value=_FakeAudioFrame(b'\x01\x00\x02\x00', sample_rate=24_000))
    fake_tts = MagicMock()
    fake_tts.synthesize = MagicMock(return_value=fake_stream)
    agent.tts = fake_tts

    audio = await agent.synthesize('cleared for takeoff')

    fake_tts.synthesize.assert_called_once_with('cleared for takeoff')
    with wave.open(BytesIO(audio), 'rb') as wav_file:
        assert wav_file.getnchannels() == 1
        assert wav_file.getsampwidth() == 2
        assert wav_file.getframerate() == 24_000
        assert wav_file.readframes(wav_file.getnframes()) == b'\x01\x00\x02\x00'


async def test_transcribe_returns_text_from_the_final_transcript_event(agent):
    fake_stream = _FakeSpeechStream([_final_transcript_event('tower delta alpha delta request clearance')])
    fake_stt = MagicMock()
    fake_stt.stream = MagicMock(return_value=fake_stream)
    agent.stt = fake_stt

    transcript = await agent.transcribe(b'some-pcm-bytes', sample_rate=16_000)

    assert transcript == 'tower delta alpha delta request clearance'
    fake_stream.push_frame.assert_called_once()
    fake_stream.end_input.assert_called_once()
    fake_stream.aclose.assert_awaited_once()


async def test_transcribe_returns_empty_string_when_no_final_transcript_arrives(agent):
    fake_stream = _FakeSpeechStream([])  # stream ends with no events (e.g. silence)
    fake_stt = MagicMock()
    fake_stt.stream = MagicMock(return_value=fake_stream)
    agent.stt = fake_stt

    transcript = await agent.transcribe(b'some-pcm-bytes')

    assert transcript == ''


async def test_speak_writes_synthesized_audio_to_the_given_path(agent, tmp_path):
    agent.synthesize = AsyncMock(return_value=b'wav-audio-bytes')
    out_path = tmp_path / 'roast.wav'

    result = await agent.speak('you call that a readback?', out_path=out_path)

    assert result == out_path
    assert out_path.read_bytes() == b'wav-audio-bytes'
    agent.synthesize.assert_awaited_once_with('you call that a readback?')


def test_speak_defaults_to_roast_wav_in_the_cwd(agent):
    default = inspect.signature(agent.speak).parameters['out_path'].default
    assert default == Path('roast.wav')
