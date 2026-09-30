// <cad-viewer> — an embeddable 3D model viewer for GLB/glTF, with orbit,
// flick-to-spin, and scrubbable exploded views authored as glTF animations.
// https://github.com/cobylai/cad-viewer — MIT License

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Decoders are fetched only when a model needs them. Default to the copy on
// jsDelivr that matches the installed three.js; override per element with
// draco-decoder-path / ktx2-transcoder-path to self-host.
const LIBS = `https://cdn.jsdelivr.net/npm/three@0.${THREE.REVISION}.0/examples/jsm/libs/`;

const SPIN_CUTOFF     = 0.012;        // rad/s; slower releases don't fling
const MAX_RPM         = 15;           // flings above this ease back down to it
const SPIN_DECAY      = 3;            // 1/s, rate the excess over MAX_RPM decays
const FLING_WINDOW    = 0.06;         // s of drag history averaged into a fling
const EXPLODE_STEPS   = 8;            // poses sampled when framing with fit-explode
const KEY_ROTATE      = Math.PI / 24; // rad per arrow-key press
const KEY_ZOOM        = 1.15;
const AUTO_RESUME_MS  = 15000;
const ZOOM_RESTORE_MS = 30000;
const RELOCK_MS       = 30000;
const ASPECT_RE       = /^\s*\d*\.?\d+\s*(\/\s*\d*\.?\d+\s*)?$/;

// Attributes that change how the model is framed.
const REFIT = new Set(['camera-tilt', 'default-zoom', 'camera-offset-y', 'fit-explode', 'flip']);

const STYLE = `
:host { display: block; }
:host([hidden]) { display: none; }
.frame {
  position: relative;
  aspect-ratio: var(--_aspect, 16 / 9);
  overflow: hidden;
  background: var(--cad-viewer-bg, transparent);
  border: var(--cad-viewer-border, 1px solid rgba(128, 128, 128, 0.35));
  border-radius: var(--cad-viewer-radius, 4px);
}
:host([no-interact]) .frame { pointer-events: none; }
canvas { display: block; width: 100%; height: 100%; outline-offset: -3px; }
.overlay {
  position: absolute; inset: 0; z-index: 2;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; outline-offset: -3px; transition: background 0.1s;
}
.overlay.hint { background: var(--cad-viewer-hint-bg, rgba(128, 128, 128, 0.22)); }
.label, .status {
  font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--cad-viewer-fg, currentColor);
}
.label {
  padding: 3px 10px; border: 1px solid currentColor; border-radius: 3px;
  background: var(--cad-viewer-label-bg, var(--cad-viewer-bg, Canvas));
  opacity: 0; pointer-events: none; transition: opacity 0.1s;
}
.overlay.hint .label { opacity: 1; }
.status {
  position: absolute; inset: 0; z-index: 1;
  display: flex; align-items: center; justify-content: center;
  opacity: 0.6; pointer-events: none;
}
.controls { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
[hidden] { display: none !important; }
input[type=range] { flex: 1; cursor: pointer; accent-color: var(--cad-viewer-fg, currentColor); }
button {
  font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--cad-viewer-fg, currentColor); background: transparent;
  border: 1px solid currentColor; border-radius: 3px;
  padding: 3px 8px; cursor: pointer; flex-shrink: 0;
}
`;

export class CadViewer extends HTMLElement {
  static observedAttributes = [
    'src', 'alt', 'aspect-ratio', 'rotation-speed', 'animation-speed', 'exposure',
    'studio-light', 'lock-zoom', 'no-interact', 'no-explode', ...REFIT,
  ];

  get src() { return this.getAttribute('src'); }
  set src(v) { this.setAttribute('src', v); }

  connectedCallback() {
    // A DOM move reconnects synchronously and keeps everything running.
    if (!this._ready) this._init();
  }

  disconnectedCallback() {
    // Deferred so a move isn't torn down; a real removal frees everything.
    queueMicrotask(() => { if (!this.isConnected) this._teardown(); });
  }

