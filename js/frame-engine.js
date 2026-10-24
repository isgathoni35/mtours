/**
 * ============================================================================
 * M TOURS — HIGH PERFORMANCE SCROLL FRAME ENGINE (60 FPS LERP)
 * ============================================================================
 * Synchronizes 876 background video frames seamlessly with page scroll,
 * featuring tiered preloading, double-buffered canvas rendering, and
 * active section anchor tracking.
 */

class SinglePageFrameEngine {
  constructor(options = {}) {
    this.totalFrames = options.totalFrames || 876;
    this.framePrefix = options.framePrefix || 'tourism/frame_';
    this.frameExt = options.frameExt || '.jpg';
    this.canvas = document.getElementById('bg-canvas');
    this.ctx = this.canvas ? this.canvas.getContext('2d', { alpha: false }) : null;

    // Cache & loading state
    this.cache = new Array(this.totalFrames).fill(null);
    this.loadedStatus = new Uint8Array(this.totalFrames); // 0=unrequested, 1=loading, 2=loaded
    this.loadedCount = 0;

    // Scrub interpolation state
    this.targetProgress = 0;
    this.currentProgress = 0;
    this.lerpFactor = 0.12; // Smooth Apple-style momentum damping
    this.lastDrawnFrame = -1;

    // Section anchor tracking
    this.sections = document.querySelectorAll('main > section');
    this.navLinks = document.querySelectorAll('.site-nav .nav-link');

    this.init();
  }

  getFrameUrl(index) {
    const padded = String(index).padStart(6, '0');
    return `${this.framePrefix}${padded}${this.frameExt}`;
  }

  init() {
    if (!this.canvas || !this.ctx) return;

    // Handle high-DPI canvas resizing
    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas(), { passive: true });

    // Scroll listeners & initial position alignment
    window.addEventListener('scroll', () => {
      this.onScroll();
      this.updateActiveNav();
    }, { passive: true });

    this.onScroll();
    this.currentProgress = this.targetProgress;

    // Start RAF rendering loop
    this.startRenderLoop();

    // Start Stratified Preloader Pipeline
    this.startPreloadPipeline();

    // Header background change on scroll
    this.bindHeaderScroll();

