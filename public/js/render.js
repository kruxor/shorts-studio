import { ArrayBufferTarget, Muxer } from '../vendor/mp4-muxer.mjs';

let mp4BoxPromise;
const MAX_DIMENSION = 16_384;

async function loadMp4Box() {
  if (globalThis.MP4Box?.createFile) return globalThis.MP4Box;
  if (!mp4BoxPromise) {
    mp4BoxPromise = new Promise((resolve, reject) => {
      if (typeof document === 'undefined') {
        reject(new Error('MP4 parsing requires a browser document.'));
        return;
      }
      const script = document.createElement('script');
      script.src = new URL('../vendor/mp4box.all.js', import.meta.url).href;
      script.onload = () => globalThis.MP4Box?.createFile
        ? resolve(globalThis.MP4Box)
        : reject(new Error('The local mp4box.js file loaded but did not expose MP4Box.createFile.'));
      script.onerror = () => reject(new Error('Could not load local MP4Box parser at public/vendor/mp4box.all.js.'));
      document.head.append(script);
    }).catch((error) => {
      mp4BoxPromise = null;
      throw error;
    });
  }
  return mp4BoxPromise;
}

function validateFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new TypeError('Choose a readable MP4 video file.');
}

function toPositiveInteger(value, name, max = MAX_DIMENSION) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new RangeError(`${name} must be a finite positive number.`);
  return Math.max(1, Math.min(max, Math.round(number)));
}

function trackDuration(track) {
  const scale = Number(track?.timescale);
  const duration = Number(track?.duration);
  return scale > 0 && duration > 0 ? duration / scale : 0;
}

async function parseMp4(file, { extractSamples = false } = {}) {
  validateFile(file);
  const MP4Box = await loadMp4Box();
  let bytes;
  try {
    bytes = await file.arrayBuffer();
  } catch (error) {
    throw new Error(`Could not read the selected video file. ${error?.message || ''}`.trim());
  }
  if (!bytes.byteLength) throw new Error('The selected video file is empty.');
  bytes.fileStart = 0;

  return new Promise((resolve, reject) => {
    const mp4 = MP4Box.createFile();
    let complete = false;
    const timeout = setTimeout(() => fail(new Error('MP4 parsing timed out. Use a valid, browser-supported MP4 file.')), 30_000);
    function finish(callback, value) {
      if (complete) return;
      complete = true;
      clearTimeout(timeout);
      callback(value);
    }
    function fail(error) { finish(reject, error); }

    mp4.onError = (error) => fail(new Error(`Could not parse this MP4 file: ${String(error)}`));
    mp4.onReady = (info) => {
      try {
        const videoTrack = info.videoTracks?.[0];
        if (!videoTrack) throw new Error('This MP4 has no video track.');
        if (!extractSamples) {
          finish(resolve, { info, videoTrack, mp4 });
          return;
        }

        const audioTrack = info.audioTracks?.[0] || null;
        const samples = { video: [], audio: [] };
        mp4.onSamples = (trackId, _user, batch) => {
          const destination = trackId === videoTrack.id ? samples.video : (audioTrack && trackId === audioTrack.id ? samples.audio : null);
          if (!destination) return;
          for (const sample of batch) {
            if (!(sample.data instanceof ArrayBuffer) && !ArrayBuffer.isView(sample.data)) {
              fail(new Error('MP4Box could not extract encoded media samples from this file.'));
              return;
            }
            destination.push(sample);
          }
        };
        mp4.setExtractionOptions(videoTrack.id, 'video', { nbSamples: 100 });
        if (audioTrack) mp4.setExtractionOptions(audioTrack.id, 'audio', { nbSamples: 250 });
        mp4.start();
        mp4.flush();
        if (!samples.video.length) throw new Error('No decodable video samples were found in this MP4.');
        finish(resolve, { info, videoTrack, audioTrack, samples, mp4 });
      } catch (error) {
        fail(error);
      }
    };

    try { mp4.appendBuffer(bytes); } catch (error) { fail(new Error(`Could not parse this MP4 file: ${error?.message || error}`)); }
  });
}

