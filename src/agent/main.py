import asyncio
import io
import wave
from functools import cached_property
from pathlib import Path
import sys
from crewai import Agent
from crewai.project import CrewBase, agent
from livekit import rtc
from livekit.agents import inference
from livekit.agents import stt as lk_stt
if __package__ in {None, ''}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from src.config import AgentConfig
    from src.settings import Config
else:
    from ..config import AgentConfig
    from ..settings import Config

TRANSCRIBE_TIMEOUT = 15  # seconds to wait for a final transcript before giving up


@CrewBase
class MadAtcAgent(AgentConfig):

    @agent
    def mad_atc(self) -> Agent: return Agent(config=self.agents_config['mad_atc'], llm=self.llm, verbose=Config.VERBOSE)

    def bind_http_session(self, http_session) -> 'MadAtcAgent':
        self.http_session = http_session
        self.__dict__.pop('tts', None)
        self.__dict__.pop('stt', None)
        return self

    async def roast(self, prompt: str) -> str:
        response = await self.mad_atc().akickoff(messages=prompt)
        return response.raw

    @cached_property
    def tts(self) -> inference.TTS:
        return inference.TTS(
            model=Config.LIVEKIT_TTS_MODEL,
            http_session=getattr(self, 'http_session', None),
            extra_kwargs={
                'emotion': Config.LIVEKIT_TTS_EMOTION,
                'volume': Config.LIVEKIT_TTS_VOLUME,
                'speed': Config.LIVEKIT_TTS_SPEED,
            },
        )

    @cached_property
    def stt(self) -> inference.STT: return inference.STT(model=Config.LIVEKIT_STT_MODEL, http_session=getattr(self, 'http_session', None))

    async def synthesize(self, text: str) -> bytes:
        """Text -> WAV audio bytes, spoken in the angry ATC voice (LiveKit Inference / Cartesia)."""
        frame = await self.tts.synthesize(text).collect()
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as wav_file:
            wav_file.setnchannels(frame.num_channels)
            wav_file.setsampwidth(2)  # int16
            wav_file.setframerate(frame.sample_rate)
            wav_file.writeframes(frame.data.tobytes())
        return buf.getvalue()

    async def speak(self, text: str, out_path: Path = Path('roast.wav')) -> Path:
        out_path.write_bytes(await self.synthesize(text))
        return out_path

    async def transcribe(self, pcm_bytes: bytes, sample_rate: int = 16_000) -> str:
        """Mic PCM16 mono bytes -> transcript text (LiveKit Inference / Deepgram)."""
        stream = self.stt.stream()
        stream.push_frame(
            rtc.AudioFrame(
                data=pcm_bytes,
                sample_rate=sample_rate,
                num_channels=1,
                samples_per_channel=len(pcm_bytes) // 2,
            )
        )
        stream.end_input()

        async def _first_final() -> str:
            async for event in stream:
                if event.type == lk_stt.SpeechEventType.FINAL_TRANSCRIPT:
                    return event.alternatives[0].text
            return ''

        try:
            return await asyncio.wait_for(_first_final(), timeout=TRANSCRIBE_TIMEOUT)
        except asyncio.TimeoutError:
            return ''
        finally:
            await stream.aclose()


if __name__ == '__main__':
    print('MadAtcAgent module loaded. Run `uv run python main.py` for the live voice terminal.')
