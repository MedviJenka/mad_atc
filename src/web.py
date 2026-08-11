"""HTTP API for the React push-to-talk UI."""

from __future__ import annotations

import base64
import binascii
import json
import os
from collections.abc import Awaitable, Callable
from typing import Any

from livekit.agents.utils import http_context
from pydantic import BaseModel, Field, ValidationError, field_validator

from src.agent.main import MadAtcAgent


class VoiceTurnRequest(BaseModel):
    audioPcmBase64: str = Field(min_length=1)
    sampleRate: int = Field(gt=0, le=192_000)

    @field_validator('audioPcmBase64')
    @classmethod
    def audio_must_be_pcm16(cls, value: str) -> str:
        try:
            pcm_bytes = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError('audioPcmBase64 must be valid base64') from exc
        if len(pcm_bytes) < 2:
            raise ValueError('audioPcmBase64 must contain PCM16 audio bytes')
        if len(pcm_bytes) % 2:
            raise ValueError('audioPcmBase64 must contain whole PCM16 samples')
        return value

    def pcm_bytes(self) -> bytes:
        return base64.b64decode(self.audioPcmBase64, validate=True)


class VoiceTurnResponse(BaseModel):
    transcript: str
    roast: str
    audioContentType: str = 'audio/wav'
    audioBase64: str


class VoiceTurnError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message
        super().__init__(message)


AgentFactory = Callable[[], MadAtcAgent]
HttpSessionContextFactory = Callable[[], Any]


async def handle_voice_turn(
    request: VoiceTurnRequest,
    *,
    agent_factory: AgentFactory = MadAtcAgent,
    http_session_context: HttpSessionContextFactory = http_context.open,
) -> VoiceTurnResponse:
    """Transcribe one browser-recorded PCM turn, roast it, and return fresh WAV bytes."""
    async with http_session_context() as http_session:
        agent = agent_factory().bind_http_session(http_session)
        transcript = await agent.transcribe(request.pcm_bytes(), sample_rate=request.sampleRate)
        if not transcript.strip():
            raise VoiceTurnError(422, 'nothing transcribed, try again')
        roast = await agent.roast(transcript)
        wav_bytes = await agent.synthesize(roast)

    return VoiceTurnResponse(
        transcript=transcript,
        roast=roast,
        audioBase64=base64.b64encode(wav_bytes).decode('ascii'),
    )


async def app(scope: dict[str, Any], receive: Callable[[], Awaitable[dict[str, Any]]], send: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
    if scope['type'] != 'http':
        return

    method = scope['method'].upper()
    path = scope['path']

    if method == 'OPTIONS':
        await _send_response(send, 204, b'')
        return

    if path != '/api/voice-turn' or method != 'POST':
        await _send_json(send, 404, {'error': 'not found'})
        return

    try:
        raw_body = await _read_body(receive)
        data = json.loads(raw_body.decode('utf-8'))
        request = VoiceTurnRequest.model_validate(data)
        response = await handle_voice_turn(request)
    except json.JSONDecodeError:
        await _send_json(send, 400, {'error': 'request body must be JSON'})
    except ValidationError as exc:
        await _send_json(send, 400, {'error': 'invalid voice turn request', 'details': exc.errors()})
    except VoiceTurnError as exc:
        await _send_json(send, exc.status, {'error': exc.message})
    except Exception as exc:  # Keep service errors visible without leaking internals.
        await _send_json(send, 502, {'error': f'ATC voice turn failed: {exc}'})
    else:
        await _send_json(send, 200, response.model_dump())


async def _read_body(receive: Callable[[], Awaitable[dict[str, Any]]]) -> bytes:
    body = bytearray()
    more_body = True
    while more_body:
        message = await receive()
        body.extend(message.get('body', b''))
        more_body = message.get('more_body', False)
    return bytes(body)


async def _send_json(send: Callable[[dict[str, Any]], Awaitable[None]], status: int, payload: dict[str, Any]) -> None:
    await _send_response(send, status, json.dumps(payload).encode('utf-8'), content_type=b'application/json')


async def _send_response(
    send: Callable[[dict[str, Any]], Awaitable[None]],
    status: int,
    body: bytes,
    *,
    content_type: bytes = b'text/plain',
) -> None:
    await send({
        'type': 'http.response.start',
        'status': status,
        'headers': [
            (b'access-control-allow-origin', b'*'),
            (b'access-control-allow-methods', b'POST, OPTIONS'),
            (b'access-control-allow-headers', b'content-type'),
            (b'content-type', content_type),
        ],
    })
    await send({'type': 'http.response.body', 'body': body})


def main() -> None:
    import uvicorn

    host = os.environ.get('MAD_ATC_WEB_HOST', '127.0.0.1')
    port = int(os.environ.get('MAD_ATC_WEB_PORT', '8000'))
    uvicorn.run('src.web:app', host=host, port=port)


if __name__ == '__main__':
    main()
