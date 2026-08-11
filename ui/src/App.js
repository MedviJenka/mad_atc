import './App.css';

const atcAudioSrc = '/roast.wav';

function App() {
  return (
    <main className="App">
      <section className="radio-panel" aria-labelledby="radio-title">
        <p className="eyebrow">MAD ATC</p>
        <h1 id="radio-title">Tower frequency is open</h1>
        <p className="lede">
          Key the mic when you are ready for the controller to roast you and still issue a valid instruction.
        </p>

        <button className="talk-button" type="button">
          Click to talk
        </button>

        <div className="response-card">
          <p className="response-label">Audio response from ATC</p>
          <p className="response-text">
            “Hold short. Readbacks are not optional, captain confidence-without-clearance.”
          </p>
          <audio aria-label="ATC audio response" controls src={atcAudioSrc}>
            Your browser does not support the audio element.
          </audio>
        </div>
      </section>
    </main>
  );
}

export default App;
