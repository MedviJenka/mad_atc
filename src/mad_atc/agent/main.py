import asyncio
import io
import wave
from functools import cached_property
from pathlib import Path

from crewai import Agent
from crewai.project import CrewBase, agent
from livekit import rtc
from livekit.agents import inference
from livekit.agents import stt as lk_stt

from mad_atc.config import AgentConfig
from mad_atc.settings import Config

TRANSCRIBE_TIMEOUT = 15  # seconds to wait for a final transcript before giving up


@CrewBase
class MadAtcAgent(AgentConfig):

    @agent
    def mad_atc(self) -> Agent: return Agent(config=self.agents_config['mad_atc'], llm=self.llm, verbose=Config.VERBOSE)

    async def roast(self, prompt: str) -> str:
        response = await self.mad_atc().akickoff(messages=prompt)
        return response.raw

    @cached_property
    def tts(self) -> inference.TTS:
        return inference.TTS(model=Config.LIVEKIT_TTS_MODEL, extra_kwargs={'emotion': Config.LIVEKIT_TTS_EMOTION})

    @cached_property
    def stt(self) -> inference.STT: return inference.STT(model=Config.LIVEKIT_STT_MODEL)

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
