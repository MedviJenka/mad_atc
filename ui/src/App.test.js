import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

let processor;

class MockAudioContext {
  constructor() {
    this.sampleRate = 48000;
    this.destination = {};
  }

  createMediaStreamSource() {
    return { connect: jest.fn(), disconnect: jest.fn() };
  }

  createScriptProcessor() {
    processor = { connect: jest.fn(), disconnect: jest.fn(), onaudioprocess: null };
    return processor;
  }

  createGain() {
    return { gain: { value: 1 }, connect: jest.fn(), disconnect: jest.fn() };
  }

  close() {
    return Promise.resolve();
  }
}

function mockMicrophone() {
  const stop = jest.fn();
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: jest.fn().mockResolvedValue({
        getTracks: () => [{ stop }],
      }),
    },
  });
  window.AudioContext = MockAudioContext;
  window.webkitAudioContext = MockAudioContext;
  return stop;
}

beforeEach(() => {
  processor = undefined;
  jest.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue();
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      transcript: 'tower request immediate takeoff',
      roast: 'Hold short. Fresh response generated.',
      audioContentType: 'audio/wav',
      audioBase64: 'fresh-audio',
    }),
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  delete global.fetch;
});

test('renders the mad atc push-to-talk console without a stale fixed audio file', () => {
  render(<App />);

  expect(screen.getByRole('button', { name: /click to talk/i })).toBeInTheDocument();
  expect(screen.getByText(/audio response from atc/i)).toBeInTheDocument();
  expect(screen.queryByLabelText(/atc audio response/i)).not.toBeInTheDocument();
});

test('click to talk records microphone audio and plays a fresh atc response', async () => {
  const stop = mockMicrophone();
  render(<App />);

  userEvent.click(screen.getByRole('button', { name: /click to talk/i }));

  expect(await screen.findByText(/listening for pilot transmission/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /transmit to atc/i })).toBeInTheDocument();
  processor.onaudioprocess({
    inputBuffer: {
      getChannelData: () => new Float32Array([0, 0.5, -1]),
    },
  });

  userEvent.click(screen.getByRole('button', { name: /transmit to atc/i }));

  await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
  const [, request] = global.fetch.mock.calls[0];
  const body = JSON.parse(request.body);
  expect(global.fetch).toHaveBeenCalledWith('http://localhost:8000/api/voice-turn', expect.objectContaining({ method: 'POST' }));
  expect(body.sampleRate).toBe(48000);
  expect(body.audioPcmBase64).not.toBe('');
  expect(stop).toHaveBeenCalledTimes(1);
  expect(await screen.findByText(/fresh response generated/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/atc audio response/i)).toHaveAttribute('src', 'data:audio/wav;base64,fresh-audio');
  await waitFor(() => expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1));
});

test('shows how to start the backend when fetch cannot reach atc api', async () => {
  mockMicrophone();
  global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  render(<App />);

  userEvent.click(screen.getByRole('button', { name: /click to talk/i }));
  expect(await screen.findByText(/listening for pilot transmission/i)).toBeInTheDocument();
  processor.onaudioprocess({
    inputBuffer: {
      getChannelData: () => new Float32Array([0.25, -0.25]),
    },
  });

  userEvent.click(screen.getByRole('button', { name: /transmit to atc/i }));

  expect(await screen.findByText(/run uv run mad-atc-web/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /click to talk/i })).toBeEnabled();
});
