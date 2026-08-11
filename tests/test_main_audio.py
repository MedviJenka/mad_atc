import wave
from io import BytesIO
from unittest.mock import MagicMock

import numpy as np

import main as mad_atc_main


class _FakeInputStream:
    """Stand-in for sounddevice.InputStream that fires the callback once on entry."""

    last_kwargs = None

    def __init__(self, chunks=()):
        self._chunks = chunks

    def __call__(self, *_args, **kwargs):
        self._kwargs = kwargs
        _FakeInputStream.last_kwargs = kwargs
        return self

    def __enter__(self):
        callback = self._kwargs['callback']
        for chunk in self._chunks:
            callback(chunk, len(chunk), None, None)
        return self

    def __exit__(self, *_exc):
        return False


def _fake_input_device(_device=None, kind='input'):
    assert kind == 'input'
    return {'name': 'Test Mic', 'default_samplerate': 48_000}



def test_record_until_enter_reports_ready_after_input_stream_is_open(monkeypatch):
    events = []

    class DelayedFakeInputStream:
        def __call__(self, *_args, **kwargs):
            self._kwargs = kwargs
            return self

        def __enter__(self):
            events.append('stream-open')
            return self

        def __exit__(self, *_exc):
            return False

    monkeypatch.setattr(mad_atc_main.sd, 'InputStream', DelayedFakeInputStream())
    monkeypatch.setattr(mad_atc_main.sd, 'query_devices', _fake_input_device)
    monkeypatch.setattr('builtins.input', lambda *a, **k: events.append('stop-wait'))

    mad_atc_main.record_until_enter(on_ready=lambda: events.append('ready'))

    assert events == ['stream-open', 'ready', 'stop-wait']


def test_record_until_enter_captures_raw_pcm16_audio(monkeypatch):
    chunk = np.array([[1], [2], [3]], dtype='int16')
    monkeypatch.setattr(mad_atc_main.sd, 'InputStream', _FakeInputStream(chunks=[chunk]))
    monkeypatch.setattr(mad_atc_main.sd, 'query_devices', _fake_input_device)
    monkeypatch.setattr('builtins.input', lambda *a, **k: '')

    capture = mad_atc_main.record_until_enter()

    assert _FakeInputStream.last_kwargs['samplerate'] == 48_000
    assert _FakeInputStream.last_kwargs['channels'] == 1
    assert _FakeInputStream.last_kwargs['device'] is None
    assert capture.sample_rate == 48_000
    assert capture.device_name == 'Test Mic'
    assert capture.duration_seconds == 3 / 48_000
    assert capture.peak == 3
    assert capture.rms > 2
    assert list(np.frombuffer(capture.pcm_bytes, dtype='int16')) == [1, 2, 3]

def test_record_until_enter_honors_configured_input_device(monkeypatch):
    chunk = np.array([[10], [20]], dtype='int16')
    monkeypatch.setenv('MAD_ATC_INPUT_DEVICE', '16')
    monkeypatch.setattr(mad_atc_main.sd, 'query_devices', _fake_input_device)
    monkeypatch.setattr(mad_atc_main.sd, 'InputStream', _FakeInputStream(chunks=[chunk]))
    monkeypatch.setattr('builtins.input', lambda *a, **k: '')

    capture = mad_atc_main.record_until_enter()

    assert _FakeInputStream.last_kwargs['device'] == 16
    assert capture.sample_rate == 48_000
    assert capture.device_name == 'Test Mic'




def test_record_until_enter_with_no_audio_yields_empty_bytes(monkeypatch):
    monkeypatch.setattr(mad_atc_main.sd, 'InputStream', _FakeInputStream(chunks=[]))
    monkeypatch.setattr(mad_atc_main.sd, 'query_devices', _fake_input_device)
    monkeypatch.setattr('builtins.input', lambda *a, **k: '')

    capture = mad_atc_main.record_until_enter()

    # run()'s "nothing heard" branch relies on this being under the minimum duration.
    assert len(capture.pcm_bytes) == 0
    assert capture.audio_bytes < mad_atc_main.minimum_audio_bytes(capture.sample_rate)


def test_play_sends_decoded_samples_and_framerate_to_sounddevice(monkeypatch):
    buf = BytesIO()
    with wave.open(buf, 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(16_000)
        wav_file.writeframes(np.array([10, 20, 30], dtype='int16').tobytes())

    fake_play = MagicMock()
    fake_wait = MagicMock()
    monkeypatch.setattr(mad_atc_main.sd, 'play', fake_play)
    monkeypatch.setattr(mad_atc_main.sd, 'wait', fake_wait)

    mad_atc_main.play(buf.getvalue())

    fake_play.assert_called_once()
    played_data, played_rate = fake_play.call_args[0]
    assert played_rate == 16_000
    assert list(played_data.flatten()) == [10, 20, 30]
    fake_wait.assert_called_once()


async def test_run_once_records_transcribes_roasts_and_speaks(monkeypatch, capsys):
    context_events = []

    class FakeHttpSession:
        async def __aenter__(self):
            context_events.append('enter')
            return self

        async def __aexit__(self, *_exc):
            context_events.append('exit')

    class FakeHttpContext:
        @staticmethod
        def open():
            return FakeHttpSession()

    class FakeAgent:
        def bind_http_session(self, http_session):
            assert context_events == ['enter']
            assert http_session is not None
            return self

        async def transcribe(self, pcm_bytes, sample_rate):
            assert context_events == ['enter']
            assert pcm_bytes == b'1' * mad_atc_main.minimum_audio_bytes(48_000)
            assert sample_rate == 48_000
            return 'tower request takeoff'

        async def roast(self, transcript):
            assert transcript == 'tower request takeoff'
            return 'hold short'

        async def synthesize(self, roast):
            assert roast == 'hold short'
            return b'wav'

    def fake_record_until_enter(on_ready=None):
        if on_ready is not None:
            on_ready()
        return mad_atc_main.AudioCapture(
            pcm_bytes=b'1' * mad_atc_main.minimum_audio_bytes(48_000),
            sample_rate=48_000,
            device_name='Test Mic',
            duration_seconds=0.1,
            audio_bytes=mad_atc_main.minimum_audio_bytes(48_000),
            peak=1000,
            rms=200.0,
        )

    fake_play = MagicMock()
    monkeypatch.setattr(mad_atc_main, 'MadAtcAgent', FakeAgent)
    monkeypatch.setattr(mad_atc_main, 'http_context', FakeHttpContext)
    monkeypatch.setattr(mad_atc_main, 'record_until_enter', fake_record_until_enter)
    monkeypatch.setattr(mad_atc_main, 'play', fake_play)

    exit_code = await mad_atc_main.run_once()

    out = capsys.readouterr().out
    assert exit_code == 0
    assert 'you:   tower request takeoff' in out
    assert 'tower: hold short' in out
    assert 'result -> {"transcript": "tower request takeoff", "roast": "hold short"}' in out
    fake_play.assert_called_once_with(b'wav')
    assert context_events == ['enter', 'exit']
