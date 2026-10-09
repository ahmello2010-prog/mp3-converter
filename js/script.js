/**
 * Converte-mp3: Client-side Audio/Video Converter
 * Powered by FFmpeg WebAssembly - 100% In-Browser Local Processing
 * Fully optimized for Mobile Browsers (iOS Safari & Android Chrome) and Desktop.
 */

// ==========================================
// ⚙️ إعدادات الحماية وحدود المتصفح (Config)
// ==========================================
const MAX_FILE_SIZE_MB = 150;        // الحد الأقصى لحجم الملف بالميجابايت
const MAX_DURATION_MINUTES = 30;     // الحد الأقصى لمدة الملف بالدقائق

// الامتدادات الشائعة على الهواتف وأجهزة الكمبيوتر
const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "webm", "mkv", "avi", "3gp", "3gpp", "ts", "mts", "wmv", "flv", "asf", "mpg", "mpeg"];
const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "ogg", "oga", "opus", "flac", "alac", "aiff", "aif", "caf", "amr", "wma", "weba", "mp2"];

// ==========================================
// 🎯 1. استدعاء عناصر الواجهة (DOM Elements)
// ==========================================
const previewThumbnailContainer = document.getElementById("preview-thumbnail-container");
const videoPreview = document.getElementById("video-preview");
const convertBtn = document.getElementById("convert-btn");
const cancelBtn = document.getElementById("cancel-btn");
const fileInput = document.getElementById("file-input");
const formatSelect = document.getElementById("format-select");
const statusText = document.getElementById("status");
const uploadText = document.getElementById("upload-text");
const progressContainer = document.getElementById("progress-container");
const progressBar = document.getElementById("progressBar");
const progressPercentage = document.getElementById("status-percentage");
const statusLabel = document.getElementById("status-label");
const dropZone = document.getElementById("drop-zone");

const fileDetailsCard = document.getElementById("file-details-card");
const detailName = document.getElementById("detail-name");
const detailSize = document.getElementById("detail-size");
const fileTypeIcon = document.getElementById("file-type-icon");

const tabVideo = document.getElementById("tab-video");
const tabAudio = document.getElementById("tab-audio");

// عناصر التنزيل والمشاركة للموبايل
const downloadActions = document.getElementById("download-actions");
const downloadLinkBtn = document.getElementById("download-link-btn");
const downloadBtnText = document.getElementById("download-btn-text");
const shareBtn = document.getElementById("share-btn");

// ==========================================
// 🧠 2. متغيرات الحالة وإدارة الذاكرة (State)
// ==========================================
let currentMode = "video";
let currentFile = null;
let currentBlobUrl = null;
let currentThumbnailUrl = null;
let currentOutputFile = null;
let isConverting = false;

// إدارة الـ Worker وتهيئة المحرك الكسولة (Lazy Loading)
let converterWorker = null;
let isWorkerReady = false;
let workerInitPromise = null;
let conversionCounter = 0;
let activeConversionId = null;

let phraseInterval = null;

const loadingPhrases = [
    "جاري معالجة واستخراج الصوت محلياً.. يرجى الانتظار ⏳",
    "التحويل يتم بأعلى جودة داخل متصفحك بدون رفع أي ملفات 🔒",
    "نعمل على تشفير وهندسة الترددات الصوتية بدقة 🎵",
    "قد يستغرق فك الفيديو بضع ثوانٍ إضافية حسب سرعة جهازك ✨"
];

// دالة لتنسيق الوقت (ثوانٍ إلى دقيقة:ثانية)
function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return "00:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

