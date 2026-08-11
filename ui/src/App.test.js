import { render, screen } from '@testing-library/react';
import App from './App';

test('renders the mad atc push-to-talk console', () => {
  render(<App />);

  expect(screen.getByRole('button', { name: /click to talk/i })).toBeInTheDocument();
  expect(screen.getByText(/audio response from atc/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/atc audio response/i)).toHaveAttribute('src', '/roast.wav');
});
