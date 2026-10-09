/**
 * Converte-mp3: Web Worker for FFmpeg In-Browser Audio/Video Processing
 * 100% Client-side conversion using FFmpeg WebAssembly.
 * Fully optimized for Mobile Browsers (iOS Safari & Android Chrome) and Desktop.
 */

let core = null;
let corePromise = null;
let activeConversionId = null;

let currentDuration = 0;
let hasAudio = false;
let collectedLogs = [];

const MAX_DURATION_SECONDS = 30 * 60; // 30 minutes

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
    if (collectedLogs.length > 600) {
        collectedLogs.shift();
    }

    // Detect if input has an audio stream
    if (msg.includes('Audio:') || (msg.includes('Stream #0') && msg.includes('Audio'))) {
        hasAudio = true;
    }

    // Detect total duration
    const durationMatch = msg.match(/Duration:\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
    if (durationMatch) {
        currentDuration = parseSeconds(durationMatch[1]);
        self.postMessage({
            type: 'meta',
            conversionId: activeConversionId,
            totalDuration: currentDuration
        });
    }

    // Detect current encoding progress timestamp
    const timeMatch = msg.match(/time=\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
    if (timeMatch && currentDuration > 0) {
        const currentTime = parseSeconds(timeMatch[1]);
        const percent = Math.min(99, Math.max(1, Math.floor((currentTime / currentDuration) * 100)));
        self.postMessage({
            type: 'progress',
            conversionId: activeConversionId,
            percent: percent,
            currentTime: currentTime,
            totalDuration: currentDuration
        });
    }
}

/**
 * Initializes FFmpeg Core using a shared Promise so concurrent callers await the same init.
 * Uses fully qualified absolute URLs to guarantee compatibility across mobile browsers and iframes.
 */
function getCore() {
    if (core) return Promise.resolve(core);
    if (corePromise) return corePromise;

    corePromise = (async () => {
        try {
            if (typeof createFFmpegCore !== 'function') {
                const coreScriptUrl = new URL('/ffmpeg-core.js', self.location.href).href;
                importScripts(coreScriptUrl);
            }

            if (typeof createFFmpegCore !== 'function') {
                throw new Error('createFFmpegCore is not defined in global scope');
            }

            const engine = await createFFmpegCore({
                locateFile: (path) => new URL('/' + path, self.location.href).href,
                noExitRuntime: true,
                print: handleLog,
                printErr: handleLog
            });

            core = engine;
            return engine;
        } catch (err) {
            corePromise = null; // Allow retry on failure
            core = null;
            throw err;
        }
    })();

    return corePromise;
}

self.onmessage = async function (e) {
    const { action, conversionId } = e.data;

    // Optional pre-init signal
    if (action === 'init') {
        try {
            await getCore();
            self.postMessage({ type: 'ready', conversionId });
        } catch (err) {
            self.postMessage({
                type: 'error',
                conversionId,
                errorType: 'init_failed',
                message: 'تعذر تشغيل محرك التحويل. حاول تحديث الصفحة.'
            });
        }
        return;
    }

    if (action === 'convert') {
        const { fileData, fileName, chosenFormat } = e.data;
        activeConversionId = conversionId;
        collectedLogs = [];
        currentDuration = 0;
        hasAudio = false;

        const inputExt = (fileName.split('.').pop() || 'bin').toLowerCase();
        const baseName = fileName.replace(/\.[^/.]+$/, '') || 'converted_audio';
        const inFileName = `input_${Date.now()}_${conversionId}.${inputExt}`;
        const outFileName = `output_${Date.now()}_${conversionId}.${chosenFormat}`;

        let engine = null;
        const allocatedPointers = [];

        try {
            self.postMessage({
                type: 'progress',
                conversionId,
                percent: 0,
                stage: 'loading_engine',
                message: 'جاري تحميل محرك التحويل...'
            });

            engine = await getCore();

            self.postMessage({
                type: 'progress',
                conversionId,
                percent: 0,
                stage: 'preparing_file',
                message: 'جاري قراءة وتجهيز الملف للمعالجة...'
            });

            // Write input data into virtual Emscripten filesystem
            engine.FS.writeFile(inFileName, new Uint8Array(fileData));

            // Select encoding arguments based on chosen format
            let codecArgs = [];
            switch (chosenFormat) {
                case 'mp3':
                    // Real MP3 using libmp3lame at 192kbps
                    codecArgs = ['-c:a', 'libmp3lame', '-b:a', '192k'];
                    break;
                case 'wav':
                    // Real 16-bit PCM uncompressed WAV
                    codecArgs = ['-c:a', 'pcm_s16le'];
                    break;
                case 'm4a':
                    // Real AAC audio in MP4 container at 192kbps
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

            // Command: -vn strips video, extracting and converting audio track directly
            const fullArgs = ['./ffmpeg', '-nostdin', '-y', '-i', inFileName, '-vn', ...codecArgs, outFileName];

            self.postMessage({
                type: 'progress',
                conversionId,
                percent: 0,
                stage: 'converting',
                message: 'جاري بدء التحويل...'
            });

            // Allocate argument pointers for Emscripten C runtime
            const argc = fullArgs.length;
            const argvPtr = engine._malloc((argc + 1) * 4);
            allocatedPointers.push(argvPtr);

            for (let i = 0; i < argc; i++) {
                const len = engine.lengthBytesUTF8(fullArgs[i]) + 1;
                const strPtr = engine._malloc(len);
                allocatedPointers.push(strPtr);
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

            // Enforce duration safety limit if detected during probe
            if (currentDuration > MAX_DURATION_SECONDS) {
                const minutes = Math.round(currentDuration / 60);
                throw new Error(`DURATION_EXCEEDED:${minutes}`);
            }

            // Verify file creation and exit status
            const fullLogText = collectedLogs.join('\n');
            let outputBytes = null;
            try {
                outputBytes = engine.FS.readFile(outFileName);
            } catch (_) {
                outputBytes = null;
            }

            const fileValid = outputBytes && outputBytes.length > 0;

            if (exitCode !== 0 || !fileValid) {
                if (fullLogText.includes('Invalid data found') || fullLogText.includes('unknown format') || fullLogText.includes('could not find codec parameters')) {
                    throw new Error('INVALID_MEDIA_FILE');
                }
                if (!hasAudio || fullLogText.includes('matches no streams') || fullLogText.includes('does not contain any stream')) {
                    throw new Error('NO_AUDIO_TRACK');
                }
                throw new Error('CONVERSION_FAILED');
            }

            self.postMessage({
                type: 'done',
                conversionId,
                outputBuffer: outputBytes.buffer,
                outputFileName: `${baseName}.${chosenFormat}`,
                chosenFormat: chosenFormat,
                mimeType: MIME_TYPES[chosenFormat] || 'audio/mpeg'
            }, [outputBytes.buffer]);

        } catch (err) {
            let userMsg = 'تعذر تحويل الملف. جرّب صيغة أخرى أو ملفًا أصغر.';
            let errType = 'conversion_failed';

            if (err && typeof err.message === 'string') {
                if (err.message.startsWith('DURATION_EXCEEDED:')) {
                    const mins = err.message.split(':')[1] || '30';
                    userMsg = `مدة الملف (${mins} دقيقة) تتجاوز الحد الآمن للمعالجة داخل المتصفح (30 دقيقة).`;
                    errType = 'duration_exceeded';
                } else if (err.message === 'NO_AUDIO_TRACK') {
                    userMsg = 'هذا الفيديو لا يحتوي على مسار صوتي.';
                    errType = 'no_audio';
                } else if (err.message === 'INVALID_MEDIA_FILE') {
                    userMsg = 'تعذر قراءة الملف. تأكد من أن الملف صوت أو فيديو صالح.';
                    errType = 'invalid_file';
                }
            }

            self.postMessage({
                type: 'error',
                conversionId,
                errorType: errType,
                message: userMsg
            });
        } finally {
            // 1. Free all allocated command argument pointers with _free
            if (engine && engine._free) {
                for (const ptr of allocatedPointers) {
                    try {
                        if (ptr) engine._free(ptr);
                    } catch (_) {}
                }
            }

            // 2. Guaranteed deletion of temporary input & output files in MEMFS
            if (engine && engine.FS) {
                try { engine.FS.unlink(inFileName); } catch (_) {}
                try { engine.FS.unlink(outFileName); } catch (_) {}
            }
        }
    }
};
