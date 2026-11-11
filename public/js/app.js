import { extractAudio } from './audio.js';
import { transcribeAudio, MODELS } from './transcribe.js';
import { probeVideo, renderVideo } from './render.js';
import { groupWords, activeGroup, spokenWordIndex, flattenGroups } from './captions.js';
import { DEFAULT_STYLE, normalizeStyle, clampStyleValue } from './style.js';
import { validatePreset, serializePresets, parsePresets } from './presets.js';
import { transcriptText, replaceTranscriptText } from './alignment.js';

const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const DB_NAME = 'shorts-studio-presets';
const DB_VERSION = 1;
const STORE_NAME = 'presets';
const STAGES = ['decode', 'transcribe', 'review', 'render'];
const $ = selector => document.querySelector(selector);

const elements = {
  fileInput: $('#fileInput'), dropZone: $('#dropZone'), fileSummary: $('#fileSummary'),
  modelSelect: $('#modelSelect'), startButton: $('#startButton'), stageItems: [...document.querySelectorAll('.stage-item')],
  workflowStatus: $('#workflowStatus'), taskProgress: $('#taskProgress'), progressLabel: $('#progressLabel'),
  progressPercent: $('#progressPercent'), progressBar: $('#progressBar'), errorNotice: $('#errorNotice'),
  infoNotice: $('#infoNotice'), workspace: $('#workspace'), previewStage: $('#previewStage'),
  previewCanvas: $('#previewCanvas'), previewEmpty: $('#previewEmpty'), sourceVideo: $('#sourceVideo'),
  playButton: $('#playButton'), timeSlider: $('#timeSlider'), timeReadout: $('#timeReadout'),
  captionList: $('#captionList'), groupCount: $('#groupCount'), renderButton: $('#renderButton'),
  cancelRender: $('#cancelRender'), downloadLink: $('#downloadLink'), presetName: $('#presetName'),
  savePreset: $('#savePreset'), presetList: $('#presetList'), presetCount: $('#presetCount'),
  exportPresets: $('#exportPresets'), importPresetsButton: $('#importPresetsButton'),
  importPresetsFile: $('#importPresetsFile'), resetStyle: $('#resetStyle'),
};

let selectedFile = null;
let fileUrl = null;
let renderUrl = null;
let videoInfo = null;
let transcript = null;
let groups = [];
let style = normalizeStyle(DEFAULT_STYLE);
let previewScale = 0.1;
let previewRaf = 0;
let lastActiveGroup = -2;
let isScrubbing = false;
let renderInProgress = false;
let cancelRequested = false;
let databasePromise;

function showError(message) {
  elements.errorNotice.textContent = message;
  elements.errorNotice.hidden = false;
  elements.infoNotice.hidden = true;
}
function clearNotices() {
  elements.errorNotice.hidden = true;
  elements.infoNotice.hidden = true;
}
function showInfo(message) {
  elements.infoNotice.textContent = message;
  elements.infoNotice.hidden = false;
  elements.errorNotice.hidden = true;
}
function humanError(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}
function setWorkflowStatus(text) { elements.workflowStatus.textContent = text; }

function setStage(activeName) {
  const activeIndex = STAGES.indexOf(activeName);
  elements.stageItems.forEach((item, index) => {
    item.classList.toggle('is-active', index === activeIndex);
    item.classList.toggle('is-done', activeIndex >= 0 && index < activeIndex);
  });
}
function completeStage(name) {
  const index = STAGES.indexOf(name);
  if (index >= 0) elements.stageItems[index].classList.add('is-done');
  if (index >= 0) elements.stageItems[index].classList.remove('is-active');
}
function setProgress(label, value = 0) {
  const percent = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  elements.taskProgress.hidden = false;
  elements.progressLabel.textContent = label;
  elements.progressPercent.textContent = `${percent}%`;
  elements.progressBar.value = percent;
  elements.progressBar.setAttribute('aria-label', `${label}: ${percent}%`);
}
function progressPercent(value) {
  if (typeof value === 'number') return value <= 1 ? value * 100 : value;
  if (value && typeof value === 'object') {
    if (Number.isFinite(Number(value.percent))) return Number(value.percent);
    if (Number.isFinite(Number(value.progress))) return Number(value.progress) * (Number(value.progress) <= 1 ? 100 : 1);
    if (Number.isFinite(Number(value.loaded)) && Number.isFinite(Number(value.total)) && Number(value.total) > 0) {
      return Number(value.loaded) / Number(value.total) * 100;
    }
  }
  return 0;
}
function formatTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}
function formatPreciseTime(seconds) { return `${Math.max(0, Number(seconds) || 0).toFixed(2)}s`; }
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}
function setVideoReadout(time) {
  elements.timeReadout.textContent = `${formatTime(time)} / ${formatTime(videoInfo?.duration ?? 0)}`;
  if (!isScrubbing && videoInfo?.duration) elements.timeSlider.value = String(Math.min(time, videoInfo.duration));
}

