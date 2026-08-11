import { useEffect, useRef, useState } from 'react';
import './App.css';

const voiceTurnUrl = process.env.REACT_APP_MAD_ATC_API_URL || 'http://localhost:8000/api/voice-turn';

function App() {
  const [phase, setPhase] = useState('idle');
  const [response, setResponse] = useState(null);
  const [error, setError] = useState('');
  const audioRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const isListening = phase === 'listening';
  const isProcessing = phase === 'processing';
  const buttonLabel = isProcessing ? 'Waiting for ATC' : isListening ? 'Transmit to ATC' : 'Click to talk';
  const statusText = isListening
    ? 'Listening for pilot transmission. Click again to transmit.'
    : isProcessing
      ? 'Transmitting to ATC. Waiting for a fresh response.'
      : phase === 'replied'
        ? 'ATC replied with audio. Play it back or click to talk again.'
        : 'Ready for pilot transmission.';

  useEffect(() => {
    if (phase !== 'replied' || !response?.audioSrc || !audioRef.current) return;
    audioRef.current.currentTime = 0;
    void audioRef.current.play().catch(() => undefined);
  }, [phase, response?.audioSrc]);

  useEffect(() => () => {
    void stopRecorder(recorderRef.current);
  }, []);

  async function handleTalkClick() {
    if (isProcessing) return;
    setError('');

    if (!isListening) {
      await startRecording();
      return;
    }

    await finishRecording();
  }

  async function startRecording() {
    const mediaDevices = navigator.mediaDevices;
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!mediaDevices?.getUserMedia || !AudioContextConstructor) {
      setError('Browser microphone recording is not available.');
      setPhase('error');
      return;
    }

    try {
      const stream = await mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      const audioContext = new AudioContextConstructor();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;

      chunksRef.current = [];
      processor.onaudioprocess = (event) => {
        chunksRef.current.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };

      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);
      recorderRef.current = { stream, audioContext, source, processor, silentGain };
      setPhase('listening');
      setResponse(null);
    } catch (recordingError) {
      setError(recordingError instanceof Error ? recordingError.message : String(recordingError));
      setPhase('error');
    }
  }

  async function finishRecording() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    const sampleRate = recorder.audioContext.sampleRate;
    recorderRef.current = null;
    setPhase('processing');
    await stopRecorder(recorder);

    const chunks = chunksRef.current;
    chunksRef.current = [];
    if (!chunks.length) {
      setError('No microphone audio was captured.');
      setPhase('error');
      return;
    }

    try {
      const apiResponse = await fetch(voiceTurnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sampleRate,
          audioPcmBase64: encodePcmBase64(chunks),
        }),
      });
      const payload = await apiResponse.json();
      if (!apiResponse.ok) {
        throw new Error(payload.error || `ATC request failed with ${apiResponse.status}`);
      }
      const parsed = parseVoiceTurnResponse(payload);
      setResponse({
        transcript: parsed.transcript,
        roast: parsed.roast,
        audioSrc: `data:${parsed.audioContentType};base64,${parsed.audioBase64}`,
      });
      setPhase('replied');
    } catch (requestError) {
      setError(formatRequestError(requestError));
      setPhase('error');
    }
  }
  return (
    <main className="App">
      <section className="radio-panel" aria-labelledby="radio-title">
        <p className="eyebrow">MAD ATC</p>
        <h1 id="radio-title">Tower frequency is open</h1>
        <p className="lede">
          Key the mic when you are ready for the controller to roast you and still issue a valid instruction.
        </p>

        <button className="talk-button" type="button" onClick={handleTalkClick} aria-pressed={isListening} disabled={isProcessing}>
          {buttonLabel}
        </button>
        <p className="status-line" role="status">{error || statusText}</p>

        <div className="response-card">
          <p className="response-label">Audio response from ATC</p>
          {response ? (
            <>
              <p className="response-meta">Pilot: {response.transcript}</p>
              <p className="response-text">{response.roast}</p>
              <audio ref={audioRef} aria-label="ATC audio response" controls src={response.audioSrc}>
                Your browser does not support the audio element.
              </audio>
            </>
          ) : (
            <p className="response-text">No ATC response yet. Click to talk, speak, then transmit.</p>
          )}
        </div>
      </section>
    </main>
  );
}

async function stopRecorder(recorder) {
  if (!recorder) return;
  recorder.processor.onaudioprocess = null;
  recorder.source.disconnect();
  recorder.processor.disconnect();
  recorder.silentGain.disconnect();
  recorder.stream.getTracks().forEach((track) => track.stop());
  await recorder.audioContext.close();
}

function encodePcmBase64(chunks) {
  const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const pcm = new Int16Array(sampleCount);
  let offset = 0;

  chunks.forEach((chunk) => {
    chunk.forEach((sample) => {
      const clamped = Math.max(-1, Math.min(1, sample));
      pcm[offset] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      offset += 1;
    });
  });

  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return window.btoa(binary);
}

function parseVoiceTurnResponse(payload) {
  if (
    !payload ||
    typeof payload.transcript !== 'string' ||
    typeof payload.roast !== 'string' ||
    typeof payload.audioContentType !== 'string' ||
    typeof payload.audioBase64 !== 'string'
  ) {
    throw new Error('ATC server returned an invalid voice response.');
  }
  return payload;
}

function formatRequestError(error) {
  if (error instanceof TypeError && /failed to fetch/i.test(error.message)) {
    return 'ATC backend is offline. Run uv run mad-atc-web from the project root, then try again.';
  }
  return error instanceof Error ? error.message : String(error);
}
export default App;
