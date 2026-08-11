"""Live voice terminal: key the mic, get roasted back by the mad ATC in real time."""
import argparse
import io
import json
import os
import sys
import wave
import asyncio
from collections.abc import Callable
from dataclasses import dataclass
import numpy as np
import sounddevice as sd
from livekit.agents.utils import http_context
from src.agent.main import MadAtcAgent
from src.cli_output import create_cli_logger, labeled_line, log_colored
from src.settings import Config

MIN_AUDIO_SECONDS = 0.1


@dataclass(frozen=True)
class AudioCapture:
    pcm_bytes: bytes
    sample_rate: int
    device_name: str
    duration_seconds: float
    audio_bytes: int
    peak: int
    rms: float


def minimum_audio_bytes(sample_rate: int) -> int:
    return int(sample_rate * MIN_AUDIO_SECONDS) * 2


def record_until_enter(on_ready: Callable[[], None] | None = None) -> AudioCapture:
    """Record mono mic audio after the input stream is open until ENTER is received."""
    frames: list[np.ndarray] = []
    raw_device = os.environ.get('MAD_ATC_INPUT_DEVICE') or Config.MAD_ATC_INPUT_DEVICE
    input_device = int(raw_device) if raw_device and raw_device.isdecimal() else raw_device
    device_info = sd.query_devices(input_device, 'input')
    sample_rate = int(device_info['default_samplerate'])

    def callback(indata, _frame_count, _time_info, _status) -> None:
        frames.append(indata.copy())

    with sd.InputStream(device=input_device, samplerate=sample_rate, channels=1, dtype='int16', callback=callback):
        if on_ready is not None:
            on_ready()
        input()

    audio = np.concatenate(frames, axis=0) if frames else np.zeros((0, 1), dtype='int16')
    samples = audio.reshape(-1).astype(np.float64)
    peak = int(np.max(np.abs(samples))) if samples.size else 0
    rms = float(np.sqrt(np.mean(samples * samples))) if samples.size else 0.0
    pcm_bytes = audio.tobytes()
    return AudioCapture(
        pcm_bytes=pcm_bytes,
        sample_rate=sample_rate,
        device_name=str(device_info['name']),
        duration_seconds=len(pcm_bytes) / (sample_rate * 2),
        audio_bytes=len(pcm_bytes),
        peak=peak,
        rms=rms,
    )


def capture_diagnostic(capture: AudioCapture) -> str:
    return (
        f"mic={capture.device_name}; rate={capture.sample_rate}Hz; "
        f"duration={capture.duration_seconds:.2f}s; bytes={capture.audio_bytes}; "
        f"peak={capture.peak}; rms={capture.rms:.1f}"
    )

def play(wav_bytes: bytes) -> None:
    with wave.open(io.BytesIO(wav_bytes), 'rb') as wav_file:
        data = np.frombuffer(wav_file.readframes(wav_file.getnframes()), dtype='int16')
        data = data.reshape(-1, wav_file.getnchannels())
        sd.play(data, wav_file.getframerate())
        sd.wait()


async def run_once() -> int:
    """Record one push-to-talk turn, answer it, play the voice, and exit."""
    agent = MadAtcAgent()
    async with http_context.open() as http_session:
        agent.bind_http_session(http_session)
        logger = create_cli_logger()
        capture = record_until_enter(lambda: logger.info('🎙️  recording... press ENTER to transmit', color='bold cyan'))
        if capture.audio_bytes < minimum_audio_bytes(capture.sample_rate):
            logger.info(f'(nothing heard, try again — {capture_diagnostic(capture)})', color='yellow')
            return 2

        try:
            transcript = await agent.transcribe(capture.pcm_bytes, sample_rate=capture.sample_rate)
        except Exception as exc:
            logger.info(f'(could not transcribe that, try again — {exc})', color='red')
            return 3
        if not transcript.strip():
            logger.info(f'(nothing transcribed, try again — {capture_diagnostic(capture)})', color='yellow')
            return 2

        log_colored(logger, 'you:   ', transcript, 'bold green')
        roast = await agent.roast(transcript)
        log_colored(logger, 'tower: ', roast, 'bold magenta')
        play(await agent.synthesize(roast))
        logger.info(labeled_line('result -> ', json.dumps({"transcript": transcript, "roast": roast})))
        return 0

async def run() -> None:
    logger = create_cli_logger()
    agent = MadAtcAgent()
    logger.info('MAD ATC — frequency open.', color='bold cyan')
    logger.info('Press ENTER to key the mic, speak, press ENTER again to transmit. Ctrl+C to sign off.\n')

    async with http_context.open() as http_session:
        agent.bind_http_session(http_session)
        while True:
            try:
                input('[ready] press ENTER to transmit > ')
            except (EOFError, KeyboardInterrupt):
                logger.info('\ntower out.')
                break

            capture = record_until_enter(lambda: logger.info('🎙️  recording... press ENTER to transmit', color='bold cyan'))
            if capture.audio_bytes < minimum_audio_bytes(capture.sample_rate):
                logger.info(f'(nothing heard, try again — {capture_diagnostic(capture)})\n', color='yellow')
                continue

            try:
                transcript = await agent.transcribe(capture.pcm_bytes, sample_rate=capture.sample_rate)
            except Exception as exc:
                logger.info(f'(could not transcribe that, try again — {exc})\n', color='red')
                continue
            if not transcript.strip():
                logger.info(f'(nothing transcribed, try again — {capture_diagnostic(capture)})\n', color='yellow')
                continue
            log_colored(logger, 'you:   ', transcript, 'bold green')

            roast = await agent.roast(transcript)
            log_colored(logger, 'tower: ', roast, 'bold magenta')

            play(await agent.synthesize(roast))
            logger.info('')


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--once', action='store_true', help='record one stdin-controlled push-to-talk turn and exit')
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    if args.once:
        raise SystemExit(asyncio.run(run_once()))
    asyncio.run(run())


if __name__ == '__main__':
    main()