// ==========================================
// 👷 3. إدارة الـ Web Worker والتحميل الكسول (Lazy Loading)
// ==========================================
function getOrInitWorker() {
    if (isWorkerReady && converterWorker) {
        return Promise.resolve(converterWorker);
    }

    if (workerInitPromise) {
        return workerInitPromise;
    }

    workerInitPromise = new Promise((resolve, reject) => {
        try {
            if (!converterWorker) {
                // مسار مطلق كامل لضمان عمل الـ Worker في متصفحات الهواتف والـ iframes
                const workerUrl = new URL("/js/converter.worker.js", window.location.href).href;
                converterWorker = new Worker(workerUrl);
            }

            const timeoutId = setTimeout(() => {
                if (!isWorkerReady) {
                    workerInitPromise = null;
                    reject(new Error("استغرق تحميل محرك التحويل وقتًا أطول من المتوقع. حاول مرة أخرى."));
                }
            }, 60000);

            converterWorker.onmessage = function (e) {
                const data = e.data;

                // إشارة الجاهزية المسبقة
                if (data.type === "ready") {
                    clearTimeout(timeoutId);
                    isWorkerReady = true;
                    resolve(converterWorker);
                    return;
                }

                // تجاهل الرسائل التي لا تخص العملية النشطة الحالية
                if (data.conversionId && data.conversionId !== activeConversionId) {
                    return;
                }

                if (data.type === "progress") {
                    const percent = Math.min(99, Math.max(0, data.percent || 0));
                    let label = data.message || "جاري المعالجة...";

                    if (data.currentTime && data.totalDuration) {
                        label = `جاري التحويل... (${formatTime(data.currentTime)} / ${formatTime(data.totalDuration)})`;
                    }

                    updateProgress(percent, label);
                } else if (data.type === "meta") {
                    if (data.totalDuration) {
                        statusText.innerText = `الحالة: تم فحص الملف (المدة: ${formatTime(data.totalDuration)} دقيقة) - جاري المعالجة...`;
                    }
                } else if (data.type === "done") {
                    handleConversionSuccess(data);
                } else if (data.type === "error") {
                    handleConversionError(data.message);
                }
            };

            converterWorker.onerror = function (err) {
                clearTimeout(timeoutId);
                console.error("Worker error:", err);
                workerInitPromise = null;
                isWorkerReady = false;
                reject(new Error("تعذر تشغيل محرك التحويل. تأكد من دعم متصفحك للتقنية وحاول إعادة تحميل الصفحة."));
            };

            // إرسال إشارة التهيئة
            converterWorker.postMessage({ action: "init" });

        } catch (err) {
            workerInitPromise = null;
            isWorkerReady = false;
            reject(err);
        }
    });

    return workerInitPromise;
}

function terminateWorker() {
    if (converterWorker) {
        converterWorker.terminate();
        converterWorker = null;
    }
    isWorkerReady = false;
    workerInitPromise = null;
}

// ==========================================
// 🚀 بدء التطبيق
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
    statusText.innerText = "الحالة: جاهز بانتظار رفع ملف فيديو...";
});

// ==========================================
// 📑 4. هندسة التبديل بين الأوضاع (Video vs Audio)
// ==========================================
[tabVideo, tabAudio].forEach((tab) => {
    tab.addEventListener("click", () => {
        if (isConverting) {
            showError("يرجى إلغاء العملية الحالية أو الانتظار حتى اكتمالها قبل تبديل الوضع.");
            return;
        }

        tabVideo.classList.remove("active");
        tabAudio.classList.remove("active");
        tab.classList.add("active");

        currentMode = tab.getAttribute("data-mode");

        cleanupPreviousFile();

        if (currentMode === "video") {
            // قبول صيغ الفيديو مع صيغ الهواتف الشائعة
            fileInput.accept = "video/*,video/mp4,video/webm,video/quicktime,video/x-matroska,video/3gpp";
            uploadText.innerText = "اسحب ملف فيديو هنا أو اضغط للتصفح";
            statusText.innerText = "الحالة: جاهز بانتظار رفع ملف فيديو...";
        } else {
            // قبول صيغ الصوت مع صيغ الهواتف مثل M4A و AAC و OPUS و CAF و AMR
            fileInput.accept = "audio/*,audio/mpeg,audio/wav,audio/aac,audio/ogg,audio/flac,audio/mp4,audio/x-m4a";
            uploadText.innerText = "اسحب الملف الصوتي هنا أو اضغط للتصفح";
            statusText.innerText = "الحالة: جاهز بانتظار رفع ملف صوتي للتحويل...";
        }
    });
});

