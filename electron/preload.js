'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function notifyRendererReady(phase) {
  ipcRenderer.send('tarx:renderer-ready', {
    schema: 'tarx-renderer-ready.v1',
    phase,
    href: window.location.href,
    title: document.title || '',
    ts: new Date().toISOString(),
  });
}

window.addEventListener('DOMContentLoaded', () => notifyRendererReady('domcontentloaded'));
window.addEventListener('load', () => notifyRendererReady('load'));

const TARX_VOICE_UX_STATES = {
  off: 'Voice off',
  permissionNeeded: 'Allow microphone access to talk to TARX.',
  listening: 'TARX is listening',
  workingLocally: 'TARX is working locally',
  responding: 'TARX is responding',
  unavailable: 'Voice unavailable, try fallback',
};

const TARX_MEDIADEVICES_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

function createTarxVoiceBridge() {
  let stream = null;
  let recorder = null;
  let chunks = [];
  let audioContext = null;
  let analyser = null;
  let levelTimer = null;
  let activeSource = null;
  let deviceManagerState = { devices: [], permissionRefreshed: false, lastRefreshAt: null, lastError: null };
  let deviceChangeListenerInstalled = false;
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

  function stopTracks(mediaStream) {
    if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
  }

  function normalizeMediaDevice(device, index = 0) {
    return {
      index,
      id: device.deviceId,
      deviceId: device.deviceId,
      label: device.label || (device.deviceId === 'default' ? 'macOS Default Input' : ''),
      groupId: device.groupId,
      kind: device.kind,
      default: index === 0 || device.deviceId === 'default',
    };
  }

  async function requestMediaDevicePermissionForLabels() {
    if (!navigator.mediaDevices?.getUserMedia) return { ok: false, firstBlocker: 'mediadevices_getusermedia_unavailable' };
    let permissionStream = null;
    try {
      permissionStream = await navigator.mediaDevices.getUserMedia({ audio: TARX_MEDIADEVICES_AUDIO_CONSTRAINTS });
      return { ok: true };
    } catch (error) {
      return { ok: false, firstBlocker: error?.name === 'NotAllowedError' ? 'permission_needed' : 'permission_or_device_unavailable', errorDetail: voiceErrorPayload(error, 'permission_or_device_unavailable') };
    } finally {
      stopTracks(permissionStream);
    }
  }

  async function listMediaDevicesInputs({ requestPermission = false } = {}) {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    if (requestPermission) {
      const permission = await requestMediaDevicePermissionForLabels();
      deviceManagerState.permissionRefreshed = Boolean(permission.ok);
      if (!permission.ok) deviceManagerState.lastError = permission;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === 'audioinput').map(normalizeMediaDevice);
    inputs.sort((a, b) => Number(!a.default) - Number(!b.default));
    deviceManagerState = {
      ...deviceManagerState,
      devices: inputs,
      lastRefreshAt: new Date().toISOString(),
      lastError: inputs.length ? null : deviceManagerState.lastError,
    };
    return inputs;
  }

  function installDeviceChangeListener() {
    if (deviceChangeListenerInstalled || !navigator.mediaDevices?.addEventListener) return;
    deviceChangeListenerInstalled = true;
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      const devices = await listMediaDevicesInputs({ requestPermission: false }).catch(() => []);
      emit(statusHandlers, { state: 'device_changed', devices, listening: false });
    });
  }

  function selectedDeviceFromList(devices, deviceId = 'default') {
    const requested = deviceId || 'default';
    if (requested === 'default') return devices.find((device) => device.default || device.deviceId === 'default') || devices[0] || null;
    return devices.find((device) => device.deviceId === requested || device.id === requested || device.label === requested) || null;
  }

  function mediaRecorderMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    if (MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
    if (MediaRecorder.isTypeSupported?.('audio/ogg;codecs=opus')) return 'audio/ogg;codecs=opus';
    if (MediaRecorder.isTypeSupported?.('audio/webm')) return 'audio/webm';
    return '';
  }

  function mediaConstraintsForDevice(deviceId = 'default') {
    const audio = { ...TARX_MEDIADEVICES_AUDIO_CONSTRAINTS };
    if (deviceId && deviceId !== 'default') audio.deviceId = { exact: deviceId };
    return { audio };
  }

  async function captureManualTurn({ deviceId = 'default', durationMs = 6500 } = {}) {
    const capabilities = await ipcRenderer.invoke('tarx:voice-runtime-capabilities').catch(() => null);
    if (!capabilities?.featureFlags?.TARX_VOICE_MEDIADEVICES_INTERNAL || capabilities?.featureFlags?.TARX_VOICE_CAPTURE_DRIVER !== 'mediadevices') {
      return {
        ok: false,
        state: 'device_lost',
        status: 'voice_mediadevices_product_capture_blocked',
        firstBlocker: 'mediadevices_product_driver_disabled',
        routeTruth: capabilities?.routeTruth || null,
      };
    }
    installDeviceChangeListener();
    const before = await listMediaDevicesInputs({ requestPermission: false }).catch(() => []);
    const after = await listMediaDevicesInputs({ requestPermission: true }).catch(() => before);
    if (!after.length) {
      return ipcRenderer.invoke('tarx:voice-mediadevices-product-capture', {
        ok: false,
        firstBlocker: 'no_input_devices',
        devicesBeforePermission: before,
        devicesAfterPermission: after,
      });
    }
    const selected = selectedDeviceFromList(after, deviceId);
    if (!selected) {
      return ipcRenderer.invoke('tarx:voice-mediadevices-product-capture', {
        ok: false,
        firstBlocker: 'device_lost',
        selectedDevice: { deviceId, label: deviceId },
        devicesBeforePermission: before,
        devicesAfterPermission: after,
      });
    }
    let captureStream = null;
    let recorderInstance = null;
    let meterContext = null;
    let meterTimer = null;
    const captureChunks = [];
    let sampleCount = 0;
    let sumLevel = 0;
    let peakLevel = 0;
    const startedAt = new Date().toISOString();
    try {
      captureStream = await navigator.mediaDevices.getUserMedia(mediaConstraintsForDevice(selected.deviceId));
      const track = captureStream.getAudioTracks()[0] || null;
      const trackSettings = track?.getSettings?.() || {};
      const constraints = mediaConstraintsForDevice(selected.deviceId).audio;
      try {
        meterContext = new AudioContext();
        const source = meterContext.createMediaStreamSource(captureStream);
        const meter = meterContext.createAnalyser();
        meter.fftSize = 512;
        source.connect(meter);
        const data = new Uint8Array(meter.fftSize);
        meterTimer = setInterval(() => {
          meter.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i += 1) {
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          sampleCount += 1;
          sumLevel += rms;
          if (rms > peakLevel) peakLevel = rms;
          emit(statusHandlers, { state: 'listening', listening: true, inputLevel: rms, source: 'electron_mediadevices' });
        }, 80);
      } catch (error) {
        emit(errorHandlers, { message: error?.message || 'audio_meter_failed' });
      }
      const mimeType = mediaRecorderMimeType();
      recorderInstance = mimeType ? new MediaRecorder(captureStream, { mimeType }) : new MediaRecorder(captureStream);
      recorderInstance.ondataavailable = (event) => { if (event.data?.size) captureChunks.push(event.data); };
      const stopped = new Promise((resolve) => { recorderInstance.onstop = () => resolve(); });
      recorderInstance.start(250);
      activeSource = 'electron_mediadevices';
      await new Promise((resolve) => setTimeout(resolve, Math.max(1000, Math.min(Number(durationMs) || 6500, 15000))));
      recorderInstance.stop();
      await stopped;
      const blob = new Blob(captureChunks, { type: recorderInstance.mimeType || mimeType || 'audio/webm' });
      const arrayBuffer = await blobToArrayBuffer(blob);
      const resolvedSelected = after.find((device) => device.deviceId === trackSettings.deviceId || device.id === trackSettings.deviceId) || selected;
      return ipcRenderer.invoke('tarx:voice-mediadevices-product-capture', {
        audioBuffer: arrayBuffer,
        mimeType: blob.type,
        durationMs: Number(durationMs) || 6500,
        startedAt,
        selectedDevice: {
          ...resolvedSelected,
          trackSettings,
          constraints,
        },
        devicesBeforePermission: before,
        devicesAfterPermission: after,
        trackSettings,
        constraints,
        levels: {
          sampleCount,
          rmsApprox: sampleCount ? sumLevel / sampleCount : 0,
          peakApprox: peakLevel,
          nonSilentLikely: (sampleCount ? sumLevel / sampleCount : 0) > 0.003 || peakLevel > 0.03,
        },
      });
    } catch (error) {
      const detail = voiceErrorPayload(error, 'mediadevices_capture_failed');
      return ipcRenderer.invoke('tarx:voice-mediadevices-product-capture', {
        ok: false,
        firstBlocker: detail.name === 'NotAllowedError' ? 'permission_needed' : 'device_lost',
        errorDetail: detail,
        selectedDevice: selected,
        devicesBeforePermission: before,
        devicesAfterPermission: after,
      });
    } finally {
      if (meterTimer) clearInterval(meterTimer);
      if (meterContext) meterContext.close().catch(() => {});
      if (recorderInstance && recorderInstance.state !== 'inactive') {
        try { recorderInstance.stop(); } catch {}
      }
      stopTracks(captureStream);
      activeSource = null;
      emit(statusHandlers, { state: 'idle', listening: false, inputLevel: 0, source: 'electron_mediadevices' });
    }
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
    getPrimeEvidence: async () => ipcRenderer.invoke('tarx:voice-prime-evidence'),
    testMicrophone: async (payload = {}) => {
      const capabilities = await ipcRenderer.invoke('tarx:voice-runtime-capabilities').catch(() => null);
      if (capabilities?.featureFlags?.TARX_VOICE_CAPTURE_DRIVER === 'mediadevices' && capabilities?.featureFlags?.TARX_VOICE_MEDIADEVICES_INTERNAL) {
        return captureManualTurn(payload);
      }
      return ipcRenderer.invoke('tarx:voice-test-microphone', payload || {});
    },
    captureManualTurn,
    askManualInternal: async (payload = {}) => {
      const capabilities = await ipcRenderer.invoke('tarx:voice-runtime-capabilities').catch(() => null);
      if (capabilities?.featureFlags?.TARX_VOICE_CAPTURE_DRIVER === 'mediadevices' && capabilities?.featureFlags?.TARX_VOICE_MEDIADEVICES_INTERNAL) {
        const mediaDevicesResult = await captureManualTurn(payload);
        return ipcRenderer.invoke('tarx:voice-manual-internal-ask', { ...payload, mediaDevicesResult });
      }
      return ipcRenderer.invoke('tarx:voice-manual-internal-ask', payload || {});
    },
    runPipecatSpike: async () => ipcRenderer.invoke('tarx:voice-pipecat-spike-run'),
    startNativeCapture: async (payload) => ipcRenderer.invoke('tarx:voice-native-capture-start', payload || {}),
    stopNativeCapture: async () => ipcRenderer.invoke('tarx:voice-native-capture-stop'),
    emitCaptureEvent: async (payload) => ipcRenderer.invoke('tarx:voice-capture-event', payload || {}),
    permissionStatus: async () => ipcRenderer.invoke('tarx:voice-permission-status'),
    requestPermission: async () => ipcRenderer.invoke('tarx:voice-request-permission'),
    openInputSettings: async () => ipcRenderer.invoke('tarx:voice-open-input-settings'),
    openBluetoothSettings: async () => ipcRenderer.invoke('tarx:voice-open-bluetooth-settings'),
    openMicrophonePrivacySettings: async () => ipcRenderer.invoke('tarx:voice-open-microphone-privacy-settings'),
    refreshInputDevices: async (options = {}) => listMediaDevicesInputs({ ...options, requestPermission: true }),
    listInputDevices: async (options = {}) => {
      installDeviceChangeListener();
      return listMediaDevicesInputs(options);
    },
    runMediaDevicesSpike: async ({ durationMs = 1800, deviceId = '' } = {}) => {
      const capabilities = await ipcRenderer.invoke('tarx:voice-runtime-capabilities').catch(() => null);
      if (!capabilities?.featureFlags?.TARX_VOICE_MEDIADEVICES_INTERNAL) {
        return ipcRenderer.invoke('tarx:voice-mediadevices-spike-evidence', {
          ok: false,
          firstBlocker: 'TARX_VOICE_MEDIADEVICES_INTERNAL_disabled',
        });
      }
      if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices?.enumerateDevices) {
        return ipcRenderer.invoke('tarx:voice-mediadevices-spike-evidence', {
          ok: false,
          firstBlocker: 'mediadevices_unavailable',
        });
      }
      let before = [];
      try { before = await listMediaDevicesInputs(); } catch {}
      let spikeStream = null;
      let spikeContext = null;
      let spikeRecorder = null;
      let spikeChunks = [];
      let sampleCount = 0;
      let sumLevel = 0;
      let peakLevel = 0;
      try {
        const audio = deviceId ? { ...TARX_MEDIADEVICES_AUDIO_CONSTRAINTS, deviceId: { exact: deviceId } } : TARX_MEDIADEVICES_AUDIO_CONSTRAINTS;
        spikeStream = await navigator.mediaDevices.getUserMedia({ audio });
        const after = await listMediaDevicesInputs().catch(() => before);
        const track = spikeStream.getAudioTracks()[0] || null;
        const settings = track?.getSettings?.() || {};
        spikeContext = new AudioContext();
        const source = spikeContext.createMediaStreamSource(spikeStream);
        const spikeAnalyser = spikeContext.createAnalyser();
        spikeAnalyser.fftSize = 512;
        source.connect(spikeAnalyser);
        const data = new Uint8Array(spikeAnalyser.fftSize);
        const levelTimer = setInterval(() => {
          spikeAnalyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i += 1) {
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          sumLevel += rms;
          sampleCount += 1;
          if (rms > peakLevel) peakLevel = rms;
        }, 80);
        const mimeType = MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
        spikeRecorder = new MediaRecorder(spikeStream, { mimeType });
        spikeRecorder.ondataavailable = (event) => { if (event.data?.size) spikeChunks.push(event.data); };
        const stopped = new Promise((resolve) => {
          spikeRecorder.onstop = () => resolve();
        });
        spikeRecorder.start(250);
        await new Promise((resolve) => setTimeout(resolve, Math.max(500, Math.min(Number(durationMs) || 1800, 4000))));
        spikeRecorder.stop();
        await stopped;
        clearInterval(levelTimer);
        const blob = new Blob(spikeChunks, { type: spikeRecorder.mimeType || mimeType });
        const selected = after.find((device) => device.id === settings.deviceId) || after[0] || null;
        const avgLevel = sampleCount ? sumLevel / sampleCount : 0;
        return ipcRenderer.invoke('tarx:voice-mediadevices-spike-evidence', {
          ok: blob.size > 0,
          firstBlocker: blob.size > 0 ? null : 'empty_audio_blob',
          devicesBeforePermission: before,
          devicesAfterPermission: after,
          selectedDevice: selected,
          trackSettings: settings,
          capture: {
            durationMs: Number(durationMs) || 1800,
            mimeType: blob.type,
            bytes: blob.size,
            rmsApprox: avgLevel,
            peakApprox: peakLevel,
            nonSilentLikely: avgLevel > 0.003 || peakLevel > 0.03,
            rawAudioLogged: false,
            audioBlobPersisted: false,
          },
        });
      } catch (error) {
        const detail = voiceErrorPayload(error, 'mediadevices_spike_failed');
        return ipcRenderer.invoke('tarx:voice-mediadevices-spike-evidence', {
          ok: false,
          firstBlocker: detail.message,
          error: detail.message,
          errorDetail: detail,
          devicesBeforePermission: before,
        });
      } finally {
        if (spikeRecorder && spikeRecorder.state !== 'inactive') {
          try { spikeRecorder.stop(); } catch {}
        }
        if (spikeContext) spikeContext.close().catch(() => {});
        if (spikeStream) spikeStream.getTracks().forEach((track) => track.stop());
      }
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
const tarxPointerBridge = {
  context: (payload) => ipcRenderer.invoke('tarx:pointer-context', payload || {}),
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
  pointer: tarxPointerBridge,
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
  refreshTarx: () => ipcRenderer.invoke('tarx:refresh', { trigger: 'renderer-api' }),
  safeRecovery: {
    reload: () => ipcRenderer.invoke('tarx:safe-shell-reload'),
    restart: () => ipcRenderer.invoke('tarx:safe-shell-restart'),
    openSafeMode: () => ipcRenderer.invoke('tarx:safe-shell-open-safe-mode'),
    copyDiagnostics: () => ipcRenderer.invoke('tarx:safe-shell-copy-diagnostics'),
    openLogs: () => ipcRenderer.invoke('tarx:safe-shell-open-logs'),
    quit: () => ipcRenderer.invoke('tarx:safe-shell-quit'),
    diagnostics: () => ipcRenderer.invoke('tarx:safe-shell-diagnostics'),
  },
});

// Also expose as electronAPI for the title bar button
contextBridge.exposeInMainWorld('electronAPI', {
  openComposer: () => ipcRenderer.invoke('open-composer'),
  refreshTarx: () => ipcRenderer.invoke('tarx:refresh', { trigger: 'electron-api' }),
  voice: tarxVoiceBridge,
  vision: tarxVisionBridge,
  pointer: tarxPointerBridge,
  action: tarxActionBridge,
  localOperator: tarxLocalOperatorBridge,
});
