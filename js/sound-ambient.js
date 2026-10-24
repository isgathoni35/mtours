/**
 * ============================================================================
 * PROCEDURAL AMBIENT SOUND GENERATOR (WEB AUDIO API)
 * ============================================================================
 * Generates an organic, warm savanna atmosphere and harmonic drone without
 * requiring external MP3/WAV assets. 100% lightweight and zero dependencies.
 */

class AmbientSoundEngine {
  constructor() {
    this.ctx = null;
    this.isPlaying = false;
    this.btnSound = document.querySelector('.btn-sound');
    this.masterGain = null;
    this.droneNodes = [];
    this.windNode = null;

    this.init();
  }

  init() {
    if (!this.btnSound) return;

    this.btnSound.addEventListener('click', () => {
      this.toggleAudio();
    });
  }

  toggleAudio() {
    if (!this.ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContext();
      this.buildSynthesizer();
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    this.isPlaying = !this.isPlaying;

    if (this.isPlaying) {
      this.btnSound.classList.add('playing', 'active');
      this.btnSound.title = 'Mute Savanna Ambience';
      // Fade in master gain smoothly
      this.masterGain.gain.setTargetAtTime(0.18, this.ctx.currentTime, 1.2);
    } else {
      this.btnSound.classList.remove('playing', 'active');
      this.btnSound.title = 'Enable Savanna Ambience';
      // Fade out
      this.masterGain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.8);
    }
  }

  buildSynthesizer() {
    // Master Gain
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    this.masterGain.connect(this.ctx.destination);

    // Warm Low Drone: Sub-bass fundamental (55Hz / A1)
    const osc1 = this.ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(55, this.ctx.currentTime);

    const osc2 = this.ctx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(55.4, this.ctx.currentTime); // Slight detune for warmth

    const osc3 = this.ctx.createOscillator();
    osc3.type = 'sine';
    osc3.frequency.setValueAtTime(110, this.ctx.currentTime); // Octave overtone

    // Lowpass filter for warm cinematic tone
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(280, this.ctx.currentTime);
    filter.Q.setValueAtTime(2, this.ctx.currentTime);

    const droneGain = this.ctx.createGain();
    droneGain.gain.setValueAtTime(0.3, this.ctx.currentTime);

    osc1.connect(filter);
    osc2.connect(filter);
    osc3.connect(filter);
    filter.connect(droneGain);
    droneGain.connect(this.masterGain);

    osc1.start();
    osc2.start();
    osc3.start();

    // Savanna Wind Texture (Pink Noise through bandpass filter)
    const bufferSize = this.ctx.sampleRate * 2;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      output[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.05;
      b6 = white * 0.115926;
    }

    const whiteNoise = this.ctx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;
    whiteNoise.loop = true;

    const windFilter = this.ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.setValueAtTime(450, this.ctx.currentTime);
    windFilter.Q.setValueAtTime(1.5, this.ctx.currentTime);

    // Subtle LFO modulation on wind filter
    const lfo = this.ctx.createOscillator();
    lfo.frequency.setValueAtTime(0.12, this.ctx.currentTime); // 8-second slow swell
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.setValueAtTime(200, this.ctx.currentTime);
    lfo.connect(lfoGain);
    lfoGain.connect(windFilter.frequency);
    lfo.start();

    const windGain = this.ctx.createGain();
    windGain.gain.setValueAtTime(0.2, this.ctx.currentTime);

    whiteNoise.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(this.masterGain);

    whiteNoise.start();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.ambientSound = new AmbientSoundEngine();
});
