"""Live voice terminal: key the mic, get roasted back by the mad ATC in real time."""
import argparse
import io
import json
import sys
import wave
import asyncio
import numpy as np
import sounddevice as sd
from livekit.agents.utils import http_context

from mad_atc.agent.main import MadAtcAgent
from mad_atc.logging import configure_cli_logging

SAMPLE_RATE = 16_000
MIN_AUDIO_BYTES = 3_200  # ~0.1s at 16kHz/16-bit mono; anything under this is silence


def record_until_enter() -> bytes:
    """Record mono mic audio until the user presses ENTER again; return raw PCM16 bytes."""
    frames: list[np.ndarray] = []

    def callback(indata, _frame_count, _time_info, _status) -> None:
        frames.append(indata.copy())

    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype='int16', callback=callback):
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
        logger = configure_cli_logging()
        logger.info('🎙️  recording... release ENTER to transmit')
        pcm_bytes = record_until_enter()
        if len(pcm_bytes) < MIN_AUDIO_BYTES:
            logger.info('(nothing heard, try again)')
            return 2

        try:
            transcript = await agent.transcribe(pcm_bytes, sample_rate=SAMPLE_RATE)
        except Exception as exc:
            logger.info('(could not transcribe that, try again — %s)', exc)
            return 3
        if not transcript.strip():
            logger.info('(nothing heard, try again)')
            return 2

        logger.info('you:   %s', transcript)
        roast = await agent.roast(transcript)
        logger.info('tower: %s', roast)
        play(await agent.synthesize(roast))
        logger.info('result -> %s', json.dumps({"transcript": transcript, "roast": roast}))
        return 0

async def run() -> None:
    logger = configure_cli_logging()
    agent = MadAtcAgent()
    logger.info('MAD ATC — frequency open.')
    logger.info('Press ENTER to key the mic, speak, press ENTER again to transmit. Ctrl+C to sign off.\n')

    async with http_context.open() as http_session:
        agent.bind_http_session(http_session)
        while True:
            try:
                input('[ready] press ENTER to transmit > ')
            except (EOFError, KeyboardInterrupt):
                logger.info('\ntower out.')
                break

            logger.info('🎙️  recording... press ENTER to stop')
            pcm_bytes = record_until_enter()
            if len(pcm_bytes) < MIN_AUDIO_BYTES:
                logger.info('(nothing heard, try again)\n')
                continue

            try:
                transcript = await agent.transcribe(pcm_bytes, sample_rate=SAMPLE_RATE)
            except Exception as exc:
                logger.info('(could not transcribe that, try again — %s)\n', exc)
                continue
            if not transcript.strip():
                logger.info('(nothing heard, try again)\n')
                continue
            logger.info('you:   %s', transcript)

            roast = await agent.roast(transcript)
            logger.info('tower: %s', roast)

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
