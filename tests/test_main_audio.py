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


def test_record_until_enter_captures_raw_pcm16_audio(monkeypatch):
    chunk = np.array([[1], [2], [3]], dtype='int16')
    monkeypatch.setattr(mad_atc_main.sd, 'InputStream', _FakeInputStream(chunks=[chunk]))
    monkeypatch.setattr('builtins.input', lambda *a, **k: '')

    pcm_bytes = mad_atc_main.record_until_enter()

    assert _FakeInputStream.last_kwargs['samplerate'] == mad_atc_main.SAMPLE_RATE
    assert _FakeInputStream.last_kwargs['channels'] == 1
    assert list(np.frombuffer(pcm_bytes, dtype='int16')) == [1, 2, 3]


def test_record_until_enter_with_no_audio_yields_empty_bytes(monkeypatch):
    monkeypatch.setattr(mad_atc_main.sd, 'InputStream', _FakeInputStream(chunks=[]))
    monkeypatch.setattr('builtins.input', lambda *a, **k: '')

    pcm_bytes = mad_atc_main.record_until_enter()

    # run()'s "nothing heard" branch relies on this being under MIN_AUDIO_BYTES.
    assert len(pcm_bytes) == 0
    assert len(pcm_bytes) < mad_atc_main.MIN_AUDIO_BYTES


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