// ==========================================
// 🫳 5. السحب والإفلات وتفاعل النقر
// ==========================================
["dragenter", "dragover"].forEach((eventName) => {
    dropZone.addEventListener(
        eventName,
        (e) => {
            e.preventDefault();
            dropZone.classList.add("drag-over");
        },
        false
    );
});

["dragleave", "drop"].forEach((eventName) => {
    dropZone.addEventListener(
        eventName,
        (e) => {
            e.preventDefault();
            dropZone.classList.remove("drag-over");
        },
        false
    );
});

dropZone.addEventListener("drop", (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length > 0) {
        handleFileSelection(files[0]);
    }
});

fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files.length > 0) {
        handleFileSelection(fileInput.files[0]);
    }
});

// ==========================================
// 📂 6. معالجة وفحص واستلام الملف المختار مع توافق الهواتف
// ==========================================
async function handleFileSelection(file) {
    if (isConverting) {
        cancelCurrentConversion();
    }

    cleanupPreviousFile();
    statusText.classList.remove("error-mode");

    const extension = (file.name.split(".").pop() || "").toLowerCase();
    const isKnownVideoExt = VIDEO_EXTENSIONS.includes(extension);
    const isKnownAudioExt = AUDIO_EXTENSIONS.includes(extension);

    // التعامل مع ملفات الهواتف ذات MIME Type غير المعتاد أو الفارغ
    const isGenericMime = !file.type || file.type === "application/octet-stream";
    const isVideoMime = file.type.startsWith("video/");
    const isAudioMime = file.type.startsWith("audio/");

    // التحقق من توافق نوع الملف مع التبويب النشط
    if (currentMode === "video") {
        if (!isVideoMime && !isKnownVideoExt && !isGenericMime && isKnownAudioExt) {
            showError("هذا الملف صوتي؛ يرجى التبديل لتبويب \"محول صيغ الصوت\" أو اختيار ملف فيديو.");
            return;
        }
    } else {
        if (!isAudioMime && !isKnownAudioExt && !isGenericMime && isKnownVideoExt) {
            showError("هذا الملف فيديو؛ يرجى التبديل لتبويب \"فيديو إلى صوت\" أو اختيار ملف صوتي.");
            return;
        }
    }

    // التحقق من حجم الملف
    const sizeInMB = file.size / (1024 * 1024);
    if (sizeInMB > MAX_FILE_SIZE_MB) {
        showError(`الملف كبير جدًا للمعالجة داخل المتصفح (${sizeInMB.toFixed(1)} ميجابايت). الحد الأقصى المسموح هو ${MAX_FILE_SIZE_MB} ميجابايت لحماية ذاكرة جهازك.`);
        return;
    }

    // فحص مدة الملف بشكل آمن لا يتجمد أبدًا على متصفحات الهواتف
    let probedDuration = null;
    try {
        probedDuration = await checkMediaDurationSafe(file);
        if (probedDuration && probedDuration > (MAX_DURATION_MINUTES * 60)) {
            const minutes = Math.round(probedDuration / 60);
            showError(`مدة الملف (${minutes} دقيقة) تتجاوز الحد الآمن للمعالجة داخل المتصفح (${MAX_DURATION_MINUTES} دقيقة).`);
            return;
        }
    } catch (_) {
        // في حال تعذر على المتصفح قراءة المدة، يترك المحرك للتحقق أثناء فحص المسارات
    }

    currentFile = file;

    // تحديث بطاقة التفاصيل
    fileDetailsCard.style.display = "block";
    detailName.innerText = file.name;
    const durString = probedDuration ? ` • ${formatTime(probedDuration)} دقيقة` : "";
    detailSize.innerText = `${sizeInMB.toFixed(2)} ميجابايت${durString}`;
    fileTypeIcon.innerText = currentMode === "video" ? "🎬" : "🎵";

    uploadText.innerText = "تم اختيار الملف بنجاح! 🎉";
    statusText.innerText = "الحالة: جاهز ومستعد لبدء التحويل.";

    progressContainer.style.display = "none";
    updateProgress(0, "");

    if (currentMode === "video") {
        captureVideoThumbnailSafe(file);
    } else {
        previewThumbnailContainer.style.display = "none";
    }
}