function getAvcDescription(trackObject) {
  const entry = trackObject?.mdia?.minf?.stbl?.stsd?.entries?.[0];
  const avc = entry?.avcC;
  if (!avc || !Array.isArray(avc.SPS) || !Array.isArray(avc.PPS)) {
    throw new Error('This renderer currently requires an H.264/AVC MP4 video track with an avcC configuration.');
  }
  const bytes = [
    avc.configurationVersion ?? 1,
    avc.AVCProfileIndication ?? 0,
    avc.profile_compatibility ?? 0,
    avc.AVCLevelIndication ?? 0,
    0xfc | (avc.lengthSizeMinusOne ?? 3),
    0xe0 | Math.min(31, avc.SPS.length),
  ];
  const appendParameterSets = (sets) => {
    for (const set of sets) {
      const data = set.nalu;
      if (!data || data.byteLength > 65_535) throw new Error('Invalid H.264 parameter set in the video track.');
      bytes.push((data.byteLength >> 8) & 0xff, data.byteLength & 0xff, ...data);
    }
  };
  appendParameterSets(avc.SPS);
  bytes.push(Math.min(255, avc.PPS.length));
  appendParameterSets(avc.PPS);
  if (avc.ext) bytes.push(...avc.ext);
  return new Uint8Array(bytes);
}

function getAacDescription(trackObject) {
  const entry = trackObject?.mdia?.minf?.stbl?.stsd?.entries?.[0];
  const decoderConfig = entry?.esds?.esd?.findDescriptor?.(4);
  const specificInfo = decoderConfig?.findDescriptor?.(5)?.data;
  if (!specificInfo?.byteLength) {
    throw new Error('The input audio track is not AAC with an AudioSpecificConfig; audio cannot be passed through safely.');
  }
  return Uint8Array.from(specificInfo);
}

function getAudioTrackConfig(audioTrack, mp4) {
  if (!audioTrack) return null;
  if (!String(audioTrack.codec || '').startsWith('mp4a.')) {
    throw new Error(`The input audio codec "${audioTrack.codec || 'unknown'}" is not AAC. This renderer preserves AAC audio without re-encoding.`);
  }
  const sourceTrack = mp4.getTrackById(audioTrack.id);
  // Track *info* (from onReady) carries a normalised `audio` object.
  // The trak box from getTrackById() does not: its sample-rate lives on the
  // stsd entry as `samplerate` (16.16 fixed point in some files) and
  // `channel_count`. Prefer the info object, fall back to the stsd entry.
  const entry = sourceTrack?.mdia?.minf?.stbl?.stsd?.entries?.[0];
  const rawSampleRate = Number(audioTrack?.audio?.sample_rate ?? entry?.samplerate);
  // mp4box can report the stsd samplerate as 16.16 fixed point (e.g. 44100<<16).
  const sampleRate = rawSampleRate > 1_000_000 ? rawSampleRate / 65_536 : rawSampleRate;
  const numberOfChannels = Math.max(1, Math.floor(Number(
    audioTrack?.audio?.channel_count ?? entry?.channel_count ?? 0
  )));
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw new Error('The AAC track has an invalid sample rate.');
  return {
    codec: 'aac',
    numberOfChannels,
    sampleRate,
    decoderConfig: {
      codec: audioTrack.codec,
      description: getAacDescription(sourceTrack),
      numberOfChannels,
      sampleRate,
    },
  };
}

function encodedVideoConfig(width, height, fps) {
  const bitrate = Math.min(80_000_000, Math.max(500_000, Math.round(width * height * fps * 0.12)));
  return {
    codec: 'avc1.640028',
    width,
    height,
    bitrate,
    framerate: fps,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'quality',
  };
}

