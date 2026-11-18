/* Relais — voix : dictée (micro → texte) et lecture à voix haute.
 *
 * Deux façons de transcrire :
 *  - "browser" : reconnaissance du navigateur (Web Speech API), en direct. Marche dans Edge/Chrome,
 *                pas dans la fenêtre Relais.exe (WebView2).
 *  - "server"  : le son est enregistré ici (WAV 16 kHz) puis transcrit par Relais
 *                (API OpenAI si une clé est enregistrée, sinon la reconnaissance vocale de Windows).
 */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const TARGET_RATE = 16000;

export const voiceSupport = {
  mic: !!navigator.mediaDevices?.getUserMedia,
  browser: !!SR,
  tts: 'speechSynthesis' in window,
};

/** Encode des échantillons mono en WAV PCM 16 bits. */
function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

function downsample(chunks, from, to) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  if (from === to) return all;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(total / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), total);
    let sum = 0;
    for (let j = start; j < end; j++) sum += all[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

export class VoiceInput {
  /**
   * @param {object} o
   * @param {() => 'browser'|'server'} o.engine
   * @param {() => string} o.lang  ex. "fr-FR"
   * @param {(state: 'idle'|'listening'|'transcribing') => void} o.onState
   * @param {(level: number) => void} o.onLevel   0..1
   * @param {(text: string, final: boolean) => void} o.onText
   * @param {(msg: string) => void} o.onError
   */
  constructor(o) {
    this.o = o;
    this.state = 'idle';
    this.started = 0;
  }

  setState(s) { this.state = s; this.o.onState?.(s); }

  get busy() { return this.state !== 'idle'; }

  async start({ autoStop = false } = {}) {
    if (this.busy) return;
    this.autoStop = autoStop;
    this.cancelled = false;
    this.started = Date.now();
    if (this.o.engine() === 'browser' && SR) return this.startBrowser();
    return this.startRecording();
  }

  /* ---------- Web Speech API ---------- */
  startBrowser() {
    const rec = new SR();
    rec.lang = this.o.lang();
    rec.interimResults = true;
    rec.continuous = !this.autoStop;
    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      this.o.onText(`${finalText}${interim}`.trim(), false);
      this.o.onLevel?.(0.5 + Math.random() * 0.3);
    };
    rec.onerror = (e) => {
      if (e.error === 'aborted' || e.error === 'no-speech') return;
      this.failed = true;
      this.o.onError(e.error === 'not-allowed' ? 'Micro refusé : autorise-le dans le navigateur.'
        : e.error === 'network' ? 'Reconnaissance du navigateur indisponible ici. Choisis « Relais (serveur) » dans Réglages → Voix.'
          : `Reconnaissance vocale : ${e.error}`);
    };
    rec.onend = () => {
      this.rec = null;
      this.o.onLevel?.(0);
      if (!this.cancelled && !this.failed) this.o.onText(finalText.trim(), true);
      this.failed = false;
      this.setState('idle');
    };
    this.rec = rec;
    try { rec.start(); } catch (e) { this.o.onError(e.message); return; }
    this.setState('listening');
  }

  /* ---------- Enregistrement + transcription par Relais ---------- */
  async startRecording() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      this.o.onError(e.name === 'NotAllowedError' ? 'Micro refusé. Autorise le micro pour Relais (Paramètres Windows → Confidentialité → Microphone).' : `Micro indisponible : ${e.message}`);
      return;
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    let spoke = 0;
    let silentSince = 0;
    proc.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(d));
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      const rms = Math.sqrt(sum / d.length);
      this.o.onLevel?.(Math.min(1, rms * 9));
      const now = Date.now();
      // Détection de silence : arrêt automatique après la fin de la phrase.
      if (rms > 0.025) { spoke += d.length / ctx.sampleRate; silentSince = 0; }
      else if (spoke > 0.25) {
        silentSince ||= now;
        if (this.autoStop && now - silentSince > 1600) this.stop();
      }
      if (now - this.started > 180000) this.stop();
    };
    src.connect(proc);
    proc.connect(ctx.destination);
    this.recording = { stream, ctx, src, proc, chunks, rate: ctx.sampleRate, spoke: () => spoke };
    this.setState('listening');
  }

  async stop() {
    if (this.rec) { this.rec.stop(); return; }
    const r = this.recording;
    if (!r) return;
    this.recording = null;
    try { r.proc.disconnect(); r.src.disconnect(); } catch { /* déjà coupé */ }
    r.stream.getTracks().forEach((t) => t.stop());
    r.ctx.close().catch(() => {});
    this.o.onLevel?.(0);
    if (this.cancelled) { this.setState('idle'); return; }
    if (r.spoke() < 0.2) { this.setState('idle'); this.o.onText('', true); return; }
    this.setState('transcribing');
    try {
      const wav = encodeWav(downsample(r.chunks, r.rate, TARGET_RATE), TARGET_RATE);
      const res = await fetch(`/api/transcribe?lang=${encodeURIComponent(this.o.lang())}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || res.statusText);
      this.o.onText(String(j.text || '').trim(), true);
    } catch (e) {
      this.o.onError(e.message);
    } finally {
      this.setState('idle');
    }
  }

  cancel() {
    this.cancelled = true;
    if (this.rec) { this.rec.abort(); return; }
    this.stop();
  }
}

/* ---------- Lecture à voix haute ---------- */
export function plainForSpeech(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' (bloc de code) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/[*_~>#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function listVoices() {
  if (!voiceSupport.tts) return [];
  return speechSynthesis.getVoices().map((v) => ({ name: v.name, lang: v.lang, local: v.localService }));
}

let speakingId = 0;
/** Lit un texte ; renvoie une promesse résolue à la fin (ou à l'arrêt). */
export function speak(text, { lang = 'fr-FR', voice = '', rate = 1 } = {}) {
  if (!voiceSupport.tts) return Promise.resolve();
  stopSpeaking();
  const id = ++speakingId;
  const all = speechSynthesis.getVoices();
  const v = all.find((x) => x.name === voice) || all.find((x) => x.lang === lang) || all.find((x) => x.lang?.startsWith(lang.slice(0, 2)));
  // Les longues phrases sont coupées : certains moteurs s'arrêtent au-delà de ~15 s.
  const pieces = plainForSpeech(text).match(/[^.!?…]+[.!?…]*\s*/g)?.reduce((acc, s) => {
    if (acc.length && (acc[acc.length - 1] + s).length < 220) acc[acc.length - 1] += s; else acc.push(s);
    return acc;
  }, []) || [];
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (id !== speakingId || i >= pieces.length) return resolve();
      const u = new SpeechSynthesisUtterance(pieces[i++]);
      u.lang = v?.lang || lang;
      if (v) u.voice = v;
      u.rate = rate;
      u.onend = next;
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    };
    next();
  });
}

export function stopSpeaking() {
  speakingId++;
  if (voiceSupport.tts) speechSynthesis.cancel();
}

export const isSpeaking = () => voiceSupport.tts && speechSynthesis.speaking;
