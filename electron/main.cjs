const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const activeJobs = new Map();

function binaryName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

async function executable(name) {
  const bundled = path.join(process.resourcesPath, 'bin', binaryName(name));
  try {
    await fs.access(bundled);
    return bundled;
  } catch {}
  const candidates = process.platform === 'darwin'
    ? [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]
    : [];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  return binaryName(name);
}

function trusted(event) {
  const url = event.senderFrame?.url || '';
  const rendererUrl = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
  if (url !== rendererUrl) throw new Error('Rejected request from an untrusted page.');
}

function safeSourcePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('A valid source file is required.');
  return path.normalize(value);
}

function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true, shell: false });
    const stdout = [], stderr = [];
    child.stdout?.on('data', chunk => stdout.push(chunk));
    child.stderr?.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', code => {
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      code === 0 ? resolve({ stdout: output, stderr: errorOutput }) : reject(new Error(errorOutput.trim().split('\n').slice(-8).join(' ') || `${path.basename(command)} exited with code ${code}`));
    });
  });
}

async function probe(sourcePath) {
  const ffprobe = await executable('ffprobe');
  const { stdout } = await runCapture(ffprobe, [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', sourcePath
  ]);
  const result = JSON.parse(stdout);
  if (!result.streams?.some(stream => stream.codec_type === 'video')) throw new Error('No video stream was found.');
  return result;
}

function utf16beNull(value) {
  const output = Buffer.alloc((value.length + 1) * 2);
  for (let index = 0; index < value.length; index++) output.writeUInt16BE(value.charCodeAt(index), index * 2);
  return output;
}

async function patchMxfIdentification(outputPath) {
  const handle = await fs.open(outputPath, 'r+');
  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(Math.min(size, 8 * 1024 * 1024));
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const view = header.subarray(0, bytesRead);
    for (const [original, replacement] of [['FFmpeg', 'BBC'], ['OP1a Muxer', 'bmx']]) {
      const oldValue = utf16beNull(original), newValue = utf16beNull(replacement);
      let offset = 0, replacements = 0;
      while ((offset = view.indexOf(oldValue, offset)) !== -1) {
        const padded = Buffer.alloc(oldValue.length);
        newValue.copy(padded);
        await handle.write(padded, 0, padded.length, offset);
        offset += oldValue.length;
        replacements++;
      }
      if (!replacements) throw new Error(`Could not set MXF ${replacement === 'BBC' ? 'company' : 'product'} identification metadata.`);
    }
  } finally {
    await handle.close();
  }
}

function rate(value) {
  const [numerator, denominator = 1] = String(value || '0/1').split('/').map(Number);
  return denominator ? numerator / denominator : 0;
}

function filterGraph(probeResult, overlays, overlayInputOffset) {
  const sourceVideo = probeResult.streams.find(stream => stream.codec_type === 'video');
  const isInterlaced = sourceVideo.field_order && sourceVideo.field_order !== 'progressive' && sourceVideo.field_order !== 'unknown';
  const filters = [];
  const scale = `scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos${isInterlaced ? ':interl=1' : ''},pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`;
  filters.push(`[0:v:0]${isInterlaced ? '' : 'fps=50,'}${scale}[base]`);
  let previous = 'base';
  overlays.forEach((overlay, index) => {
    const start = Math.max(0, Number(overlay.start) || 0);
    const end = Math.max(start + .04, Number(overlay.end) || start + .04);
    const fade = Math.max(.001, Math.min(Number(overlay.fade) || .001, (end - start) / 2));
    const fadeOut = Math.max(start, end - fade);
    const layer = `layer${index}`, output = `mix${index}`;
    filters.push(`[${overlayInputOffset + index}:v]format=rgba,fade=t=in:st=${start.toFixed(6)}:d=${fade.toFixed(6)}:alpha=1,fade=t=out:st=${fadeOut.toFixed(6)}:d=${fade.toFixed(6)}:alpha=1[${layer}]`);
    filters.push(`[${previous}][${layer}]overlay=0:0:eof_action=pass:enable='between(t,${start.toFixed(6)},${end.toFixed(6)})'[${output}]`);
    previous = output;
  });
  filters.push(`[${previous}]${isInterlaced ? 'fps=25' : 'tinterlace=mode=interleave_top'},setfield=tff,format=yuv422p[outv]`);
  return filters;
}