async function supportedVideoEncoderConfig(baseConfig) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoEncoder.isConfigSupported !== 'function') {
    throw new Error('Video encoding requires a browser with WebCodecs VideoEncoder and VideoEncoder.isConfigSupported (current Chrome or Edge desktop).');
  }
  let candidate = await VideoEncoder.isConfigSupported(baseConfig);
  if (candidate.supported) return baseConfig;

  const softwareConfig = { ...baseConfig, hardwareAcceleration: 'prefer-software' };
  candidate = await VideoEncoder.isConfigSupported(softwareConfig);
  if (candidate.supported) return softwareConfig;
  throw new Error('This browser cannot encode H.264 High Profile (avc1.640028) with WebCodecs. Use a current Chrome or Edge build with H.264 encoder support.');
}

function waitForEncoderCapacity(encoder) {
  if (encoder.encodeQueueSize <= 8) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onDequeue = () => {
      encoder.removeEventListener('dequeue', onDequeue);
      resolve();
    };
    encoder.addEventListener('dequeue', onDequeue, { once: true });
    if (encoder.state === 'closed') {
      encoder.removeEventListener('dequeue', onDequeue);
      reject(new Error('The WebCodecs video encoder closed before finishing the render.'));
    }
  });
}

function report(onProgress, stage, progress, detail) {
  const value = Math.max(0, Math.min(1, Number(progress) || 0));
  onProgress?.({ stage, progress: value, phase: stage, value, detail });
}

function addPassthroughAudio(muxer, samples, audioTrack, audioConfig, onProgress) {
  if (!audioConfig || !audioTrack) return;
  const audioScale = Math.max(1, Number(audioTrack.timescale));
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const timestamp = Math.round(Number(sample.cts) / audioScale * 1_000_000);
    if (timestamp < 0) continue;
    const sampleDuration = Math.max(1, Math.round(Number(sample.duration) / audioScale * 1_000_000));
    const data = sample.data instanceof ArrayBuffer
      ? new Uint8Array(sample.data)
      : new Uint8Array(sample.data.buffer, sample.data.byteOffset, sample.data.byteLength);
    muxer.addAudioChunkRaw(data, 'key', timestamp, sampleDuration, { decoderConfig: audioConfig.decoderConfig });
    if (index % 100 === 0 || index === samples.length - 1) {
      report(onProgress, 'audio-passthrough', (index + 1) / Math.max(1, samples.length));
    }
  }
}

export async function probeVideo(file) {
  const { info, videoTrack } = await parseMp4(file);
  const duration = trackDuration(videoTrack) || (Number(info.duration) > 0 && Number(info.timescale) > 0 ? Number(info.duration) / Number(info.timescale) : 0);
  const width = Number(videoTrack.video?.width || videoTrack.track_width);
  const height = Number(videoTrack.video?.height || videoTrack.track_height);
  if (!(width > 0) || !(height > 0)) throw new Error('The MP4 video track reports invalid dimensions.');
  if (!(duration > 0)) throw new Error('The MP4 video track reports an invalid duration.');
  const calculatedFps = Number(videoTrack.nb_samples) > 0 ? Number(videoTrack.nb_samples) / duration : 0;
  return {
    width: toPositiveInteger(width, 'Video width'),
    height: toPositiveInteger(height, 'Video height'),
    duration,
    fps: Number.isFinite(calculatedFps) && calculatedFps > 0 ? calculatedFps : 30,
  };
}

