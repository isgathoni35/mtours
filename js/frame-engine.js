/**
 * ============================================================================
 * M TOURS — HIGH PERFORMANCE SCROLL FRAME ENGINE v2 (60 FPS, NETWORK-OPTIMISED)
 * ============================================================================
 * Synchronizes 876 background video frames seamlessly with page scroll.
 *
 * Strategy (network-first design for Vercel CDN):
 *  1. Frame 0 loaded first  → hero paints immediately.
 *  2. Sparse keyframe pass  → every 10th frame (88 images) → full 0-100%
 *     scrub is serviceable within ~2-3s on average broadband.
 *  3. JIT neighborhood fill → ±12-frame window around the current scrub
 *     point stays hot, so neighbours are decoded BEFORE the user reaches them.
 *  4. Idle background fill  → remaining ~785 frames stream in 4-at-a-time
 *     batches with a 16ms yield to avoid saturating network sockets.
 *
 * Decoding: every image goes through `await img.decode()` BEFORE being placed
 * in the cache. This offloads JPEG decompression to background threads and
 * guarantees ctx.drawImage() never blocks the main thread.
 * ============================================================================
 */

class SinglePageFrameEngine {
  constructor(options = {}) {
    this.totalFrames   = options.totalFrames  || 876;
    this.framePrefix   = options.framePrefix  || 'tourism/frame_';
    this.frameExt      = options.frameExt     || '.jpg';
    this.canvas        = document.getElementById('bg-canvas');
    this.ctx           = this.canvas
                           ? this.canvas.getContext('2d', { alpha: false })
                           : null;

    // Cache & status tracking
    this.cache   = new Array(this.totalFrames).fill(null);
    // 0 = untouched, 1 = in-flight, 2 = decoded & ready
    this.status  = new Uint8Array(this.totalFrames);
    // Deduplication: prevents two fetches launching for the same frame
    this.inFlight = new Set();

    // Lerp scrub state
    this.targetProgress  = 0;
    this.currentProgress = 0;
    this.lerpFactor      = 0.10; // Apple-style momentum damping
    this.lastDrawnFrame  = -1;

    // Section + nav tracking
    this.sections = document.querySelectorAll('main > section');
    this.navLinks = document.querySelectorAll('.site-nav .nav-link');

    this.init();
  }

  // ---------------------------------------------------------------------------
  getFrameUrl(index) {
    const padded = String(index).padStart(6, '0');
    return `${this.framePrefix}${padded}${this.frameExt}`;
  }

  // ---------------------------------------------------------------------------
  init() {
    if (!this.canvas || !this.ctx) return;

    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas(), { passive: true });

    window.addEventListener('scroll', () => {
      this.onScroll();
      this.updateActiveNav();
    }, { passive: true });

    this.onScroll();
    this.currentProgress = this.targetProgress;