function isMp4File(file) {
  return Boolean(file && (/\.mp4$/iu.test(file.name) || file.type.toLowerCase() === 'video/mp4'));
}
function browserSupportsH264() {
  const probe = document.createElement('video');
  return Boolean(probe.canPlayType('video/mp4; codecs="avc1.42E01E"'));
}
function removeRenderDownload() {
  elements.downloadLink.hidden = true;
  elements.downloadLink.removeAttribute('href');
  if (renderUrl) URL.revokeObjectURL(renderUrl);
  renderUrl = null;
}

function setSelectedFile(file) {
  clearNotices();
  if (!file) return;
  if (!isMp4File(file)) {
    showError('Unsupported input. Choose an MP4 file with H.264 video; MOV, HEVC, and other formats are not supported by this workflow.');
    elements.fileInput.value = '';
    return;
  }
  if (!browserSupportsH264()) {
    showError('This browser does not report MP4/H.264 playback support. Try a current Chrome, Edge, or desktop Firefox browser with H.264 codecs enabled.');
    elements.fileInput.value = '';
    return;
  }
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  fileUrl = URL.createObjectURL(file);
  selectedFile = file;
  videoInfo = null;
  transcript = null;
  groups = [];
  elements.sourceVideo.pause();
  elements.sourceVideo.src = fileUrl;
  elements.sourceVideo.load();
  elements.fileSummary.innerHTML = `<span class="file-icon" aria-hidden="true">▱</span><span title="${escapeAttribute(file.name)}">${escapeHtml(file.name)} · ${formatBytes(file.size)}</span>`;
  elements.startButton.disabled = false;
  elements.workspace.hidden = true;
  elements.taskProgress.hidden = true;
  elements.stageItems.forEach(item => item.classList.remove('is-active', 'is-done'));
  setWorkflowStatus('Ready to decode');
  removeRenderDownload();
  elements.renderButton.disabled = true;
  elements.playButton.disabled = true;
  elements.timeSlider.disabled = true;
  elements.previewEmpty.hidden = false;
  drawPreview();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function escapeAttribute(value) { return escapeHtml(value); }

function drawCaptionLayer(ctx, captionGroups, captionStyle, time, width, height) {
  const group = activeGroup(captionGroups, time);
  if (!group?.length || !width || !height) return;
  const scale = Math.max(0.1, width / OUTPUT_WIDTH);
  const fontSize = captionStyle.font_size * scale;
  const lineHeight = fontSize * 1.16;
  ctx.save();
  ctx.font = `800 ${fontSize}px "Montserrat ExtraBold", Montserrat, Arial, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = captionStyle.stroke_width * scale;
  ctx.strokeStyle = captionStyle.stroke_color;
  const maxLineWidth = width * 0.9;
  const spaceWidth = ctx.measureText(' ').width;
  const lines = [[]];
  let lineWidth = 0;
  group.forEach((word, index) => {
    const text = String(word.text ?? '');
    const textWidth = ctx.measureText(text).width;
    const requiredWidth = textWidth + (lines.at(-1).length ? spaceWidth : 0);
    if (lines.at(-1).length && lineWidth + requiredWidth > maxLineWidth) {
      lines.push([]);
      lineWidth = 0;
    }
    const line = lines.at(-1);
    const widthWithSpace = textWidth + (line.length ? spaceWidth : 0);
    line.push({ text, index, width: textWidth });
    lineWidth += widthWithSpace;
  });
  const activeWord = captionStyle.highlight_enabled ? spokenWordIndex(group, time) : -1;
  const centerY = height * captionStyle.y_position;
  const firstBaseline = centerY - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, lineIndex) => {
    const totalWidth = line.reduce((sum, word) => sum + word.width, 0) + Math.max(0, line.length - 1) * spaceWidth;
    let x = (width - totalWidth) / 2;
    const y = firstBaseline + lineIndex * lineHeight;
    line.forEach((word, wordIndex) => {
      if (captionStyle.stroke_width > 0) ctx.strokeText(word.text, x, y);
      const color = word.index === activeWord ? captionStyle.highlight_color : captionStyle.caption_color;
      ctx.fillStyle = color;
      ctx.fillText(word.text, x, y);
      x += word.width + (wordIndex < line.length - 1 ? spaceWidth : 0);
    });
  });
  ctx.restore();
}

function drawSourceFrame(ctx, video, time, width, height) {
  ctx.fillStyle = '#08090b';
  ctx.fillRect(0, 0, width, height);
  if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return;
  const ratio = Math.min(width / video.videoWidth, height / video.videoHeight);
  const drawWidth = video.videoWidth * ratio;
  const drawHeight = video.videoHeight * ratio;
  const x = (width - drawWidth) / 2;
  const y = (height - drawHeight) / 2;
  try { ctx.drawImage(video, x, y, drawWidth, drawHeight); } catch { /* A frame may not be available until media decoding finishes. */ }
}
function drawCompleteFrame(ctx, video, time, width, height) {
  drawSourceFrame(ctx, video, time, width, height);
  drawCaptionLayer(ctx, groups, style, time, width, height);
}
function drawPreview() {
  const canvas = elements.previewCanvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const divisor = Math.max(1, OUTPUT_WIDTH);
  previewScale = Math.max(0.1, Math.min(2, (elements.previewStage.clientWidth || 0) / divisor));
  canvas.width = Math.max(1, Math.round(OUTPUT_WIDTH * previewScale * dpr));
  canvas.height = Math.max(1, Math.round(OUTPUT_HEIGHT * previewScale * dpr));
  ctx.setTransform(previewScale * dpr, 0, 0, previewScale * dpr, 0, 0);
  drawCompleteFrame(ctx, elements.sourceVideo, elements.sourceVideo.currentTime || 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
}
function previewTick() {
  if (selectedFile && !elements.workspace.hidden) {
    const time = elements.sourceVideo.currentTime || 0;
    drawPreview();
    setVideoReadout(time);
    const current = groups.findIndex(group => time >= group[0].start && time < group.at(-1).end);
    if (current !== lastActiveGroup) {
      lastActiveGroup = current;
      elements.captionList.querySelectorAll('.caption-row').forEach((row, index) => row.classList.toggle('is-active', index === current));
    }
  }
  previewRaf = requestAnimationFrame(previewTick);
}

function updateGroupList() {
  const count = groups.length;
  elements.groupCount.textContent = `${count} ${count === 1 ? 'group' : 'groups'}`;
  elements.captionList.replaceChildren();
  if (!count) {
    const empty = document.createElement('p');
    empty.className = 'empty-copy';
    empty.textContent = 'No timed caption groups are available.';
    elements.captionList.append(empty);
    return;
  }
  groups.forEach((group, index) => {
    const row = document.createElement('article');
    row.className = 'caption-row';
    row.dataset.index = String(index);
    const head = document.createElement('div');
    head.className = 'caption-row-head';
    const label = document.createElement('span');
    label.textContent = `GROUP ${String(index + 1).padStart(2, '0')}`;
    const range = document.createElement('span');
    range.textContent = `${formatPreciseTime(group[0].start)} – ${formatPreciseTime(group.at(-1).end)}`;
    head.append(label, range);
    const editor = document.createElement('textarea');
    editor.value = group.map(word => word.text).join(' ');
    editor.setAttribute('aria-label', `Caption group ${index + 1} text`);
    editor.maxLength = 2000;
    const actions = document.createElement('div');
    actions.className = 'caption-row-actions';
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'button button-quiet';
    jump.textContent = 'Preview here';
    jump.addEventListener('click', () => {
      elements.sourceVideo.currentTime = group[0].start;
      elements.sourceVideo.pause();
      elements.playButton.innerHTML = '▶ <span>Play</span>';
      drawPreview();
    });
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'button button-secondary';
    apply.textContent = 'Apply edit';
    apply.addEventListener('click', () => applyGroupEdit(index, editor.value));
    actions.append(jump, apply);
    row.append(head, editor, actions);
    elements.captionList.append(row);
  });
  lastActiveGroup = -2;
}

function applyGroupEdit(groupIndex, replacementText) {
  clearNotices();
  const currentGroups = groups;
  const currentFlat = flattenGroups(currentGroups);
  const updatedGroupTexts = currentGroups.map((group, index) => index === groupIndex ? replacementText : group.map(word => word.text).join(' '));
  try {
    const aligned = replaceTranscriptText({ words: currentFlat, text: transcriptText({ words: currentFlat }) }, updatedGroupTexts.join(' '));
    transcript = { ...transcript, ...aligned, text: transcriptText(aligned) };
    groups = groupWords(transcript.words, style);
    updateGroupList();
    drawPreview();
    showInfo('Caption text updated and aligned to the existing speech timings.');
  } catch (error) {
    showError(`Could not align this edit: ${humanError(error, 'Review the text and try again.')}`);
  }
}

function updateStyleControlValues() {
  const numeric = [
    ['font_size', 'fontSizeOutput', value => `${value}`],
    ['y_position', 'yPositionOutput', value => `${Math.round(value * 100)}%`],
    ['stroke_width', 'strokeWidthOutput', value => `${value}`],
    ['min_words', 'minWordsOutput', value => `${value}`],
    ['max_words', 'maxWordsOutput', value => `${value}`],
    ['max_chars', 'maxCharsOutput', value => `${value}`],
    ['pause_split', 'pauseSplitOutput', value => `${Number(value).toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '')} s`],
  ];
  numeric.forEach(([inputId, outputId, formatter]) => {
    const input = document.getElementById(inputId);
    input.value = String(style[inputId]);
    document.getElementById(outputId).textContent = formatter(style[inputId]);
  });
  [['caption_color', 'captionColorOutput'], ['highlight_color', 'highlightColorOutput'], ['stroke_color', 'strokeColorOutput']].forEach(([inputId, outputId]) => {
    document.getElementById(inputId).value = style[inputId];
    document.getElementById(outputId).textContent = style[inputId];
  });
  $('#highlight_enabled').checked = style.highlight_enabled;
}
function readStyleFromControls(changedId) {
  const inputStyle = { ...style };
  ['font_size', 'y_position', 'stroke_width', 'min_words', 'max_words', 'max_chars', 'pause_split'].forEach(id => {
    const value = document.getElementById(id).value;
    inputStyle[id] = clampStyleValue(id, value);
  });
  ['caption_color', 'highlight_color', 'stroke_color'].forEach(id => { inputStyle[id] = document.getElementById(id).value; });
  inputStyle.highlight_enabled = $('#highlight_enabled').checked;
  if (changedId === 'min_words' && inputStyle.min_words > inputStyle.max_words) inputStyle.max_words = inputStyle.min_words;
  if (changedId === 'max_words' && inputStyle.max_words < inputStyle.min_words) inputStyle.min_words = inputStyle.max_words;
  style = normalizeStyle(inputStyle);
  updateStyleControlValues();
  if (transcript?.words?.length) {
    groups = groupWords(transcript.words, style);
    updateGroupList();
  }
  drawPreview();
}

function installStyleControls() {
  ['font_size', 'y_position', 'stroke_width', 'min_words', 'max_words', 'max_chars', 'pause_split', 'caption_color', 'highlight_color', 'stroke_color', 'highlight_enabled'].forEach(id => {
    const control = document.getElementById(id);
    control.addEventListener('input', () => readStyleFromControls(id));
    control.addEventListener('change', () => readStyleFromControls(id));
  });
  elements.resetStyle.addEventListener('click', () => {
    style = normalizeStyle(DEFAULT_STYLE);
    updateStyleControlValues();
    if (transcript?.words?.length) {
      groups = groupWords(transcript.words, style);
      updateGroupList();
    }
    drawPreview();
  });
  updateStyleControlValues();
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB is unavailable in this browser. Presets cannot be stored.')); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the local preset database.'));
    request.onblocked = () => reject(new Error('The preset database is blocked by another open Shorts Studio tab.'));
  });
  return databasePromise;
}
async function listPresets() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result.map(item => validatePreset(item)).sort((a, b) => a.name.localeCompare(b.name)));
    request.onerror = () => reject(request.error || new Error('Could not read saved presets.'));
  });
}
async function storePreset(preset) {
  const valid = validatePreset(preset);
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const read = store.getAll();
    read.onsuccess = () => {
      read.result.filter(item => item.name.toLocaleLowerCase() === valid.name.toLocaleLowerCase()).forEach(item => store.delete(item.id));
      store.put({ id: valid.name.toLocaleLowerCase(), ...valid });
    };
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('Could not save this preset.'));
    transaction.onabort = () => reject(transaction.error || new Error('Saving this preset was cancelled.'));
  });
}
async function deletePreset(name) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(name.toLocaleLowerCase());
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('Could not delete this preset.'));
  });
}
async function refreshPresetList() {
  try {
    const presets = await listPresets();
    elements.presetCount.textContent = `${presets.length} saved`;
    elements.presetList.replaceChildren();
    if (!presets.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-copy';
      empty.textContent = 'Your saved presets stay in this browser.';
      elements.presetList.append(empty);
      return;
    }
    presets.forEach(preset => {
      const row = document.createElement('div');
      row.className = 'preset-item';
      const name = document.createElement('span');
      name.className = 'preset-name';
      name.textContent = preset.name;
      const load = document.createElement('button');
      load.type = 'button'; load.className = 'button button-quiet'; load.textContent = 'Load';
      load.addEventListener('click', () => {
        style = normalizeStyle(preset.style);
        updateStyleControlValues();
        if (transcript?.words?.length) { groups = groupWords(transcript.words, style); updateGroupList(); }
        drawPreview();
        showInfo(`Loaded “${preset.name}”.`);
      });
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'button button-quiet'; remove.textContent = 'Delete';
      remove.addEventListener('click', async () => {
        try { await deletePreset(preset.name); await refreshPresetList(); showInfo(`Deleted “${preset.name}”.`); }
        catch (error) { showError(humanError(error, 'Could not delete this preset.')); }
      });
      row.append(name, load, remove);
      elements.presetList.append(row);
    });
  } catch (error) {
    elements.presetCount.textContent = 'unavailable';
    elements.presetList.innerHTML = `<p class="empty-copy">${escapeHtml(humanError(error, 'Presets are unavailable.'))}</p>`;
  }
}
async function saveCurrentPreset() {
  clearNotices();
  try {
    const preset = validatePreset({ name: elements.presetName.value, style });
    await storePreset(preset);
    elements.presetName.value = '';
    await refreshPresetList();
    showInfo(`Saved “${preset.name}” in this browser.`);
  } catch (error) { showError(humanError(error, 'Could not save this preset.')); }
}
async function exportPresetFile() {
  clearNotices();
  try {
    const json = serializePresets(await listPresets());
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'shorts-studio-presets.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showInfo('Preset JSON exported.');
  } catch (error) { showError(humanError(error, 'Could not export presets.')); }
}
async function importPresetFile(file) {
  clearNotices();
  if (!file) return;
  try {
    const presets = parsePresets(await file.text());
    for (const preset of presets) await storePreset(preset);
    await refreshPresetList();
    showInfo(`Imported ${presets.length} ${presets.length === 1 ? 'preset' : 'presets'}.`);
  } catch (error) { showError(`Could not import presets: ${humanError(error, 'Check that the JSON file is valid.')}`); }
}

async function startWorkflow() {
  if (!selectedFile || elements.startButton.disabled) return;
  const model = elements.modelSelect.value;
  if (!Object.hasOwn(MODELS, model)) {
    showError('Choose a supported transcription model: base.en or small.en.');
    return;
  }
  clearNotices();
  removeRenderDownload();
  elements.startButton.disabled = true;
  elements.workspace.hidden = true;
  setStage('decode');
  setWorkflowStatus('Decoding media');
  setProgress('Inspecting MP4 video…', 0);
  try {
    videoInfo = await probeVideo(selectedFile);
    if (!videoInfo || !Number.isFinite(Number(videoInfo.duration)) || videoInfo.duration <= 0) {
      throw new Error('The video has no readable duration. Choose a valid MP4/H.264 file.');
    }
    setProgress('Decoding audio locally…', 3);
    const audio = await extractAudio(selectedFile, { onProgress: progress => setProgress('Decoding audio locally…', progressPercent(progress)) });
    if (!(audio?.samples instanceof Float32Array) || !audio.samples.length) {
      throw new Error('Audio decoding did not produce 16 kHz mono samples. The file may not contain a supported audio track.');
    }
    completeStage('decode');
    setStage('transcribe');
    setWorkflowStatus('Transcribing words');
    setProgress(`Transcribing with ${elements.modelSelect.selectedOptions[0].text}…`, 0);
    const result = await transcribeAudio(audio.samples, {
      model,
      onProgress: progress => setProgress(`Transcribing with ${elements.modelSelect.selectedOptions[0].text}…`, progressPercent(progress)),
    });
    if (!Array.isArray(result?.words) || !result.words.length) {
      throw new Error('Transcription returned no timed words. Try another model or a clip with clear speech.');
    }
    transcript = { ...result, words: result.words.map(word => ({ ...word, text: String(word.text).trim(), start: Number(word.start), end: Number(word.end) })) };
    transcript.words = transcript.words.filter(word => word.text && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
    if (!transcript.words.length) throw new Error('Transcription returned invalid word timings; no captions can be built.');
    completeStage('transcribe');
    groups = groupWords(transcript.words, style);
    updateGroupList();
    elements.workspace.hidden = false;
    elements.previewEmpty.hidden = true;
    elements.playButton.disabled = false;
    elements.timeSlider.disabled = false;
    elements.timeSlider.max = String(videoInfo.duration);
    elements.renderButton.disabled = false;
    setStage('review');
    setWorkflowStatus('Review your captions');
    setProgress('Review and style captions', 100);
    drawPreview();
  } catch (error) {
    elements.startButton.disabled = false;
    setWorkflowStatus('Could not process this video');
    showError(`Could not decode or transcribe this video. Confirm it is an MP4 with H.264 video and a supported audio track. ${humanError(error, 'Try a different file or browser.')}`);
  }
}

async function renderCurrentVideo() {
  if (!selectedFile || !transcript?.words?.length || renderInProgress) return;
  clearNotices();
  // WebCodecs is a secure-context API. Over plain HTTP on a LAN hostname or IP
  // the constructors are simply undefined, which otherwise reads as "your
  // browser is unsupported" when the real fix is the origin.
  if (!window.isSecureContext) {
    showError(
      'Rendering needs a secure context. WebCodecs is only available on HTTPS or localhost, '
      + 'and this page is served over plain HTTP. Open it via https:// or http://localhost.',
    );
    return;
  }
  if (typeof VideoEncoder === 'undefined') {
    showError('Rendering is unavailable because this browser does not provide the WebCodecs VideoEncoder API. Use a current desktop Chrome or Edge browser with WebCodecs enabled.');
    return;
  }
  if (typeof VideoDecoder === 'undefined') {
    showError('Rendering is unavailable because this browser does not provide the WebCodecs VideoDecoder API required by the local MP4 renderer.');
    return;
  }
  renderInProgress = true;
  cancelRequested = false;
  elements.renderButton.disabled = true;
  elements.cancelRender.hidden = false;
  elements.downloadLink.hidden = true;
  setStage('render');
  setWorkflowStatus('Rendering locally');
  setProgress('Preparing video renderer…', 0);
  try {
    // render.js draws its decoded VideoFrame onto this canvas before calling drawFrame.
    // Overlay the exact caption layer used by the live preview without seeking a second video.
    const drawFrame = (ctx, time) => {
      if (cancelRequested) throw new DOMException('Render cancelled by the user.', 'AbortError');
      drawCaptionLayer(ctx, groups, style, time, OUTPUT_WIDTH, OUTPUT_HEIGHT);
    };
    const blob = await renderVideo({
      file: selectedFile,
      drawFrame,
      width: OUTPUT_WIDTH,
      height: OUTPUT_HEIGHT,
      fps: 30,
      onProgress: progress => {
        if (cancelRequested) throw new DOMException('Render cancelled by the user.', 'AbortError');
        setProgress('Rendering captioned MP4…', progressPercent(progress));
      },
    });
    if (cancelRequested) throw new DOMException('Render cancelled by the user.', 'AbortError');
    if (!(blob instanceof Blob) || !blob.size) throw new Error('The renderer did not return a playable MP4 file.');
    completeStage('render');
    renderUrl = URL.createObjectURL(blob);
    elements.downloadLink.href = renderUrl;
    elements.downloadLink.hidden = false;
    setWorkflowStatus('Render complete');
    setProgress('Your captioned MP4 is ready', 100);
  } catch (error) {
    if (cancelRequested || error?.name === 'AbortError') {
      setWorkflowStatus('Render cancelled');
      setProgress('Render cancelled', 0);
      showInfo('Render cancelled. Your source file and caption edits are unchanged.');
      setStage('review');
    } else {
      setWorkflowStatus('Render failed');
      setStage('review');
      showError(`Could not render this video. ${humanError(error, 'Check WebCodecs support and try again.')}`);
    }
  } finally {
    renderInProgress = false;
    cancelRequested = false;
    elements.cancelRender.hidden = true;
    elements.cancelRender.disabled = false;
    elements.renderButton.disabled = false;
  }
}

function installEvents() {
  elements.fileInput.addEventListener('change', event => setSelectedFile(event.target.files?.[0]));
  elements.dropZone.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); elements.fileInput.click(); }
  });
  ['dragenter', 'dragover'].forEach(type => elements.dropZone.addEventListener(type, event => {
    event.preventDefault(); elements.dropZone.classList.add('is-dragging');
  }));
  ['dragleave', 'drop'].forEach(type => elements.dropZone.addEventListener(type, event => {
    event.preventDefault(); elements.dropZone.classList.remove('is-dragging');
  }));
  elements.dropZone.addEventListener('drop', event => setSelectedFile(event.dataTransfer?.files?.[0]));
  elements.startButton.addEventListener('click', startWorkflow);
  elements.playButton.addEventListener('click', async () => {
    if (elements.sourceVideo.paused) {
      try { await elements.sourceVideo.play(); elements.playButton.innerHTML = 'Ⅱ <span>Pause</span>'; }
      catch { showError('The preview could not start. Try clicking Play again.'); }
    } else {
      elements.sourceVideo.pause();
      elements.playButton.innerHTML = '▶ <span>Play</span>';
    }
  });
  elements.sourceVideo.addEventListener('ended', () => { elements.playButton.innerHTML = '▶ <span>Play</span>'; });
  elements.timeSlider.addEventListener('input', () => {
    isScrubbing = true;
    const time = Number(elements.timeSlider.value);
    elements.sourceVideo.currentTime = time;
    setVideoReadout(time);
    drawPreview();
  });
  elements.timeSlider.addEventListener('change', () => { isScrubbing = false; });
  elements.renderButton.addEventListener('click', renderCurrentVideo);
  elements.cancelRender.addEventListener('click', () => {
    if (!renderInProgress) return;
    cancelRequested = true;
    setWorkflowStatus('Stopping render…');
    setProgress('Waiting for the renderer to stop…', Number(elements.progressBar.value));
    elements.cancelRender.disabled = true;
  });
  elements.savePreset.addEventListener('click', saveCurrentPreset);
  elements.presetName.addEventListener('keydown', event => { if (event.key === 'Enter') saveCurrentPreset(); });
  elements.exportPresets.addEventListener('click', exportPresetFile);
  elements.importPresetsButton.addEventListener('click', () => elements.importPresetsFile.click());
  elements.importPresetsFile.addEventListener('change', event => {
    importPresetFile(event.target.files?.[0]);
    event.target.value = '';
  });
  installStyleControls();
  elements.previewCanvas.addEventListener('click', () => {
    if (elements.sourceVideo.paused) elements.playButton.click(); else elements.playButton.click();
  });
}

installEvents();
refreshPresetList();
const fontReady = document.fonts?.load?.('800 108px "Montserrat ExtraBold"');
if (fontReady && typeof fontReady.catch === 'function') fontReady.catch(() => {});
const resizeObserver = new ResizeObserver(() => drawPreview());
resizeObserver.observe(elements.previewStage);
window.addEventListener('resize', drawPreview, { passive: true });
previewRaf = requestAnimationFrame(previewTick);