// فحص مدة الميديا بمهلة أمان لمنع التجمد على iOS Safari
function checkMediaDurationSafe(file) {
    return new Promise((resolve) => {
        const isVideo = file.type.startsWith("video/") || VIDEO_EXTENSIONS.includes((file.name.split(".").pop() || "").toLowerCase());
        const mediaElem = document.createElement(isVideo ? "video" : "audio");
        const url = URL.createObjectURL(file);
        mediaElem.preload = "metadata";

        let finished = false;
        const cleanup = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            URL.revokeObjectURL(url);
            mediaElem.removeAttribute("src");
            mediaElem.load();
        };

        // مهلة 1500 مللي ثانية: إذا لم يرد متصفح الهاتف بميتاداتا، نواصل ولا نجمد التطبيق
        const timer = setTimeout(() => {
            cleanup();
            resolve(null);
        }, 1500);

        mediaElem.onloadedmetadata = () => {
            const dur = mediaElem.duration;
            cleanup();
            resolve((dur && isFinite(dur) && dur > 0) ? dur : null);
        };

        mediaElem.onerror = () => {
            cleanup();
            resolve(null);
        };

        mediaElem.src = url;
    });
}

// ==========================================
// 📸 7. استخراج غلاف الفيديو بأمان تام للهواتف
// ==========================================
function captureVideoThumbnailSafe(file) {
    statusText.innerText = "الحالة: جاري توليد صورة معاينة للفيديو...";

    const video = document.createElement("video");
    const videoUrl = URL.createObjectURL(file);
    video.src = videoUrl;
    video.muted = true;
    video.playsInline = true;

    let finished = false;
    const cleanup = () => {
        if (finished) return;
        finished = true;
        clearTimeout(safetyTimer);
        URL.revokeObjectURL(videoUrl);
        video.removeAttribute("src");
        video.load();
        statusText.innerText = "الحالة: جاهز ومستعد للتحويل.";
    };

    // مهلة أمان قصيرة لمنع بقاء الحالة معلقة على الموبايل
    const safetyTimer = setTimeout(() => {
        previewThumbnailContainer.style.display = "none";
        cleanup();
    }, 2500);

    video.onloadeddata = () => {
        try {
            // التحقق من أن المدة رقم حقيقي وليس NaN على Safari
            let seekTime = 0.5;
            if (isFinite(video.duration) && video.duration > 0) {
                seekTime = Math.min(1, video.duration / 2);
            }
            video.currentTime = seekTime;
        } catch (_) {
            cleanup();
        }
    };

    video.onseeked = () => {
        try {
            const canvas = document.createElement("canvas");
            canvas.width = Math.min(640, video.videoWidth || 320);
            canvas.height = Math.min(360, video.videoHeight || 180);

            const ctx = canvas.getContext("2d");
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            if (currentThumbnailUrl) {
                URL.revokeObjectURL(currentThumbnailUrl);
                currentThumbnailUrl = null;
            }

            canvas.toBlob((blob) => {
                if (blob && !finished) {
                    currentThumbnailUrl = URL.createObjectURL(blob);
                    videoPreview.src = currentThumbnailUrl;
                    previewThumbnailContainer.style.display = "block";
                }
                cleanup();
            }, "image/jpeg", 0.7);
        } catch (_) {
            cleanup();
        }
    };

    video.onerror = () => {
        previewThumbnailContainer.style.display = "none";
        cleanup();
    };
}