function audioMapping(probeResult, filters, args, silenceInputIndex) {
  const audio = probeResult.streams.filter(stream => stream.codec_type === 'audio');
  if (audio.length >= 2) {
    args.push('-map', `0:${audio[0].index}`, '-map', `0:${audio[1].index}`);
  } else if (audio.length === 1 && Number(audio[0].channels) >= 2) {
    filters.push('[0:a:0]channelsplit=channel_layout=stereo[aL][aR]');
    args.push('-map', '[aL]', '-map', '[aR]');
  } else if (audio.length === 1) {
    filters.push('[0:a:0]asplit=2[aL][aR]');
    args.push('-map', '[aL]', '-map', '[aR]');
  } else {
    args.push('-map', `${silenceInputIndex}:a:0`, '-map', `${silenceInputIndex}:a:0`);
  }
}

async function validateBroadcast(outputPath, expectedDuration) {
  const result = await probe(outputPath);
  const video = result.streams.find(stream => stream.codec_type === 'video');
  const audio = result.streams.filter(stream => stream.codec_type === 'audio');
  const duration = Number(result.format?.duration || video?.duration || 0);
  const failures = [];
  if (video?.codec_name !== 'dnxhd') failures.push('video codec is not DNxHD');
  if (Number(video?.width) !== 1920 || Number(video?.height) !== 1080) failures.push('frame size is not 1920×1080');
  if (Math.abs(rate(video?.r_frame_rate) - 25) > .01) failures.push('frame rate is not 25 fps');
  if (!['tt', 'tb'].includes(video?.field_order)) failures.push('field order is not top-field-first');
  if (video?.pix_fmt !== 'yuv422p') failures.push('pixel format is not YUV 4:2:2');
  if (video?.color_space !== 'bt709') failures.push('colour space is not BT.709');
  if (result.format?.tags?.company_name !== 'BBC') failures.push('company metadata is not BBC');
  if (result.format?.tags?.product_name !== 'bmx') failures.push('product metadata is not bmx');
  if (audio.length !== 2) failures.push('there are not two audio streams');
  for (const stream of audio) {
    if (stream.codec_name !== 'pcm_s24le') failures.push(`audio stream ${stream.index} is not 24-bit PCM`);
    if (Number(stream.sample_rate) !== 48000) failures.push(`audio stream ${stream.index} is not 48 kHz`);
    if (Number(stream.channels) !== 1) failures.push(`audio stream ${stream.index} is not mono`);
  }
  if (!duration || Math.abs(duration - expectedDuration) > Math.max(.12, expectedDuration * .005)) failures.push('duration does not match the source');
  if (failures.length) throw new Error(`MXF validation failed: ${[...new Set(failures)].join('; ')}.`);
  return { duration, video, audio };
}

async function writeOverlays(directory, overlays) {
  const paths = [];
  for (let index = 0; index < overlays.length; index++) {
    const bytes = overlays[index]?.png;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 100 || bytes.byteLength > 30_000_000) throw new Error(`Overlay ${index + 1} is invalid.`);
    const target = path.join(directory, `overlay-${index}.png`);
    await fs.writeFile(target, bytes);
    paths.push(target);
  }
  return paths;
}

