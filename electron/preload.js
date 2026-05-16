'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const TARX_VOICE_UX_STATES = {
  off: 'Voice off',
  permissionNeeded: 'Allow microphone access to talk to TARX.',
  listening: 'TARX is listening',
  workingLocally: 'TARX is working locally',
  responding: 'TARX is responding',
  unavailable: 'Voice unavailable, try fallback',
};

function createTarxVoiceBridge() {
  let stream = null;
  let recorder = null;
  let chunks = [];
  let audioContext = null;
  let analyser = null;
  let levelTimer = null;
  let activeSource = null;
  const statusHandlers = new Set();
  const transcriptHandlers = new Set();
  const errorHandlers = new Set();

  function emit(handlers, payload) {
    for (const handler of handlers) {
      try { handler(payload); } catch {}
    }
  }

  function voiceErrorPayload(error, fallback = 'voice_capture_failed') {
    return {
      name: error?.name || null,
      message: error?.message || fallback,
      code: error?.code || null,
      constraint: error?.constraint || null,
      stack: error?.stack ? String(error.stack).slice(0, 600) : null,
    };
  }

  function stopLevelMeter() {
    if (levelTimer) clearInterval(levelTimer);
    levelTimer = null;
    if (audioContext) audioContext.close().catch(() => {});
    audioContext = null;
    analyser = null;
  }

  function closeStream() {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  function blobToArrayBuffer(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('audio_read_failed'));
      reader.readAsArrayBuffer(blob);
    });
  }

  async function transcribeBlob(blob) {
    const response = await fetch('/api/voice/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: await blobToArrayBuffer(blob),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.text) throw new Error(data?.error || `transcription_failed_${response.status}`);
    return data;
  }

  function startLevelMeter(mediaStream) {
    try {
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(mediaStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      levelTimer = setInterval(() => {
        if (!analyser) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const inputLevel = Math.sqrt(sum / data.length);
        emit(statusHandlers, { state: 'listening', listening: true, inputLevel });
      }, 80);
    } catch (error) {
      emit(errorHandlers, { message: error?.message || 'audio_meter_failed' });
    }
  }

  async function stopListening() {
    if (activeSource === 'electron_native') {
      const result = await ipcRenderer.invoke('tarx:voice-native-capture-stop');
      activeSource = null;
      emit(statusHandlers, { state: 'idle', listening: false, inputLevel: 0, source: 'electron_native' });
      return result;
    }
    if (!recorder || recorder.state === 'inactive') {
      stopLevelMeter();
      closeStream();
      activeSource = null;
      emit(statusHandlers, { state: 'idle', listening: false, inputLevel: 0 });
      return { state: 'idle' };
    }
    return new Promise((resolve) => {
      recorder.onstop = async () => {
        stopLevelMeter();
        closeStream();
        activeSource = null;
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const durationMs = 0;
        chunks = [];
        emit(statusHandlers, { state: 'thinking', listening: false, inputLevel: 0 });
        ipcRenderer.invoke('tarx:voice-capture-event', {
          schema: 'tarx-voice-capture-event.v1',
          source: 'browser_fallback',
          duration_ms: durationMs,
          privacy: { local_only: true, supercomputer_used: false },
        }).catch(() => {});
        try {
          const result = await transcribeBlob(blob);
          emit(transcriptHandlers, { text: result.text, final: true });
          emit(statusHandlers, { state: 'idle', listening: false, inputLevel: 0 });
          resolve({ state: 'idle' });
        } catch (error) {
          const message = error?.message || 'transcription_failed';
          emit(errorHandlers, { message });
          emit(statusHandlers, { state: 'error', error: message });
          resolve({ state: 'error', error: message });
        }
      };
      recorder.stop();
    });
  }

  return {
    states: TARX_VOICE_UX_STATES,
    getRuntimeCapabilities: async () => ipcRenderer.invoke('tarx:voice-runtime-capabilities'),
    startNativeCapture: async (payload) => ipcRenderer.invoke('tarx:voice-native-capture-start', payload || {}),
    stopNativeCapture: async () => ipcRenderer.invoke('tarx:voice-native-capture-stop'),
    emitCaptureEvent: async (payload) => ipcRenderer.invoke('tarx:voice-capture-event', payload || {}),
    permissionStatus: async () => ipcRenderer.invoke('tarx:voice-permission-status'),
    requestPermission: async () => ipcRenderer.invoke('tarx:voice-request-permission'),
    openInputSettings: async () => ipcRenderer.invoke('tarx:voice-open-input-settings'),
    openMicrophonePrivacySettings: async () => ipcRenderer.invoke('tarx:voice-open-microphone-privacy-settings'),
    listInputDevices: async () => {
      if (!navigator.mediaDevices?.enumerateDevices) return [];
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((device) => device.kind === 'audioinput').map((device) => ({
        id: device.deviceId,
        label: device.label,
        groupId: device.groupId,
        kind: device.kind,
      }));
    },
    startListening: async () => {
      const capabilities = await ipcRenderer.invoke('tarx:voice-runtime-capabilities').catch(() => null);
      if (capabilities?.featureFlags?.TARX_VOICE_NATIVE_CAPTURE) {
        const result = await ipcRenderer.invoke('tarx:voice-native-capture-start', { source: 'electron_native' });
        if (result?.ok) activeSource = 'electron_native';
        return result;
      }
      if (!capabilities?.featureFlags?.TARX_VOICE_BROWSER_FALLBACK) {
        const detail = { name: 'NotSupportedError', message: 'browser_fallback_disabled' };
        emit(errorHandlers, detail);
        emit(statusHandlers, { state: 'error', error: detail.message, errorDetail: detail });
        return { state: 'error', error: detail.message, errorDetail: detail, source: 'browser_fallback' };
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        const detail = { name: 'NotSupportedError', message: 'electron_media_devices_unavailable' };
        emit(errorHandlers, detail);
        emit(statusHandlers, { state: 'error', error: detail.message, errorDetail: detail });
        return { state: 'error', error: detail.message, errorDetail: detail, source: 'browser_fallback' };
      }
      if (recorder && recorder.state !== 'inactive') return { state: 'listening', listening: true, source: 'browser_fallback' };
      const permission = await ipcRenderer.invoke('tarx:voice-request-permission').catch((error) => ({ status: 'unknown', error: error?.message || String(error) }));
      if (permission?.status && permission.status !== 'granted' && permission.granted !== true) {
        const detail = { name: 'NotAllowedError', message: `microphone_permission_${permission.status}`, permission };
        emit(errorHandlers, detail);
        emit(statusHandlers, { state: 'error', error: detail.message, errorDetail: detail });
        return { state: 'error', error: detail.message, errorDetail: detail, source: 'browser_fallback' };
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        const detail = voiceErrorPayload(error, 'microphone_stream_failed');
        emit(errorHandlers, detail);
        emit(statusHandlers, { state: 'error', error: detail.message, errorDetail: detail });
        return { state: 'error', error: detail.message, errorDetail: detail, source: 'browser_fallback' };
      }
      chunks = [];
      const mimeType = MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      try {
        recorder = new MediaRecorder(stream, { mimeType });
      } catch (error) {
        const detail = voiceErrorPayload(error, 'media_recorder_create_failed');
        closeStream();
        emit(errorHandlers, detail);
        emit(statusHandlers, { state: 'error', error: detail.message, errorDetail: detail });
        return { state: 'error', error: detail.message, errorDetail: detail, source: 'browser_fallback' };
      }
      recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
      recorder.onerror = (event) => {
        const message = event?.error?.message || 'media_recorder_failed';
        emit(errorHandlers, { message });
        emit(statusHandlers, { state: 'error', error: message });
      };
      recorder.start(250);
      activeSource = 'browser_fallback';
      startLevelMeter(stream);
      emit(statusHandlers, { state: 'listening', listening: true, inputLevel: 0 });
      return { state: 'listening', listening: true, source: 'browser_fallback' };
    },
    stopListening,
    stopSpeaking: async () => ({ state: 'idle', speaking: false }),
    setMuted: async (muted) => {
      if (stream) stream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
      emit(statusHandlers, { state: muted ? 'idle' : 'listening', muted });
      return { state: muted ? 'idle' : 'listening', muted };
    },
    onStatus: (handler) => { statusHandlers.add(handler); return () => statusHandlers.delete(handler); },
    onTranscript: (handler) => { transcriptHandlers.add(handler); return () => transcriptHandlers.delete(handler); },
    onError: (handler) => { errorHandlers.add(handler); return () => errorHandlers.delete(handler); },
  };
}

const tarxVoiceBridge = createTarxVoiceBridge();
contextBridge.exposeInMainWorld('tarxVoiceNative', tarxVoiceBridge);
const tarxVisionBridge = {
  observe: (payload) => ipcRenderer.invoke('tarx:vision-observe', payload || {}),
};
const tarxActionBridge = {
  propose: (payload) => ipcRenderer.invoke('tarx:action-propose', payload || {}),
};
const tarxLocalOperatorBridge = {
  getControlPlane: () => ipcRenderer.invoke('tarx:local-operator-control-plane'),
  runCheck: () => ipcRenderer.invoke('tarx:local-operator-control-plane'),
};

// Expose a minimal TARX bridge to the renderer (tarx.com web app)
contextBridge.exposeInMainWorld('__TARX_DESKTOP__', {
  getStatus: () => ipcRenderer.invoke('tarx:status'),
  openComposer: () => ipcRenderer.invoke('open-composer'),
  getVersion: () => ipcRenderer.invoke('tarx:version'),
  getRuntimeStatus: () => ipcRenderer.invoke('tarx:runtime-status'),
  getLocalDataStatus: () => ipcRenderer.invoke('tarx:local-data-status'),
  restartRuntime: () => ipcRenderer.invoke('tarx:restart-runtime'),
  freshAppTest: () => ipcRenderer.invoke('tarx:fresh-app-test'),
  prepareFullWipe: () => ipcRenderer.invoke('tarx:full-wipe-prepare'),
  confirmFullWipe: (payload) => ipcRenderer.invoke('tarx:full-wipe-confirm', payload),
  resetLocalVault: (payload) => ipcRenderer.invoke('tarx:vault-reset', payload),
  voice: tarxVoiceBridge,
  vision: tarxVisionBridge,
  action: tarxActionBridge,
  localOperator: tarxLocalOperatorBridge,
  platform: process.platform,
  arch: process.arch,
  isElectron: true,
  // Update flow
  checkForUpdates: () => ipcRenderer.invoke('tarx:check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('tarx:download-update'),
  onUpdateStatus: (cb) => ipcRenderer.on('tarx:update-status', (_e, info) => cb(info)),
  onUpdateAvailable: (cb) => ipcRenderer.on('tarx:update-available', (_e, info) => cb(info)),
  onUpdateReady: (cb) => ipcRenderer.on('tarx:update-ready', (_e, info) => cb(info)),
  onRuntimeStatus: (cb) => ipcRenderer.on('tarx:runtime-status', (_e, info) => cb(info)),
  relaunchToUpdate: () => ipcRenderer.invoke('tarx:relaunch-to-update'),
  copyText: (value) => ipcRenderer.invoke('tarx:copy-text', value),
});

// Also expose as electronAPI for the title bar button
contextBridge.exposeInMainWorld('electronAPI', {
  openComposer: () => ipcRenderer.invoke('open-composer'),
  voice: tarxVoiceBridge,
  vision: tarxVisionBridge,
  action: tarxActionBridge,
  localOperator: tarxLocalOperatorBridge,
});