// ==========================================
// 🚀 8. بدء عملية التحويل
// ==========================================
convertBtn.addEventListener("click", async () => {
    if (isConverting) return;

    if (!currentFile) {
        showError(currentMode === "video" ? "قم باختيار أو سحب ملف فيديو أولاً!" : "قم باختيار أو سحب ملف صوتي أولاً!");
        return;
    }

    const chosenFormat = formatSelect.value;
    const currentExt = (currentFile.name.split(".").pop() || "").toLowerCase();

    if (currentMode === "audio" && currentExt === chosenFormat) {
        showError(`عذراً! الملف الذي اخترته هو بالفعل بصيغة (${chosenFormat.toUpperCase()}). اختر صيغة أخرى.`);
        return;
    }

    // إخفاء أزرار التنزيل السابقة إن وُجدت
    if (downloadActions) downloadActions.style.display = "none";

    // تفعيل حالة التحويل وقفل الزر
    isConverting = true;
    const thisConversionId = ++conversionCounter;
    activeConversionId = thisConversionId;

    convertBtn.disabled = true;
    convertBtn.style.background = "#9ca3af";
    convertBtn.style.cursor = "not-allowed";
    convertBtn.style.boxShadow = "none";

    if (cancelBtn) {
        cancelBtn.style.display = "block";
    }

    statusText.classList.remove("error-mode");

    let phraseIndex = 0;
    convertBtn.innerText = loadingPhrases[phraseIndex];
    phraseInterval = setInterval(() => {
        phraseIndex = (phraseIndex + 1) % loadingPhrases.length;
        convertBtn.innerText = loadingPhrases[phraseIndex];
    }, 3500);

    progressContainer.style.display = "flex";

    if (!isWorkerReady) {
        statusText.innerText = "الحالة: جاري تحميل محرك التحويل لأول مرة...";
        updateProgress(0, "جاري تحميل محرك التحويل (FFmpeg)...");
    } else {
        statusText.innerText = "الحالة: جاري تحضير ملفك للمعالجة...";
        updateProgress(0, "جاري تجهيز الملف...");
    }

    try {
        const worker = await getOrInitWorker();

        if (!isConverting || activeConversionId !== thisConversionId) {
            return;
        }

        statusText.innerText = "الحالة: جاري قراءة الملف وتمريره لمحرك التحويل...";
        updateProgress(0, "جاري قراءة الملف...");

        const arrayBuffer = await currentFile.arrayBuffer();

        if (!isConverting || activeConversionId !== thisConversionId) {
            return;
        }

        worker.postMessage(
            {
                action: "convert",
                conversionId: thisConversionId,
                fileData: arrayBuffer,
                fileName: currentFile.name,
                chosenFormat: chosenFormat
            },
            [arrayBuffer]
        );
    } catch (err) {
        console.error("Conversion init error:", err);
        if (activeConversionId === thisConversionId) {
            handleConversionError(err.message || "تعذر بدء عملية التحويل. حاول مرة أخرى.");
        }
    }
});

// ==========================================
// ❌ 9. زر الإلغاء الحقيقي أثناء المعالجة
// ==========================================
if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
        if (!isConverting) return;
        cancelCurrentConversion();
        statusText.innerText = "الحالة: تم إلغاء عملية التحويل بناءً على طلبك.";
    });
}

function cancelCurrentConversion() {
    if (!isConverting) return;

    activeConversionId = null;
    isConverting = false;

    // إنهاء الـ Worker فورياً لوقف تشغيل الـ WebAssembly وتحرير الذاكرة
    terminateWorker();

    clearInterval(phraseInterval);
    phraseInterval = null;

    restoreConvertButton();
    if (cancelBtn) cancelBtn.style.display = "none";
    if (downloadActions) downloadActions.style.display = "none";
    progressContainer.style.display = "none";
    updateProgress(0, "");
}