export async function renderVideo({ file, drawFrame, width, height, fps = 30, onProgress }) {
  validateFile(file);
  if (typeof drawFrame !== 'function') throw new TypeError('renderVideo needs a drawFrame(ctx, timeSeconds) function.');
  if (typeof VideoDecoder === 'undefined' || typeof VideoDecoder.isConfigSupported !== 'function') {
    throw new Error('Video decoding requires a browser with WebCodecs VideoDecoder and VideoDecoder.isConfigSupported (current Chrome or Edge desktop).');
  }
  if (typeof VideoFrame === 'undefined') throw new Error('Video rendering requires the WebCodecs VideoFrame API in a current Chrome or Edge desktop browser.');

  const outputWidth = toPositiveInteger(width, 'Output width');
  const outputHeight = toPositiveInteger(height, 'Output height');
  const outputFps = Math.max(1, Math.min(120, Number.isFinite(Number(fps)) ? Number(fps) : 30));
  const baseEncoderConfig = encodedVideoConfig(outputWidth, outputHeight, outputFps);
  const encoderConfig = await supportedVideoEncoderConfig(baseEncoderConfig);

  report(onProgress, 'demux', 0);
  const demuxed = await parseMp4(file, { extractSamples: true });
  const { info, videoTrack, audioTrack, samples } = demuxed;
  if (!String(videoTrack.codec || '').startsWith('avc1') && !String(videoTrack.codec || '').startsWith('avc3')) {
    throw new Error(`The input video codec "${videoTrack.codec || 'unknown'}" is not H.264/AVC, which is required by this renderer.`);
  }

  // parseMp4 retains the parser so codec configuration and AAC sample metadata remain available.
  const sourceFile = demuxed.mp4;
  if (!sourceFile) throw new Error('Internal MP4 parser state was unavailable for codec configuration.');
  const sourceVideo = sourceFile.getTrackById(videoTrack.id);
  const description = getAvcDescription(sourceVideo);
  const audioConfig = getAudioTrackConfig(audioTrack, sourceFile);
  const duration = trackDuration(videoTrack) || (Number(info.duration) / Math.max(1, Number(info.timescale)));
  const firstVideoTime = samples.video.length ? Number(samples.video[0].cts) / Math.max(1, Number(videoTrack.timescale)) : 0;
  const firstAudioTime = samples.audio.length && audioTrack ? Number(samples.audio[0].cts) / Math.max(1, Number(audioTrack.timescale)) : firstVideoTime;
  const timelineOrigin = Math.min(firstVideoTime, firstAudioTime);

  const sourceWidth = toPositiveInteger(videoTrack.video?.width || videoTrack.track_width, 'Input video width');
  const sourceHeight = toPositiveInteger(videoTrack.video?.height || videoTrack.track_height, 'Input video height');
  const videoConfig = {
    codec: videoTrack.codec,
    codedWidth: sourceWidth,
    codedHeight: sourceHeight,
    description,
  };
  const decoderSupport = await VideoDecoder.isConfigSupported(videoConfig);
  if (!decoderSupport.supported) {
    throw new Error(`This browser cannot decode input video codec "${videoTrack.codec}" with WebCodecs VideoDecoder. Use a supported H.264 MP4 in current Chrome or Edge.`);
  }

  const target = new ArrayBufferTarget();
  const muxerOptions = {
    target,
    video: { codec: 'avc', width: outputWidth, height: outputHeight, frameRate: outputFps },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'cross-track-offset',
  };
  if (audioConfig) muxerOptions.audio = { codec: 'aac', numberOfChannels: audioConfig.numberOfChannels, sampleRate: audioConfig.sampleRate };
  const muxer = new Muxer(muxerOptions);
  const audioFirst = Boolean(audioConfig && firstAudioTime < firstVideoTime);
  if (audioFirst) addPassthroughAudio(muxer, samples.audio, audioTrack, audioConfig, onProgress);
  report(onProgress, 'demux', 1);

  const canvas = document.createElement('canvas');
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('This browser could not create a 2D canvas for video rendering.');
  const MAX_PENDING = 6;
  // A 24fps source yields fewer output frames than duration*fps, so cap the
  // expectation at the number of frames actually available.
  const expectedFrames = Math.max(1, Math.min(
    Math.ceil((duration || 0) * outputFps),
    samples.video.length || Number.MAX_SAFE_INTEGER,
  ));
  const pending = [];
  let inFlight = 0;
  let decoderError = null;
  let encoderError = null;
  let notifyFrame;
  let resolveDecoderFailure;
  let resolveEncoderFailure;
  let frameAvailable = new Promise((resolve) => { notifyFrame = resolve; });
  const decoderFailure = new Promise((resolve) => { resolveDecoderFailure = resolve; });
  const encoderFailure = new Promise((resolve) => { resolveEncoderFailure = resolve; });
  const signalFrame = () => {
    notifyFrame?.();
    notifyFrame = null;
  };
  const decoder = new VideoDecoder({
    output: (frame) => {
      inFlight = Math.max(0, inFlight - 1);
      if (pending.length >= MAX_PENDING) {
        frame.close();
        decoderError = new Error('The WebCodecs decoder exceeded its bounded frame queue.');
        resolveDecoderFailure();
        signalFrame();
        return;
      }
      pending.push(frame);
      signalFrame();
      frameAvailable = new Promise((resolve) => { notifyFrame = resolve; });
    },
    error: (error) => {
      decoderError = error;
      resolveDecoderFailure();
      signalFrame();
    },
  });
  let encoder = null;
  const checkDecoderError = () => {
    if (decoderError) throw new Error(`WebCodecs could not decode this video: ${decoderError.message || decoderError}`);
  };
  const checkEncoderError = () => {
    if (encoderError) throw new Error(`WebCodecs could not encode this video: ${encoderError.message || encoderError}`);
  };

  try {
    decoder.configure(videoConfig);
    let encodedFrames = 0;
    let lastSlot = -1;
    let nextSample = 0;
    let lastProgressAt = performance.now();
    const encodeStartedAt = lastProgressAt;
    const frameDuration = Math.max(1, Math.round(1_000_000 / outputFps));
    const makeEncoder = () => new VideoEncoder({
      output: (chunk, metadata) => {
        if (encoderError) return;
        try { muxer.addVideoChunk(chunk, metadata); } catch (error) {
          encoderError = error;
          resolveEncoderFailure();
        }
      },
      error: (error) => {
        encoderError = error;
        resolveEncoderFailure();
      },
    });
    encoder = makeEncoder();
    try {
      encoder.configure(encoderConfig);
    } catch (hardwareError) {
      if (encoderConfig.hardwareAcceleration !== 'prefer-hardware') {
        throw new Error(`Could not configure the WebCodecs H.264 encoder: ${hardwareError.message || hardwareError}`);
      }
      encoder.close();
      const softwareConfig = { ...baseEncoderConfig, hardwareAcceleration: 'prefer-software' };
      const softwareSupport = await VideoEncoder.isConfigSupported(softwareConfig);
      checkDecoderError();
      checkEncoderError();
      if (!softwareSupport.supported) {
        throw new Error(`Hardware H.264 encoding failed and this browser has no supported software fallback. ${hardwareError.message || hardwareError}`);
      }
      encoder = makeEncoder();
      try {
        encoder.configure(softwareConfig);
      } catch (softwareError) {
        throw new Error(`Both hardware and software H.264 encoder setup failed. Hardware: ${hardwareError.message || hardwareError}; software: ${softwareError.message || softwareError}`);
      }
    }

    report(onProgress, 'encode', 0);
    const consumeFrame = async (sourceFrame) => {
      try {
        checkDecoderError();
        checkEncoderError();
        const sourceTimeSeconds = sourceFrame.timestamp / 1_000_000;
        const timeSeconds = Math.max(0, Math.min(duration || Infinity, sourceTimeSeconds - timelineOrigin));
        // Quantise onto the output frame grid and emit at most one frame per slot.
        // Deriving the slot from the source timestamp (instead of advancing a
        // counter) keeps the output duration equal to the source duration for any
        // input rate: a 24fps source no longer gets sped up to 30fps, and a 60fps
        // source still collapses to 30 with no drift.
        const slot = Math.round(timeSeconds * outputFps);
        if (slot <= lastSlot) return;
        lastSlot = slot;

        context.clearRect(0, 0, outputWidth, outputHeight);
        context.drawImage(sourceFrame, 0, 0, outputWidth, outputHeight);
        drawFrame(context, timeSeconds);
        const timestamp = Math.round(slot / outputFps * 1_000_000);
        const outputFrame = new VideoFrame(canvas, { timestamp, duration: frameDuration });
        try {
          await Promise.race([waitForEncoderCapacity(encoder), encoderFailure]);
          checkDecoderError();
          checkEncoderError();
          encoder.encode(outputFrame, {
            keyFrame: encodedFrames === 0 || encodedFrames % Math.max(1, Math.round(outputFps * 2)) === 0,
          });
          encodedFrames += 1;
          const now = performance.now();
          if (encodedFrames % 10 === 0 || now - lastProgressAt >= 400) {
            const elapsedMs = Math.max(1, now - encodeStartedAt);
            const elapsedSeconds = elapsedMs / 1000;
            const rate = encodedFrames / elapsedSeconds;
            const etaMs = rate > 0 ? Math.max(0, ((expectedFrames - encodedFrames) / rate) * 1000) : 0;
            report(onProgress, 'encode', encodedFrames / expectedFrames, {
              framesDone: encodedFrames,
              framesTotal: expectedFrames,
              elapsedMs,
              fps: rate,
              etaMs,
            });
            lastProgressAt = now;
          }
        } finally {
          outputFrame.close();
        }
      } finally {
        sourceFrame.close();
      }
    };

    const totalSamples = samples.video.length;
    while (nextSample < totalSamples) {
      checkDecoderError();
      checkEncoderError();
      while (
        nextSample < totalSamples
        && pending.length + inFlight < MAX_PENDING
        && decoder.decodeQueueSize < MAX_PENDING
      ) {
        checkDecoderError();
        checkEncoderError();
        const sample = samples.video[nextSample];
        const timescale = Math.max(1, Number(videoTrack.timescale));
        const timestamp = Math.max(0, Math.round(Number(sample.cts) / timescale * 1_000_000));
        const sampleDuration = Math.max(1, Math.round(Number(sample.duration) / timescale * 1_000_000));
        const data = sample.data instanceof ArrayBuffer
          ? new Uint8Array(sample.data)
          : new Uint8Array(sample.data.buffer, sample.data.byteOffset, sample.data.byteLength);
        decoder.decode(new EncodedVideoChunk({
          type: sample.is_sync ? 'key' : 'delta',
          timestamp,
          duration: sampleDuration,
          data,
        }));
        inFlight += 1;
        nextSample += 1;
      }

      if (pending.length) {
        await consumeFrame(pending.shift());
        checkDecoderError();
        checkEncoderError();
      } else if (nextSample < totalSamples) {
        await Promise.race([frameAvailable, decoderFailure]);
        checkDecoderError();
        checkEncoderError();
      }
    }

    try {
      await decoder.flush();
    } catch (error) {
      if (decoderError) checkDecoderError();
      throw new Error(`WebCodecs could not decode this video: ${error.message || error}`);
    }
    checkDecoderError();
    while (pending.length) {
      checkDecoderError();
      checkEncoderError();
      await consumeFrame(pending.shift());
      checkDecoderError();
      checkEncoderError();
    }
    await Promise.race([encoder.flush(), encoderFailure]);
    checkEncoderError();
    if (encodedFrames === 0) throw new Error('WebCodecs decoded no video frames from this MP4.');
    const finishedAt = performance.now();
    const elapsedMs = Math.max(1, finishedAt - encodeStartedAt);
    const elapsedSeconds = elapsedMs / 1000;
    const rate = encodedFrames / elapsedSeconds;
    report(onProgress, 'encode', encodedFrames / expectedFrames, {
      framesDone: encodedFrames,
      framesTotal: expectedFrames,
      elapsedMs,
      fps: rate,
      etaMs: rate > 0 ? Math.max(0, ((expectedFrames - encodedFrames) / rate) * 1000) : 0,
    });
  } finally {
    if (encoder && encoder.state !== 'closed') encoder.close();
    if (decoder.state !== 'closed') decoder.close();
    for (const frame of pending) {
      try { frame.close(); } catch { /* The frame may already have been closed by the decoder. */ }
    }
    pending.length = 0;
  }

  if (!audioFirst) addPassthroughAudio(muxer, samples.audio, audioTrack, audioConfig, onProgress);
  report(onProgress, 'mux', 0);
  muxer.finalize();
  if (!target.buffer?.byteLength) throw new Error('The MP4 muxer produced an empty output file.');
  report(onProgress, 'mux', 1);
  return new Blob([target.buffer], { type: 'video/mp4' });
}