async function exportBroadcast(event, payload) {
  trusted(event);
  const sourcePath = safeSourcePath(payload?.sourcePath);
  const overlays = Array.isArray(payload?.overlays) ? payload.overlays.slice(0, 24) : [];
  if (!overlays.length) throw new Error('At least one lower-third key is required.');
  await fs.access(sourcePath);
  const suggested = `${path.basename(sourcePath, path.extname(sourcePath))}-keyed-broadcast.mxf`;
  const choice = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Export broadcast MXF', defaultPath: path.join(path.dirname(sourcePath), suggested),
    filters: [{ name: 'MXF broadcast master', extensions: ['mxf'] }]
  });
  if (choice.canceled || !choice.filePath) return { canceled: true };
  const outputPath = choice.filePath.toLowerCase().endsWith('.mxf') ? choice.filePath : `${choice.filePath}.mxf`;
  const jobId = crypto.randomUUID(), tempDir = await fs.mkdtemp(path.join(app.getPath('temp'), 'lower-third-studio-'));
  const partialPath = `${outputPath}.${jobId}.partial.mxf`;
  const send = update => {
    if (!event.sender.isDestroyed()) event.sender.send('studio:export-progress', { jobId, ...update });
  };
  try {
    const probeResult = await probe(sourcePath);
    const duration = Number(probeResult.format?.duration) || 0;
    if (!duration) throw new Error('The source duration could not be determined.');
    const overlayPaths = await writeOverlays(tempDir, overlays);
    const ffmpeg = await executable('ffmpeg');
    const inputArgs = ['-hide_banner', '-nostdin', '-y', '-i', sourcePath];
    for (const overlayPath of overlayPaths) inputArgs.push('-loop', '1', '-framerate', '25', '-i', overlayPath);
    const hasAudio = probeResult.streams.some(stream => stream.codec_type === 'audio');
    const silenceInputIndex = 1 + overlayPaths.length;
    if (!hasAudio) inputArgs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono');
    const filters = filterGraph(probeResult, overlays, 1);
    const outputArgs = ['-map', '[outv]'];
    audioMapping(probeResult, filters, outputArgs, silenceInputIndex);
    const args = [
      ...inputArgs, '-filter_complex', filters.join(';'), ...outputArgs,
      '-c:v', 'dnxhd', '-profile:v', 'dnxhd', '-b:v', '120M', '-pix_fmt', 'yuv422p',
      '-flags', '+ildct+ilme', '-top', '1', '-r', '25',
      '-color_range', 'tv', '-colorspace', 'bt709', '-color_trc', 'bt709', '-color_primaries', 'bt709',
      '-c:a', 'pcm_s24le', '-ar:a', '48000', '-ac:a', '1',
      '-metadata', 'company_name=BBC', '-metadata', 'product_name=Lower Third Studio',
      '-t', duration.toFixed(6), '-f', 'mxf', '-progress', 'pipe:1', partialPath
    ];
    send({ progress: 0, message: 'Starting native DNxHD export…' });
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, args, { windowsHide: true, shell: false });
      const job = { child, canceled: false };activeJobs.set(jobId, job);
      let progressBuffer = '', errorBuffer = '';
      child.stdout.on('data', chunk => {
        progressBuffer += chunk.toString();
        const lines = progressBuffer.split(/\r?\n/);progressBuffer = lines.pop() || '';
        for (const line of lines) {
          const [key, value] = line.split('=', 2);
          if (key === 'out_time_us') send({ progress: Math.max(0, Math.min(.94, Number(value) / 1_000_000 / duration * .94)), message: 'Encoding DNxHD broadcast master…' });
        }
      });
      child.stderr.on('data', chunk => { errorBuffer = (errorBuffer + chunk.toString()).slice(-16000); });
      child.once('error', reject);
      child.once('close', code => {
        activeJobs.delete(jobId);
        if (job.canceled) reject(new Error('Export canceled.'));
        else if (code === 0) resolve();
        else reject(new Error(errorBuffer.trim().split('\n').slice(-10).join(' ') || `FFmpeg exited with code ${code}`));
      });
    });
    await patchMxfIdentification(partialPath);
    send({ progress: .96, message: 'Validating MXF structure and metadata…' });
    const validation = await validateBroadcast(partialPath, duration);
    await fs.rm(outputPath, { force: true });
    await fs.rename(partialPath, outputPath);
    send({ progress: 1, message: 'Broadcast MXF export complete' });
    return { canceled: false, jobId, outputPath, validation };
  } finally {
    activeJobs.delete(jobId);
    await fs.rm(partialPath, { force: true }).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 980, minHeight: 700,
    backgroundColor: '#111318',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  window.removeMenu();
  const rendererPath = path.join(__dirname, '..', 'index.html');
  const rendererUrl = pathToFileURL(rendererPath).href;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  window.loadFile(rendererPath);
}

app.whenReady().then(() => {
  ipcMain.handle('studio:choose-video', async event => {
    trusted(event);
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Choose source video', properties: ['openFile'],
      filters: [{ name: 'Video files', extensions: ['mp4', 'm4v', 'mov', 'mxf', 'mkv', 'avi', 'webm', 'mpg', 'mpeg'] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const sourcePath = result.filePaths[0];
    return { sourcePath, name: path.basename(sourcePath), url: pathToFileURL(sourcePath).href, probe: await probe(sourcePath) };
  });
  ipcMain.handle('studio:probe-video', async (event, payload) => { trusted(event);return probe(safeSourcePath(payload?.sourcePath)); });
  ipcMain.handle('studio:export-broadcast', exportBroadcast);
  ipcMain.handle('studio:cancel-export', async (event, payload) => {
    trusted(event);const job = activeJobs.get(payload?.jobId);if (!job) return false;
    job.canceled = true;job.child.kill('SIGTERM');return true;
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { for (const job of activeJobs.values()) { job.canceled = true;job.child.kill('SIGTERM'); } });