    this.startRenderLoop();
    this.startPreloadPipeline();
    this.bindHeaderScroll();
    this.bindAnchorClicks();
  }

  // ---------------------------------------------------------------------------
  resizeCanvas() {
    const dpr    = Math.min(window.devicePixelRatio || 1, 2);
    const width  = window.innerWidth;
    const height = window.innerHeight;

    if (this.canvas.width !== width * dpr || this.canvas.height !== height * dpr) {
      this.canvas.width  = width  * dpr;
      this.canvas.height = height * dpr;
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'high';

      if (this.lastDrawnFrame >= 0 && this.cache[this.lastDrawnFrame]) {
        this.renderFrame(this.lastDrawnFrame);
      }
    }
  }

  // ===========================================================================
  // CORE LOADER — off-thread async decode via img.decode()
  // ===========================================================================

  loadFrame(index) {
    if (index < 0 || index >= this.totalFrames) return Promise.resolve(null);
    if (this.status[index] === 2)               return Promise.resolve(this.cache[index]);

    // Return a waiting promise if already in-flight
    if (this.inFlight.has(index)) {
      return new Promise(resolve => {
        const poll = setInterval(() => {
          if (this.status[index] === 2) {
            clearInterval(poll);
            resolve(this.cache[index]);
          }
        }, 20);
      });
    }

    this.status[index] = 1;
    this.inFlight.add(index);

    const img = new Image();
    img.decoding = 'async';
    img.src = this.getFrameUrl(index);

    return img.decode()
      .then(() => {
        this.cache[index]  = img;
        this.status[index] = 2;
        this.inFlight.delete(index);
        return img;
      })
      .catch(() => {
        // Fallback for browsers that don't fully support img.decode()
        return new Promise(resolve => {
          img.onload = () => {
            this.cache[index]  = img;
            this.status[index] = 2;
            this.inFlight.delete(index);
            resolve(img);
          };
          img.onerror = () => {
            this.status[index] = 0;
            this.inFlight.delete(index);
            resolve(null);
          };
        });
      });
  }

  // ===========================================================================
  // STRATIFIED PRELOAD PIPELINE
  // ===========================================================================

  async startPreloadPipeline() {
    // Phase 1 — Frame 0 for instant hero render
    await this.loadFrame(0);
    this.renderFrame(0);

    // Phase 2 — Sparse keyframes: every 10th frame = 88 images
    // Gives serviceable full-range scrub within ~2-3s on broadband.
    const keyframes = [];
    for (let i = 10; i < this.totalFrames; i += 10) {
      keyframes.push(i);
    }
    keyframes.push(this.totalFrames - 1); // last frame always ready

    const BATCH = 6;
    for (let i = 0; i < keyframes.length; i += BATCH) {
      const slice = keyframes.slice(i, i + BATCH);
      await Promise.all(slice.map(idx => this.loadFrame(idx)));
    }

    // Phase 3 — Background idle fill (remaining ~785 frames)
    this.fillRemainingFrames();
  }

  async fillRemainingFrames() {
    const missing = [];
    for (let i = 0; i < this.totalFrames; i++) {
      if (this.status[i] === 0) missing.push(i);
    }

    const BATCH = 4;
    for (let i = 0; i < missing.length; i += BATCH) {
      await new Promise(r => setTimeout(r, 16)); // yield between batches
      const slice = missing.slice(i, i + BATCH);
      await Promise.all(slice.map(idx => this.loadFrame(idx)));
    }
  }

  // ===========================================================================
  // JIT NEIGHBORHOOD FILL (called every RAF tick)
  // ===========================================================================

  primeNeighborhood(centerIdx) {
    for (let offset = -12; offset <= 12; offset++) {
      const idx = centerIdx + offset;
      if (idx >= 0 && idx < this.totalFrames && this.status[idx] === 0) {
        this.loadFrame(idx); // fire-and-forget
      }
    }
  }

  // ===========================================================================
  // SCROLL & RENDER LOOP
  // ===========================================================================

  onScroll() {
    const maxScroll = (document.documentElement.scrollHeight - window.innerHeight) || 1;
    this.targetProgress = Math.max(0, Math.min(1, window.scrollY / maxScroll));
  }

  startRenderLoop() {
    const loop = () => {
      this.currentProgress += (this.targetProgress - this.currentProgress) * this.lerpFactor;

      const targetFrame = Math.max(0, Math.min(
        this.totalFrames - 1,
        Math.round(this.currentProgress * (this.totalFrames - 1))
      ));

      this.primeNeighborhood(targetFrame);

      if (targetFrame !== this.lastDrawnFrame) {
        this.renderFrame(targetFrame);
      }

      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
  }

  // ===========================================================================
  // RENDER (aspect-ratio cover)
  // ===========================================================================

  getBestFrame(index) {
    if (this.cache[index]) return this.cache[index];

    for (let r = 1; r < 40; r++) {
      if (index - r >= 0                && this.cache[index - r]) return this.cache[index - r];
      if (index + r < this.totalFrames  && this.cache[index + r]) return this.cache[index + r];
    }
    return null;
  }

  renderFrame(frameIndex) {
    const img = this.getBestFrame(frameIndex);
    if (!img) return;

    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const iw = img.naturalWidth  || 1280;
    const ih = img.naturalHeight || 720;

    const scale = Math.max(cw / iw, ch / ih);
    const sw = iw * scale;
    const sh = ih * scale;
    const sx = (cw - sw) / 2;
    const sy = (ch - sh) / 2;

    this.ctx.drawImage(img, sx, sy, sw, sh);
    this.lastDrawnFrame = frameIndex;
  }

  // ===========================================================================
  // NAV + ANCHOR HELPERS
  // ===========================================================================

  updateActiveNav() {
    const scrollPos = window.scrollY + window.innerHeight * 0.35;
    let currentId = '';

    this.sections.forEach(sec => {
      if (scrollPos >= sec.offsetTop && scrollPos < sec.offsetTop + sec.offsetHeight) {
        currentId = sec.getAttribute('id');
      }
    });

    this.navLinks.forEach(link => {
      link.classList.toggle('active', link.getAttribute('href') === `#${currentId}`);
    });
  }

  bindAnchorClicks() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
      anchor.addEventListener('click', e => {
        const targetId = anchor.getAttribute('href');
        if (!targetId || targetId === '#') return;
        const el = document.querySelector(targetId);
        if (!el) return;
        e.preventDefault();
        el.scrollIntoView({ behavior: 'smooth' });
      });
    });
  }

  bindHeaderScroll() {
    const header = document.querySelector('.site-header');
    if (!header) return;
    window.addEventListener('scroll', () => {
      header.classList.toggle('scrolled', window.scrollY > 40);
    }, { passive: true });
  }
}

// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  window.frameEngine = new SinglePageFrameEngine();
});
