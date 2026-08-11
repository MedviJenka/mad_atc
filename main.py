"""Live voice terminal: key the mic, get roasted back by the mad ATC in real time."""
import argparse
import io
import json
import sys
import wave
import asyncio
from collections.abc import Callable
import numpy as np
import sounddevice as sd
from livekit.agents.utils import http_context

from src.agent.main import MadAtcAgent
from src.cli_output import create_cli_logger, labeled_line, log_colored

SAMPLE_RATE = 16_000
MIN_AUDIO_BYTES = 3_200  # ~0.1s at 16kHz/16-bit mono; anything under this is silence


def record_until_enter(on_ready: Callable[[], None] | None = None) -> bytes:
    """Record mono mic audio after the input stream is open until ENTER is received."""
    frames: list[np.ndarray] = []

    def callback(indata, _frame_count, _time_info, _status) -> None:
        frames.append(indata.copy())

    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype='int16', callback=callback):
        if on_ready is not None:
            on_ready()
        input()

    audio = np.concatenate(frames, axis=0) if frames else np.zeros((0, 1), dtype='int16')
    return audio.tobytes()


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
        pcm_bytes = record_until_enter(lambda: logger.info('🎙️  recording... release ENTER to transmit', color='bold cyan'))
        if len(pcm_bytes) < MIN_AUDIO_BYTES:
            logger.info('(nothing heard, try again)', color='yellow')
            return 2

        try:
            transcript = await agent.transcribe(pcm_bytes, sample_rate=SAMPLE_RATE)
        except Exception as exc:
            logger.info(f'(could not transcribe that, try again — {exc})', color='red')
            return 3
        if not transcript.strip():
            logger.info('(nothing heard, try again)', color='yellow')
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

            pcm_bytes = record_until_enter(lambda: logger.info('🎙️  recording... press ENTER to stop', color='bold cyan'))
            if len(pcm_bytes) < MIN_AUDIO_BYTES:
                logger.info('(nothing heard, try again)\n', color='yellow')
                continue

            try:
                transcript = await agent.transcribe(pcm_bytes, sample_rate=SAMPLE_RATE)
            except Exception as exc:
                logger.info(f'(could not transcribe that, try again — {exc})\n', color='red')
                continue
            if not transcript.strip():
                logger.info('(nothing heard, try again)\n', color='yellow')
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