  attributeChangedCallback(name, oldVal, val) {
    if (!this._ready || oldVal === val) return;
    switch (name) {
      case 'src':             this._load(); break;
      case 'alt':             this._canvas.setAttribute('aria-label', val || '3D model'); break;
      case 'aspect-ratio':    this._applyAspect(); break;
      case 'rotation-speed':
        this._configuredRotSpeed = this._num('rotation-speed', 1);
        if (this._orbit.autoRotate && !this._isDragging) this._orbit.autoRotateSpeed = this._configuredRotSpeed;
        break;
      case 'animation-speed': this._applyAnimationSpeed(); break;
      case 'exposure':        this._applyExposure(); break;
      case 'studio-light':    this._applyLighting(); break;
      case 'lock-zoom':       this._orbit.enableZoom = !this.hasAttribute('lock-zoom'); break;
      case 'no-interact':     this._applyInteractMode(); break;
      case 'no-explode':      this._load(); break;
      default:                if (REFIT.has(name)) this._frame();
    }
  }

  // ── Setup / teardown ────────────────────────────────────────────────────────

  _init() {
    this._ready = true;
    const root = this.shadowRoot || this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${STYLE}</style>
      <div class="frame" part="frame">
        <canvas part="canvas" role="img"></canvas>
        <div class="status" part="status" hidden></div>
      </div>
      <div class="controls" part="controls" hidden>
        <input type="range" min="0" max="1" step="0.001" value="0" aria-label="Explode">
        <button type="button" aria-label="Play explode animation">▶</button>
      </div>`;
    this._frameEl  = root.querySelector('.frame');
    this._canvas   = root.querySelector('canvas');
    this._statusEl = root.querySelector('.status');
    this._ctrlEl   = root.querySelector('.controls');
    this._slider   = root.querySelector('input');
    this._autoBtn  = root.querySelector('button');
    this._canvas.setAttribute('aria-label', this.getAttribute('alt') || '3D model');
    this._applyAspect();

    this._slider.addEventListener('input', () => {
      this._stopAutoExplode();
      this._scrubToTime(parseFloat(this._slider.value));
    });
    this._autoBtn.addEventListener('click', () => {
      this._autoExplodeActive ? this._stopAutoExplode() : this._startAutoExplode();
    });
    this._canvas.addEventListener('keydown', (e) => this._onKeyDown(e));

    // Browsers cap live WebGL contexts and drop the oldest when over. Rebuild
    // the next time this viewer is on screen.
    this._contextLost = false;
    this._canvas.addEventListener('webglcontextlost', () => { this._contextLost = true; this._stopLoop(); });
    this._canvas.addEventListener('webglcontextrestored', () => { if (this._visible) this._rebuild(); });

    this._setupThree();
    this._applyInteractMode();

    // Render only while on (or near) screen.
    this._visible = false;
    this._io = new IntersectionObserver((entries) => {
      this._visible = entries[entries.length - 1].isIntersecting;
      if (!this._visible) { this._stopLoop(); return; }
      if (this._contextLost) { this._rebuild(); return; }
      this._startLoop();
    }, { rootMargin: '200px' });
    this._io.observe(this);

    this._load();
  }

  _teardown() {
    if (!this._ready) return;
    this._ready = false;
    this._loadSeq = (this._loadSeq || 0) + 1; // orphan any in-flight load
    this._stopLoop();
    this._io?.disconnect();
    this._ro?.disconnect();
    clearTimeout(this._autoResumeTimer);
    clearTimeout(this._zoomRestoreTimer);
    this._stopRelockListeners();
    this._clearModel();
    this._scene?.environment?.dispose();
    this._orbit?.dispose();
    this._draco?.dispose();
    this._ktx2?.dispose();
    if (this._renderer) {
      this._renderer.dispose();
      if (!this._contextLost) this._renderer.forceContextLoss(); // release the context now
    }
    this._io = this._ro = this._orbit = this._draco = this._ktx2 = this._renderer = this._scene = null;
    this._overlay = null;
    this.shadowRoot.innerHTML = '';
  }

  _rebuild() {
    this._teardown();
    if (this.isConnected) this._init();
  }

  _setupThree() {
    // Always transparent: the frame's CSS background shows through, so theme
    // changes need nothing from the renderer.
    const renderer = new THREE.WebGLRenderer({ canvas: this._canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping      = THREE.ACESFilmicToneMapping;
    this._renderer = renderer;
    this._applyExposure();

    this._scene = new THREE.Scene();
    this._lights = new THREE.Group();
    this._scene.add(this._lights);
    this._applyLighting();

    this._camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    this._camera.position.set(3, 2, 5);

    this._configuredRotSpeed = this._num('rotation-speed', 1);
    this._defaultDist        = null; // non-null once a model has been framed
    this._defaultOrbTarget   = null;
    this._zoomLerping        = false;

    const controls = new OrbitControls(this._camera, this._canvas);
    controls.enableDamping      = true;
    controls.dampingFactor      = 0.08;
    controls.screenSpacePanning = true;
    controls.autoRotate         = true;
    controls.autoRotateSpeed    = this._configuredRotSpeed;
    controls.enableZoom         = !this.hasAttribute('lock-zoom');
    this._orbit = controls;

    this._isDragging = false;
    this._dragHist   = []; // [dt, dTheta] per frame while dragging

    controls.addEventListener('start', () => {
      this._isDragging = true;
      this._dragHist   = [];
      this._onInteractStart();
    });
    controls.addEventListener('end', () => {
      this._isDragging = false;
      // Average the last FLING_WINDOW seconds: pointer events don't line up
      // with frames, so a single frame's delta is noisy.
      let t = 0, th = 0;
      for (let i = this._dragHist.length - 1; i >= 0 && t < FLING_WINDOW; i--) {
        t  += this._dragHist[i][0];
        th += this._dragHist[i][1];
      }
      this._dragHist = [];
      const vel = t > 0 ? th / t : 0; // rad/s
      if (Math.abs(vel) > SPIN_CUTOFF) {
        // Keep spinning at the release speed. Damping off, or its inertia
        // fights the constant rotation. autoRotateSpeed is RPM, and
        // OrbitControls subtracts it from theta, hence the sign.
        controls.enableDamping   = false;
        controls.autoRotate      = true;
        controls.autoRotateSpeed = -vel * 30 / Math.PI;
      }
      this._onInteractEnd();
    });

    this._mixer             = null;
    this._actions           = [];
    this._clipMaxDur        = 0;
    this._autoExplodeActive = false;
    this._autoExplodeT      = 0;
    this._autoExplodeDir    = 1;
    this._applyAnimationSpeed();

    this._draco = new DRACOLoader().setDecoderPath(this.getAttribute('draco-decoder-path') || LIBS + 'draco/gltf/');
    this._ktx2  = new KTX2Loader().setTranscoderPath(this.getAttribute('ktx2-transcoder-path') || LIBS + 'basis/').detectSupport(renderer);

    this._ro = new ResizeObserver(() => this._onResize());
    this._ro.observe(this._frameEl);
    this._onResize();
  }

  // ── Attribute appliers ──────────────────────────────────────────────────────

  _num(name, fallback) {
    const v = parseFloat(this.getAttribute(name));
    return isNaN(v) ? fallback : v;
  }

  _applyAspect() {
    const v = this.getAttribute('aspect-ratio');
    if (v && ASPECT_RE.test(v)) this._frameEl.style.setProperty('--_aspect', v);
    else this._frameEl.style.removeProperty('--_aspect');
  }

  _applyExposure() {
    const e = this._num('exposure', 1);
    this._renderer.toneMappingExposure = e > 0 ? e : 1;
  }

  _applyAnimationSpeed() {
    // animation-speed = seconds per full explode + implode cycle
    const s = this._num('animation-speed', 12);
    this._autoExplodeSpeed = 2 / (s > 0 ? s : 12);
  }

  // studio-light: image-based lighting from a neutral room, so dark or glossy
  // models pick up reflections instead of reading flat. It replaces the
  // ambient fill; the key and fill lights stay for shape.
  _applyLighting() {
    const studio = this.hasAttribute('studio-light');
    this._lights.clear();
    this._scene.environment?.dispose();
    this._scene.environment = null;
    if (studio) {
      const pmrem = new THREE.PMREMGenerator(this._renderer);
      const room  = new RoomEnvironment();
      this._scene.environment = pmrem.fromScene(room, 0.04).texture;
      room.dispose();
      pmrem.dispose();
    } else {
      this._lights.add(new THREE.AmbientLight(0xffffff, 0.7));
    }
    const key = new THREE.DirectionalLight(0xffffff, studio ? 0.8 : 1.2);
    key.position.set(5, 10, 7);
    const fill = new THREE.DirectionalLight(0xffffff, 0.3);
    fill.position.set(-5, -3, -6);
    this._lights.add(key, fill);
  }

  // no-interact: a display-only turntable. No overlay, orbit, zoom or explode
  // controls, and pointer events pass through so the page scrolls. It still
  // auto-rotates: OrbitControls.update() ignores `enabled` for autoRotate.
  _applyInteractMode() {
    const off = this.hasAttribute('no-interact');
    this._orbit.enabled = !off;
    if (off) {
      this._stopRelockListeners();
      this._overlay?.remove();
      this._overlay = null;
      this._canvas.removeAttribute('tabindex');
    } else if (!this._overlay && this._canvas.tabIndex !== 0) {
      this._addOverlay();
    }
    this._updateControls();
  }

  _updateControls() {
    this._ctrlEl.hidden = !this._mixer || this.hasAttribute('no-interact');
  }

  _setStatus(text) {
    this._statusEl.textContent = text || '';
    this._statusEl.hidden = !text;
  }

  // ── Interaction ─────────────────────────────────────────────────────────────

  // Shared by pointer (OrbitControls start/end) and keyboard interaction.
  _onInteractStart() {
    this._orbit.autoRotate    = false;
    this._orbit.enableDamping = true;
    clearTimeout(this._autoResumeTimer);
    clearTimeout(this._zoomRestoreTimer);
    this._zoomLerping = false;
  }

  _onInteractEnd() {
    if (!this.hasAttribute('no-auto-resume')) {
      this._autoResumeTimer = setTimeout(() => {
        const c = this._orbit;
        if (!c) return;
        c.autoRotate      = true;
        c.autoRotateSpeed = this._configuredRotSpeed;
        c.enableDamping   = true;
      }, AUTO_RESUME_MS);
    }
    // Zoom restore eases distance and target back to their defaults while
    // keeping the current viewing angle.
    if (!this.hasAttribute('no-zoom-restore') && this._defaultDist !== null) {
      this._zoomRestoreTimer = setTimeout(() => {
        if (this._defaultDist === null || !this._orbit) return;
        this._zoomLerping        = true;
        this._zoomLerpT          = 0;
        this._zoomLerpFromDist   = this._camera.position.distanceTo(this._orbit.target);
        this._zoomLerpFromTarget = this._orbit.target.clone();
      }, ZOOM_RESTORE_MS);
    }
  }

  // Arrows orbit, +/- zoom, Escape hands control back to the page.
  _onKeyDown(e) {
    if (e.key === 'Escape') { this._relock(); return; }
    const k = { ArrowLeft: [-1, 0, 1], ArrowRight: [1, 0, 1], ArrowUp: [0, -1, 1], ArrowDown: [0, 1, 1],
                '+': [0, 0, 1 / KEY_ZOOM], '=': [0, 0, 1 / KEY_ZOOM], '-': [0, 0, KEY_ZOOM] }[e.key];
    if (!k || !this._orbit.enabled) return;
    if (k[2] !== 1 && !this._orbit.enableZoom) return;
    e.preventDefault();
    this._onInteractStart();
    const c   = this._orbit;
    const off = this._camera.position.clone().sub(c.target);
    const sph = new THREE.Spherical().setFromVector3(off);
    sph.theta -= k[0] * KEY_ROTATE;
    sph.phi    = THREE.MathUtils.clamp(sph.phi + k[1] * KEY_ROTATE, 0.05, Math.PI - 0.05);
    sph.radius = THREE.MathUtils.clamp(sph.radius * k[2], c.minDistance, c.maxDistance);
    this._camera.position.copy(c.target).add(off.setFromSpherical(sph));
    this._onInteractEnd();
  }

  // The overlay keeps the canvas from capturing scroll and touch while the
  // reader is just passing through. Click (or Enter) to hand control over.
  _addOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.setAttribute('part', 'overlay');
    overlay.tabIndex = 0;
    overlay.setAttribute('role', 'button');
    overlay.setAttribute('aria-label', 'Interact with 3D model');
    overlay.innerHTML = '<span class="label">click to interact</span>';

    let moved = false;
    let wheelTimer = null;
    const showHint = () => overlay.classList.add('hint');
    const hideHint = () => { overlay.classList.remove('hint'); moved = false; };
    const unlock = (focusCanvas) => {
      overlay.remove();
      this._overlay = null;
      this._canvas.tabIndex = 0;
      if (focusCanvas) this._canvas.focus();
      this._startRelockListeners();
    };

    overlay.addEventListener('pointerdown', () => { moved = false; showHint(); });
    // A drag over the overlay is a scroll, not a click.
    overlay.addEventListener('pointermove', (e) => { if (e.buttons) moved = true; });
    overlay.addEventListener('pointerleave', hideHint);
    overlay.addEventListener('pointercancel', hideHint);
    overlay.addEventListener('wheel', () => {
      showHint();
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(hideHint, 1500);
    }, { passive: true });
    overlay.addEventListener('click', () => { if (!moved) unlock(false); });
    overlay.addEventListener('focus', () => { if (overlay.matches(':focus-visible')) showHint(); });
    overlay.addEventListener('blur', hideHint);
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); unlock(true); }
    });

    this._frameEl.appendChild(overlay);
    this._overlay = overlay;
  }

  // Once unlocked, the overlay returns after RELOCK_MS without activity, or
  // on a pointerdown anywhere outside this element.
  _startRelockListeners() {
    const reset = () => {
      clearTimeout(this._relockTimer);
      this._relockTimer = setTimeout(() => this._relock(), RELOCK_MS);
    };
    this._activityHandler = reset;
    for (const t of ['pointermove', 'pointerdown', 'keydown']) this.addEventListener(t, reset);
    reset();
    this._docRelockHandler = (e) => { if (!e.composedPath().includes(this)) this._relock(); };
    document.addEventListener('pointerdown', this._docRelockHandler, { capture: true });
  }

  _stopRelockListeners() {
    clearTimeout(this._relockTimer);
    if (this._activityHandler) {
      for (const t of ['pointermove', 'pointerdown', 'keydown']) this.removeEventListener(t, this._activityHandler);
      this._activityHandler = null;
    }
    if (this._docRelockHandler) {
      document.removeEventListener('pointerdown', this._docRelockHandler, { capture: true });
      this._docRelockHandler = null;
    }
  }

  _relock() {
    this._stopRelockListeners();
    if (this._overlay || !this._ready || this.hasAttribute('no-interact')) return;
    const hadFocus = this.shadowRoot.activeElement === this._canvas;
    this._canvas.removeAttribute('tabindex');
    this._addOverlay();
    if (hadFocus) this._overlay.focus();
  }

  // ── Render loop ─────────────────────────────────────────────────────────────

  _onResize() {
    if (!this._renderer) return;
    const w = Math.max(this._frameEl.clientWidth, 1);
    const h = Math.max(this._frameEl.clientHeight, 1);
    this._renderer.setSize(w, h, false);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
  }

  _stopLoop() {
    this._running = false;
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
  }

  _startLoop() {
    if (this._running || !this._renderer) return;
    this._running = true;
    let prev = null;
    const loop = (time) => {
      if (!this._running) return;
      this._rafId = requestAnimationFrame(loop);
      const dt = prev !== null ? Math.min((time - prev) / 1000, 0.1) : 0;
      prev = time;

      const c = this._orbit;
      let thetaBefore = 0;
      if (this._isDragging) {
        const off = this._camera.position.clone().sub(c.target);
        thetaBefore = Math.atan2(off.x, off.z);
      }

      // dt makes auto-rotate real RPM on any refresh rate.
      c.update(dt);

      if (this._isDragging && dt > 0) {
        const off = this._camera.position.clone().sub(c.target);
        let d = Math.atan2(off.x, off.z) - thetaBefore;
        if (d >  Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        this._dragHist.push([dt, d]);
        if (this._dragHist.length > 60) this._dragHist.shift();
      }

      // A fast fling eases back to MAX_RPM rather than spinning forever.
      if (!this._isDragging && c.autoRotate && dt > 0) {
        const s = c.autoRotateSpeed, abs = Math.abs(s);
        if (abs > MAX_RPM) c.autoRotateSpeed = Math.sign(s) * (MAX_RPM + (abs - MAX_RPM) * Math.exp(-SPIN_DECAY * dt));
      }

      this._updateAutoExplode(dt);

      // Zoom restore, applied after update() so it wins this frame. Orbit
      // re-reads the camera position next update, so nothing needs resyncing.
      if (this._zoomLerping) {
        this._zoomLerpT = Math.min(this._zoomLerpT + dt / 2, 1);
        const ease = 1 - Math.pow(1 - this._zoomLerpT, 3);
        const dir  = this._camera.position.clone().sub(c.target).normalize();
        c.target.lerpVectors(this._zoomLerpFromTarget, this._defaultOrbTarget, ease);
        const dist = THREE.MathUtils.lerp(this._zoomLerpFromDist, this._defaultDist, ease);
        this._camera.position.copy(c.target).addScaledVector(dir, dist);
        this._camera.lookAt(c.target);
        if (this._zoomLerpT >= 1) this._zoomLerping = false;
      }

      this._renderer.render(this._scene, this._camera);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  // ── Loading ─────────────────────────────────────────────────────────────────

  _clearModel() {
    this._stopAutoExplode();
    if (this._mixer) { this._mixer.stopAllAction(); this._mixer = null; }
    this._actions = [];
    this._clipMaxDur = 0;
    if (this._model) {
      this._scene?.remove(this._model);
      disposeObject(this._model);
      this._model = null;
    }
  }

  _load() {
    const src = this.getAttribute('src');
    this._clearModel();
    this._autoExplodeT   = 0;
    this._autoExplodeDir = 1;
    this._slider.value   = 0;
    this._updateControls();
    const seq = this._loadSeq = (this._loadSeq || 0) + 1;
    if (!src) { this._setStatus(''); return; }
    this._setStatus('loading…');

    const loader = new GLTFLoader()
      .setDRACOLoader(this._draco)
      .setKTX2Loader(this._ktx2)
      .setMeshoptDecoder(MeshoptDecoder);

    loader.load(src, (gltf) => {
      // Only the newest load lands; a slower earlier one is dropped.
      if (seq !== this._loadSeq || !this._scene) { disposeObject(gltf.scene); return; }
      this._setStatus('');
      this._model = gltf.scene;
      this._scene.add(this._model);

      // Rest-pose bounds in the model's own space, before any animation pose.
      const bounds = () => new THREE.Box3().setFromObject(this._model);
      this._restBox = bounds();
      this._explodeBox = null;

      if (!this.hasAttribute('no-explode') && gltf.animations.length) {
        this._mixer   = new THREE.AnimationMixer(this._model);
        this._actions = gltf.animations.map((clip) => {
          const a = this._mixer.clipAction(clip);
          a.loop = THREE.LoopOnce;
          a.clampWhenFinished = true;
          return a;
        });
        this._clipMaxDur = Math.max(...gltf.animations.map((c) => c.duration));
        if (this._clipMaxDur > 0) {
          this._explodeBox = this._restBox.clone();
          for (let i = EXPLODE_STEPS; i >= 1; i--) {
            this._scrubToTime(i / EXPLODE_STEPS);
            this._explodeBox.union(bounds());
          }
        }
        this._scrubToTime(0);
      }

      this._frame();
      this._updateControls();
      if (this._mixer && this.hasAttribute('autoplay')) this._startAutoExplode();
      this.dispatchEvent(new CustomEvent('load', { detail: { scene: gltf.scene, animations: gltf.animations } }));
    }, (e) => {
      if (seq !== this._loadSeq) return;
      if (e.lengthComputable) this._setStatus(`loading… ${Math.round(100 * e.loaded / e.total)}%`);
      this.dispatchEvent(new CustomEvent('progress', { detail: { loaded: e.loaded, total: e.total } }));
    }, (error) => {
      if (seq !== this._loadSeq) return;
      this._setStatus("couldn't load model");
      this.dispatchEvent(new CustomEvent('error', { detail: { error } }));
    });
  }

  // ── Framing ─────────────────────────────────────────────────────────────────

  _frame() {
    if (!this._model) return;
    // flip: rotate 180° about X to correct an upside-down export.
    this._model.rotation.x = this.hasAttribute('flip') ? Math.PI : 0;
    this._model.updateMatrix();
    // fit-explode: also frame the whole explode range, so parts never leave
    // the view (the assembled model then sits smaller).
    const local = this.hasAttribute('fit-explode') && this._explodeBox ? this._explodeBox : this._restBox;
    const box = local.clone().applyMatrix4(this._model.matrix);

    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    // default-zoom: 1 = auto-fit, >1 = closer, <1 = further
    const zoom = Math.max(this._num('default-zoom', 1) || 1, 0.1);
    const dist = (maxDim / 2) / Math.tan(this._camera.fov * Math.PI / 360) * 1.6 / zoom;

    const c = this._orbit;
    c.target.copy(center);
    // camera-offset-y: positive moves the model up in the frame
    c.target.y -= this._num('camera-offset-y', 0) * maxDim;

    // camera-tilt: elevation in degrees above the horizon; absent ≈ 17°.
    const offset = new THREE.Vector3(dist * 0.55, dist * 0.35, dist);
    const tilt = parseFloat(this.getAttribute('camera-tilt'));
    if (!isNaN(tilt)) {
      const el = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(tilt, 0, 89));
      const r  = offset.length();
      offset.set(0.55, 0, 1).normalize().multiplyScalar(Math.cos(el)).setY(Math.sin(el)).multiplyScalar(r);
    }
    this._camera.position.copy(c.target).add(offset);
    this._camera.near = dist * 0.005;
    this._camera.far  = dist * 20;
    this._camera.updateProjectionMatrix();
    // Keep zoom inside the clip planes so the model can't be clipped away.
    c.minDistance = dist * 0.05;
    c.maxDistance = dist * 8;
    c.update();

    this._defaultDist      = this._camera.position.distanceTo(c.target);
    this._defaultOrbTarget = c.target.clone();
  }

  // ── Exploded view ───────────────────────────────────────────────────────────
  // The GLB's animation clips are the explode; the slider maps 0–1 onto the
  // longest clip. mixer.update(0) doesn't re-evaluate a pose in three.js, so
  // every scrub resets, plays, advances to the target time, and re-pauses.

  _scrubToTime(t) {
    if (!this._mixer || this._clipMaxDur === 0) return;
    this._actions.forEach((a) => { a.reset(); a.play(); });
    this._mixer.update(t * this._clipMaxDur || Number.EPSILON);
    this._actions.forEach((a) => { a.paused = true; });
  }

  _startAutoExplode() {
    if (!this._mixer) return;
    this._autoExplodeT      = parseFloat(this._slider.value);
    this._autoExplodeDir    = 1;
    this._autoExplodeActive = true;
    this._autoBtn.textContent = '■';
    this._autoBtn.setAttribute('aria-label', 'Stop explode animation');
  }

  _stopAutoExplode() {
    this._autoExplodeActive = false;
    if (!this._autoBtn) return;
    this._autoBtn.textContent = '▶';
    this._autoBtn.setAttribute('aria-label', 'Play explode animation');
  }

  _updateAutoExplode(dt) {
    if (!this._autoExplodeActive || dt === 0) return;
    this._autoExplodeT += this._autoExplodeDir * this._autoExplodeSpeed * dt;
    if (this._autoExplodeT >= 1) { this._autoExplodeT = 1; this._autoExplodeDir = -1; }
    else if (this._autoExplodeT <= 0) { this._autoExplodeT = 0; this._autoExplodeDir = 1; }
    this._slider.value = this._autoExplodeT;
    this._scrubToTime(this._autoExplodeT);
  }
}

// Free the geometry, materials and textures under a loaded model.
function disposeObject(root) {
  root.traverse((obj) => {
    obj.geometry?.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      m.dispose();
    }
  });
}

if (!customElements.get('cad-viewer')) customElements.define('cad-viewer', CadViewer);