// ==========================================
// 🎉 10. معالجة نجاح التحويل وحفظ الملفات للهواتف والكمبيوتر
// ==========================================
function handleConversionSuccess(data) {
    clearInterval(phraseInterval);
    phraseInterval = null;
    isConverting = false;
    activeConversionId = null;

    updateProgress(100, "اكتمل التحويل بنجاح! 🚀");

    if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
        currentBlobUrl = null;
    }

    // إنشاء الـ Blob الحقيقي
    const realBlob = new Blob([data.outputBuffer], { type: data.mimeType });
    currentBlobUrl = URL.createObjectURL(realBlob);
    currentOutputFile = new File([realBlob], data.outputFileName, { type: data.mimeType });

    // 1. تفعيل زر التنزيل المباشر (Direct User Action) لحل قيود التنزيل التلقائي على Safari و Android
    if (downloadActions && downloadLinkBtn) {
        downloadLinkBtn.href = currentBlobUrl;
        downloadLinkBtn.download = data.outputFileName;
        if (downloadBtnText) {
            downloadBtnText.innerText = `تحميل ملف (${data.chosenFormat.toUpperCase()}) الآن 📥`;
        }
        downloadActions.style.display = "flex";
    }

    // 2. التحقق من دعم واجهة المشاركة على الهواتف (Web Share API)
    if (shareBtn && navigator.canShare) {
        try {
            if (navigator.canShare({ files: [currentOutputFile] })) {
                shareBtn.style.display = "block";
                shareBtn.onclick = async () => {
                    try {
                        await navigator.share({
                            files: [currentOutputFile],
                            title: data.outputFileName,
                            text: `تم تحويل الصوت إلى ${data.chosenFormat.toUpperCase()} بواسطة Converte-mp3`
                        });
                    } catch (shareErr) {
                        if (shareErr.name !== "AbortError") {
                            console.warn("Share failed:", shareErr);
                        }
                    }
                };
            }
        } catch (_) {
            shareBtn.style.display = "none";
        }
    }

    // 3. محاولة التنزيل التلقائي للكمبيوتر
    try {
        const autoDownloadLink = document.createElement("a");
        autoDownloadLink.href = currentBlobUrl;
        autoDownloadLink.download = data.outputFileName;
        document.body.appendChild(autoDownloadLink);
        autoDownloadLink.click();
        document.body.removeChild(autoDownloadLink);
    } catch (_) {
        // في حال تم حظر التنزيل التلقائي على الهاتف، زر التنزيل المباشر متاح وظاهر أمام المستخدم
    }

    statusText.innerText = `تم التحويل إلى ملف ${data.chosenFormat.toUpperCase()} حقيقي بنجاح! يمكنك الضغط على زر التحميل أدناه لحفظ الملف 📥`;
    statusText.classList.remove("error-mode");

    restoreConvertButton();
    if (cancelBtn) cancelBtn.style.display = "none";
}

// ==========================================
// ⚠️ 11. التعامل مع الأخطاء والرسائل المفهومة
// ==========================================
function handleConversionError(message) {
    clearInterval(phraseInterval);
    phraseInterval = null;
    isConverting = false;
    activeConversionId = null;

    statusText.innerText = "الحالة: " + message;
    statusText.classList.add("error-mode");
    progressContainer.style.display = "none";

    restoreConvertButton();
    if (cancelBtn) cancelBtn.style.display = "none";
    if (downloadActions) downloadActions.style.display = "none";
}

function showError(message) {
    statusText.innerText = "الحالة: " + message;
    statusText.classList.add("error-mode");
}

// ==========================================
// 🧹 12. تنظيف الذاكرة والمراجع السابقة
// ==========================================
function cleanupPreviousFile() {
    fileInput.value = "";
    currentFile = null;
    currentOutputFile = null;

    if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
        currentBlobUrl = null;
    }

    if (currentThumbnailUrl) {
        URL.revokeObjectURL(currentThumbnailUrl);
        currentThumbnailUrl = null;
    }

    videoPreview.src = "";
    previewThumbnailContainer.style.display = "none";
    fileDetailsCard.style.display = "none";
    progressContainer.style.display = "none";
    updateProgress(0, "");

    if (cancelBtn) cancelBtn.style.display = "none";
    if (downloadActions) downloadActions.style.display = "none";
    restoreConvertButton();
}

function updateProgress(percentage, label) {
    progressBar.style.width = `${percentage}%`;
    progressPercentage.innerText = `${percentage}%`;
    statusLabel.innerText = label;
}

function restoreConvertButton() {
    convertBtn.disabled = false;
    convertBtn.style.background = "linear-gradient(135deg, #a855f7, #6366f1)";
    convertBtn.style.cursor = "pointer";
    convertBtn.style.boxShadow = "0 4px 14px rgba(168, 85, 247, 0.35)";
    convertBtn.innerText = currentMode === "video" ? "استخراج وتحويل الصوت الآن 🚀" : "تحويل الملف الصوتي الآن 🎵";
}