    // Smooth anchor navigation
    this.bindAnchorClicks();
  }

  resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = window.innerWidth;
    const height = window.innerHeight;

    if (this.canvas.width !== width * dpr || this.canvas.height !== height * dpr) {
      this.canvas.width = width * dpr;
      this.canvas.height = height * dpr;
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'high';

      if (this.lastDrawnFrame >= 0 && this.cache[this.lastDrawnFrame]) {
        this.renderFrame(this.lastDrawnFrame);
      }
    }
  }

  // =========================================================================
  // STRATIFIED PRELOAD PIPELINE
  // =========================================================================
  async startPreloadPipeline() {
    // 1. Immediately load frame 0 for instant hero visual
    await this.loadSingleFrame(0);
    this.renderFrame(0);

    // 2. Preload Keyframe skeleton across the whole 876 frames (every 6th frame ~ 146 images)
    // Takes only ~1.5s on broadband / local, guarantees 0-100% scrub availability immediately!
    const keyframes = [];
    for (let i = 0; i < this.totalFrames; i += 6) {
      if (i !== 0) keyframes.push(i);
    }
    keyframes.push(this.totalFrames - 1);

    const batchSize = 8;
    for (let i = 0; i < keyframes.length; i += batchSize) {
      const slice = keyframes.slice(i, i + batchSize);
      await Promise.all(slice.map(idx => this.loadSingleFrame(idx)));
    }

    // 3. Fill remaining frames in background idle batches
    this.queueRemainingFrames();
  }

  loadSingleFrame(index) {
    if (index < 0 || index >= this.totalFrames) return Promise.resolve(null);
    if (this.loadedStatus[index] === 2) return Promise.resolve(this.cache[index]);
    if (this.loadedStatus[index] === 1) {
      return new Promise(resolve => {
        const check = setInterval(() => {
          if (this.loadedStatus[index] === 2) {
            clearInterval(check);
            resolve(this.cache[index]);
          }
        }, 30);
      });
    }

    this.loadedStatus[index] = 1;
    return new Promise(resolve => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        this.cache[index] = img;
        this.loadedStatus[index] = 2;
        this.loadedCount++;
        resolve(img);
      };
      img.onerror = () => {
        this.loadedStatus[index] = 0;
        resolve(null);
      };
      img.src = this.getFrameUrl(index);
    });
  }

  async queueRemainingFrames() {
    const missing = [];
    for (let i = 0; i < this.totalFrames; i++) {
      if (this.loadedStatus[i] === 0) missing.push(i);
    }

    const batchSize = 6;
    for (let i = 0; i < missing.length; i += batchSize) {
      await new Promise(r => setTimeout(r, 16));
      const slice = missing.slice(i, i + batchSize);
      await Promise.all(slice.map(idx => this.loadSingleFrame(idx)));
    }
  }

  // =========================================================================
  // SCROLL PROGRESS & MOMENTUM LERP LOOP
  // =========================================================================
  onScroll() {
    const maxScroll = (document.documentElement.scrollHeight - window.innerHeight) || 1;
    const progress = Math.max(0, Math.min(1, window.scrollY / maxScroll));
    this.targetProgress = progress;
  }

  startRenderLoop() {
    const loop = () => {
      // Smooth lerp calculation
      this.currentProgress += (this.targetProgress - this.currentProgress) * this.lerpFactor;

      // Map progress directly to frame index (0 to 875)
      const targetFrame = Math.max(0, Math.min(
        this.totalFrames - 1,
        Math.round(this.currentProgress * (this.totalFrames - 1))
      ));

      // Prioritize neighbor frames around current scrub point
      this.ensureNeighborFrames(targetFrame);

      // Draw only if frame changed
      if (targetFrame !== this.lastDrawnFrame) {
        this.renderFrame(targetFrame);
      }

      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
  }

  ensureNeighborFrames(centerIdx) {
    for (let offset = -12; offset <= 12; offset++) {
      const idx = centerIdx + offset;
      if (idx >= 0 && idx < this.totalFrames && this.loadedStatus[idx] === 0) {
        this.loadSingleFrame(idx);
      }
    }
  }

  getBestFrame(index) {
    if (this.cache[index]) return this.cache[index];

    // Fallback to closest loaded keyframe so canvas never flickers or goes blank
    for (let r = 1; r < 30; r++) {
      if (index - r >= 0 && this.cache[index - r]) return this.cache[index - r];
      if (index + r < this.totalFrames && this.cache[index + r]) return this.cache[index + r];
    }
    return null;
  }

  renderFrame(frameIndex) {
    const img = this.getBestFrame(frameIndex);
    if (!img) return;

    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const iw = img.naturalWidth || 1280;
    const ih = img.naturalHeight || 720;

    // Aspect-ratio cover math: perfectly centers and scales to fill screen
    const scale = Math.max(cw / iw, ch / ih);
    const sw = iw * scale;
    const sh = ih * scale;
    const sx = (cw - sw) / 2;
    const sy = (ch - sh) / 2;

    this.ctx.drawImage(img, sx, sy, sw, sh);
    this.lastDrawnFrame = frameIndex;
  }

  // =========================================================================
  // ACTIVE NAVIGATION & ANCHOR SCROLLING
  // =========================================================================
  updateActiveNav() {
    const scrollPos = window.scrollY + window.innerHeight * 0.35;
    let currentId = '';

    this.sections.forEach(sec => {
      const top = sec.offsetTop;
      const height = sec.offsetHeight;
      if (scrollPos >= top && scrollPos < top + height) {
        currentId = sec.getAttribute('id');
      }
    });

    this.navLinks.forEach(link => {
      const href = link.getAttribute('href');
      if (href === `#${currentId}`) {
        link.classList.add('active');
      } else {
        link.classList.remove('active');
      }
    });
  }

  bindAnchorClicks() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
      anchor.addEventListener('click', (e) => {
        const targetId = anchor.getAttribute('href');
        if (targetId === '#' || targetId === '') return;
        const targetEl = document.querySelector(targetId);
        if (!targetEl) return;

        e.preventDefault();
        targetEl.scrollIntoView({ behavior: 'smooth' });
      });
    });
  }

  bindHeaderScroll() {
    const header = document.querySelector('.site-header');
    if (!header) return;

    window.addEventListener('scroll', () => {
      if (window.scrollY > 40) {
        header.classList.add('scrolled');
      } else {
        header.classList.remove('scrolled');
      }
    }, { passive: true });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.frameEngine = new SinglePageFrameEngine();
});
