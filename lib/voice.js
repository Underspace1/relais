/**
 * Saisie vocale : transforme un enregistrement WAV (16 kHz, mono) en texte.
 *   - "openai"  : API de transcription d'OpenAI (clé API requise, la plus précise)
 *   - "windows" : reconnaissance vocale intégrée à Windows (hors ligne, gratuite)
 *   - "auto"    : OpenAI si une clé est enregistrée, sinon Windows
 * Le mode « navigateur » (Web Speech API) est géré directement par l'interface.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { paths } from './config.js';

const IS_WIN = process.platform === 'win32';

export function voiceEngines(cfg) {
  return { openai: !!cfg.OPENAI_API_KEY, windows: IS_WIN };
}

function pickEngine(cfg) {
  const want = cfg.VOICE_ENGINE || 'auto';
  const can = voiceEngines(cfg);
  if (want === 'openai') {
    if (!can.openai) throw new Error('La transcription OpenAI demande une clé API OpenAI (Réglages → Connexions → ChatGPT → Clé API).');
    return 'openai';
  }
  if (want === 'windows') {
    if (!can.windows) throw new Error('La reconnaissance vocale Windows n’est disponible que sur Windows.');
    return 'windows';
  }
  if (can.openai) return 'openai';
  if (can.windows) return 'windows';
  throw new Error('Aucun moteur de transcription : ajoute une clé API OpenAI, ou utilise Relais sous Windows.');
}

async function openaiTranscribe(cfg, wav, lang, signal) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'voix.wav');
  form.append('model', cfg.VOICE_OPENAI_MODEL || 'gpt-4o-mini-transcribe');
  if (lang) form.append('language', lang.slice(0, 2));
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.OPENAI_API_KEY}` },
    body: form,
    signal,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Transcription OpenAI (${res.status}) : ${j?.error?.message || res.statusText}`);
  return String(j.text || '').trim();
}

function windowsTranscribe(file, lang) {
  // System.Speech : reconnaissance « dictée » hors ligne, avec le moteur de la langue demandée s'il est installé.
  const script = `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    Add-Type -AssemblyName System.Speech
    $want = '${String(lang || 'fr-FR').replace(/[^a-zA-Z-]/g, '')}'
    $all = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
    if ($all.Count -eq 0) { [Console]::Error.Write('NO_RECOGNIZER'); exit 2 }
    $info = $all | Where-Object { $_.Culture.Name -eq $want } | Select-Object -First 1
    if (-not $info) { $info = $all | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq $want.Substring(0,2) } | Select-Object -First 1 }
    if (-not $info) { $info = $all[0] }
    $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
    $r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    $r.SetInputToWaveFile($env:RELAIS_WAV)
    $dur = ((Get-Item $env:RELAIS_WAV).Length - 44) / 32000.0
    $out = New-Object System.Collections.Generic.List[string]
    $last = -1
    # Recognize() rend la main à chaque phrase (ou silence) : on avance jusqu'à la fin de l'enregistrement.
    for ($i = 0; $i -lt 300; $i++) {
      $res = $r.Recognize()
      if ($res -ne $null -and $res.Text) { $out.Add($res.Text) }
      $pos = $r.AudioPosition.TotalSeconds
      if ($pos -ge ($dur - 0.2) -or $pos -le $last) { break }
      $last = $pos
    }
    $r.Dispose()
    [Console]::Out.Write(($out -join ' '))`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      env: { ...process.env, RELAIS_WAV: file },
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill(), 120000);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`Reconnaissance Windows indisponible : ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (/NO_RECOGNIZER/.test(err)) return reject(new Error('Aucune langue de reconnaissance vocale installée dans Windows (Paramètres → Heure et langue → Voix).'));
      if (code !== 0 && !out.trim()) return reject(new Error(`Reconnaissance Windows : ${err.trim().split('\n').pop() || `code ${code}`}`));
      resolve(out.trim());
    });
  });
}

/** @param {Buffer} wav */
export async function transcribe(cfg, wav, { lang, signal } = {}) {
  if (!wav?.length || wav.length < 2000) throw new Error('Enregistrement trop court.');
  const engine = pickEngine(cfg);
  const language = lang || cfg.VOICE_LANG || 'fr-FR';
  if (engine === 'openai') return { text: await openaiTranscribe(cfg, wav, language, signal), engine };
  const file = path.join(paths.tmp, `voix-${crypto.randomBytes(6).toString('hex')}.wav`);
  fs.writeFileSync(file, wav);
  try {
    return { text: await windowsTranscribe(file, language), engine };
  } finally {
    fs.rm(file, () => {});
  }
}
