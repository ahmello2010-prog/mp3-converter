/**
 * Converte-mp3: Web Worker for FFmpeg In-Browser Audio/Video Processing
 * 100% Client-side conversion using FFmpeg WebAssembly.
 */

let core = null;
let currentDuration = 0;
let hasAudio = false;
let collectedLogs = [];

const MIME_TYPES = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    ogg: 'audio/ogg'
};

function parseSeconds(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.trim().split(':');
    if (parts.length === 3) {
        return (parseFloat(parts[0]) * 3600) + (parseFloat(parts[1]) * 60) + parseFloat(parts[2]);
    }
    return 0;
}

function handleLog(msg) {
    if (typeof msg !== 'string') return;
    collectedLogs.push(msg);

    // Keep log buffer bounded to avoid memory build-up on long conversions
    if (collectedLogs.length > 500) {
        collectedLogs.shift();
    }

    // Detect if input has audio stream
    if (msg.includes('Audio:') || msg.includes('Stream #0') && msg.includes('Audio')) {
        hasAudio = true;
    }

    // Detect total duration
    const durationMatch = msg.match(/Duration:\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
    if (durationMatch) {
        currentDuration = parseSeconds(durationMatch[1]);
        self.postMessage({
            type: 'meta',
            totalDuration: currentDuration
        });
    }

    // Detect current encoding progress timestamp
    const timeMatch = msg.match(/time=\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
    if (timeMatch && currentDuration > 0) {
        const currentTime = parseSeconds(timeMatch[1]);
        const percent = Math.min(99, Math.max(1, Math.round((currentTime / currentDuration) * 100)));
        self.postMessage({
            type: 'progress',
            percent: percent,
            currentTime: currentTime,
            totalDuration: currentDuration
        });
    }
}

async function initCore() {
    if (core) return core;
    self.postMessage({ type: 'status', message: 'جاري تشغيل محرك التحويل...' });

    try {
        importScripts('/ffmpeg-core-st.js');
    } catch (err) {
        throw new Error('تعذر تحميل ملف محرك التحويل المحلي: ' + err.message);
    }

    if (typeof createFFmpegCore !== 'function') {
        throw new Error('تعذر العثور على createFFmpegCore');
    }

    core = await createFFmpegCore({
        locateFile: (path) => '/' + path,
        noExitRuntime: true,
        print: handleLog,
        printErr: handleLog
    });

    return core;
}

self.onmessage = async function (e) {
    const { action } = e.data;

    if (action === 'init') {
        try {
            await initCore();
            self.postMessage({ type: 'ready' });
        } catch (err) {
            self.postMessage({ type: 'error', errorType: 'init_failed', message: 'تعذر تشغيل محرك التحويل. حاول تحديث الصفحة.' });
        }
        return;
    }

    if (action === 'convert') {
        const { fileData, fileName, chosenFormat } = e.data;
        collectedLogs = [];
        currentDuration = 0;
        hasAudio = false;

        const inputExt = (fileName.split('.').pop() || 'bin').toLowerCase();
        const baseName = fileName.replace(/\.[^/.]+$/, '') || 'converted_audio';
        const inFileName = `input_${Date.now()}.${inputExt}`;
        const outFileName = `output_${Date.now()}.${chosenFormat}`;

        try {
            const engine = await initCore();

            self.postMessage({ type: 'progress', percent: 5, message: 'جاري قراءة وتجهيز الملف للمعالجة...' });

            // Write input data into virtual Emscripten filesystem
            engine.FS.writeFile(inFileName, new Uint8Array(fileData));

            // Select encoding arguments based on format
            let codecArgs = [];
            switch (chosenFormat) {
                case 'mp3':
                    // Real MP3 with libmp3lame at 192kbps
                    codecArgs = ['-c:a', 'libmp3lame', '-b:a', '192k'];
                    break;
                case 'wav':
                    // Real 16-bit PCM uncompressed studio quality WAV
                    codecArgs = ['-c:a', 'pcm_s16le'];
                    break;
                case 'm4a':
                    // Real AAC in MP4/M4A container at 192kbps
                    codecArgs = ['-c:a', 'aac', '-b:a', '192k'];
                    break;
                case 'flac':
                    // Real FLAC lossless audio
                    codecArgs = ['-c:a', 'flac'];
                    break;
                case 'ogg':
                    // Real Ogg Vorbis at high quality
                    codecArgs = ['-c:a', 'libvorbis', '-q:a', '5'];
                    break;
                default:
                    codecArgs = ['-c:a', 'libmp3lame', '-b:a', '192k'];
            }

            // Build full command: -vn strips video, extracts and converts audio track directly
            const fullArgs = ['./ffmpeg', '-nostdin', '-y', '-i', inFileName, '-vn', ...codecArgs, outFileName];

            self.postMessage({ type: 'progress', percent: 15, message: 'جاري بدء التحويل...' });

            // Prepare argv memory pointers for Emscripten
            const argc = fullArgs.length;
            const argvPtr = engine._malloc((argc + 1) * 4);
            for (let i = 0; i < argc; i++) {
                const len = engine.lengthBytesUTF8(fullArgs[i]) + 1;
                const strPtr = engine._malloc(len);
                engine.stringToUTF8(fullArgs[i], strPtr, len);
                engine.setValue(argvPtr + (i * 4), strPtr, 'i32');
            }
            engine.setValue(argvPtr + (argc * 4), 0, 'i32');

            // Execute FFmpeg
            const execFn = engine._proxy_main || engine._main;
            let exitCode = 0;
            try {
                exitCode = execFn(argc, argvPtr);
            } catch (runErr) {
                if (runErr && runErr.name === 'ExitStatus') {
                    exitCode = runErr.status;
                } else {
                    throw runErr;
                }
            }

            // Verify result
            const fullLogText = collectedLogs.join('\n');
            const fileExists = engine.FS.analyzePath(outFileName).exists;

            if (exitCode !== 0 || !fileExists) {
                // Determine accurate error cause from log
                if (!hasAudio || fullLogText.includes('matches no streams') || fullLogText.includes('does not contain any stream')) {
                    throw new Error('NO_AUDIO_TRACK');
                }
                if (fullLogText.includes('Invalid data found') || fullLogText.includes('unknown format')) {
                    throw new Error('INVALID_MEDIA_FILE');
                }
                throw new Error('CONVERSION_FAILED');
            }

            // Read output file
            const outputBytes = engine.FS.readFile(outFileName);

            // Cleanup MEMFS immediately to free WebAssembly memory
            try { engine.FS.unlink(inFileName); } catch (_) {}
            try { engine.FS.unlink(outFileName); } catch (_) {}

            self.postMessage({
                type: 'done',
                outputBuffer: outputBytes.buffer,
                outputFileName: `${baseName}.${chosenFormat}`,
                mimeType: MIME_TYPES[chosenFormat] || 'audio/mpeg'
            }, [outputBytes.buffer]);

        } catch (err) {
            // Clean up any remaining temporary files
            if (core) {
                try { core.FS.unlink(inFileName); } catch (_) {}
                try { core.FS.unlink(outFileName); } catch (_) {}
            }

            let userMsg = 'تعذر تحويل الملف. جرّب صيغة أخرى أو ملفًا أصغر.';
            let errType = 'conversion_failed';

            if (err.message === 'NO_AUDIO_TRACK') {
                userMsg = 'هذا الفيديو لا يحتوي على مسار صوتي.';
                errType = 'no_audio';
            } else if (err.message === 'INVALID_MEDIA_FILE') {
                userMsg = 'تعذر قراءة الملف. تأكد من أن الملف صوت أو فيديو صالح.';
                errType = 'invalid_file';
            }

            self.postMessage({
                type: 'error',
                errorType: errType,
                message: userMsg
            });
        }
    }
};
