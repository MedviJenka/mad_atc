"""Live voice terminal: key the mic, get roasted back by the mad ATC in real time."""
import io
import sys
import wave
import asyncio
import numpy as np
import sounddevice as sd
from livekit.agents.utils import http_context

from mad_atc.agent.main import MadAtcAgent

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


async def run() -> None:
    agent = MadAtcAgent()
    print('MAD ATC — frequency open.')
    print('Press ENTER to key the mic, speak, press ENTER again to transmit. Ctrl+C to sign off.\n')

    async with http_context.open():
        while True:
            try:
                input('[ready] press ENTER to transmit > ')
            except (EOFError, KeyboardInterrupt):
                print('\ntower out.')
                break

            print('🎙️  recording... press ENTER to stop')
            pcm_bytes = record_until_enter()
            if len(pcm_bytes) < MIN_AUDIO_BYTES:
                print('(nothing heard, try again)\n')
                continue

            try:
                transcript = await agent.transcribe(pcm_bytes, sample_rate=SAMPLE_RATE)
            except Exception as exc:
                print(f'(could not transcribe that, try again — {exc})\n')
                continue
            if not transcript.strip():
                print('(nothing heard, try again)\n')
                continue
            print(f'you:   {transcript}')

            roast = await agent.roast(transcript)
            print(f'tower: {roast}')

            play(await agent.synthesize(roast))
            print()


def main() -> None:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    asyncio.run(run())


if __name__ == '__main__':
    main()
