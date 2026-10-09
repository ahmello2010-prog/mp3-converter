/**
 * Converte-mp3: Client-side Audio/Video Converter
 * Powered by FFmpeg WebAssembly - 100% In-Browser Local Processing
 */

// ==========================================
// ⚙️ إعدادات الحماية وحدود المتصفح (Config)
// ==========================================
const MAX_FILE_SIZE_MB = 150;        // الحد الأقصى لحجم الملف بالميجابايت
const MAX_DURATION_MINUTES = 30;     // الحد الأقصى لمدة الملف بالدقائق

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

// ==========================================
// 🧠 2. متغيرات الحالة وإدارة الذاكرة (State)
// ==========================================
let currentMode = "video";
let currentFile = null;
let currentBlobUrl = null;
let currentThumbnailUrl = null;
let isConverting = false;
let converterWorker = null;
let phraseInterval = null;

const loadingPhrases = [
    "جاري معالجة واستخراج الصوت محلياً.. يرجى الانتظار ⏳",
    "التحويل يتم بأعلى جودة داخل متصفحك بدون رفع أي ملفات 🔒",
    "نعمل على تشفير وهندسة الترددات الصوتية بدقة 🎵",
    "قد يستغرق فك الفيديو بضع ثوانٍ إضافية حسب سرعة جهازك ✨"
];

// ==========================================
// 👷 3. إدارة الـ Web Worker
// ==========================================
function initWorker() {
    if (converterWorker) return;

    try {
        converterWorker = new Worker("/js/converter.worker.js");

        converterWorker.onmessage = function (e) {
            const data = e.data;

            if (data.type === "ready") {
                if (!isConverting && !currentFile) {
                    statusText.innerText = currentMode === "video"
                        ? "الحالة: محرك التحويل جاهز، بانتظار اختيار ملف فيديو..."
                        : "الحالة: محرك التحويل جاهز، بانتظار اختيار ملف صوتي...";
                }
            } else if (data.type === "status") {
                statusText.innerText = "الحالة: " + data.message;
            } else if (data.type === "progress") {
                updateProgress(data.percent, data.message || `جاري التحويل... ${data.percent}%`);
            } else if (data.type === "done") {
                handleConversionSuccess(data);
            } else if (data.type === "error") {
                handleConversionError(data.message);
            }
        };

        converterWorker.onerror = function (err) {
            console.error("Worker error:", err);
            handleConversionError("تعذر تشغيل محرك التحويل. تأكد من دعم متصفحك للتقنية وحاول إعادة تحميل الصفحة.");
        };

        // إرسال إشارة التهيئة المسبقة للمحرك
        converterWorker.postMessage({ action: "init" });
    } catch (err) {
        console.error("Failed to start worker:", err);
    }
}

function terminateWorker() {
    if (converterWorker) {
        converterWorker.terminate();
        converterWorker = null;
    }
}

// ==========================================
// 🚀 بدء التطبيق
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
    statusText.innerText = "الحالة: جاهز بانتظار رفع ملف فيديو...";
    initWorker();
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

        // تنظيف البيانات والذاكرة
        cleanupPreviousFile();

        if (currentMode === "video") {
            fileInput.accept = "video/*,video/mp4,video/webm,video/quicktime,video/x-matroska";
            uploadText.innerText = "اسحب ملف فيديو هنا أو اضغط للتصفح";
            statusText.innerText = "الحالة: جاهز بانتظار رفع ملف فيديو...";
        } else {
            fileInput.accept = "audio/*,audio/mpeg,audio/wav,audio/aac,audio/ogg,audio/flac,audio/mp4";
            uploadText.innerText = "اسحب الملف الصوتي هنا أو اضغط للتصفح";
            statusText.innerText = "الحالة: جاهز بانتظار رفع ملف صوتي للتحويل...";
        }
    });
});

// ==========================================
// 🫳 5. السحب والإفلات (Drag and Drop UX)
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
// 📂 6. معالجة وفحص واستلام الملف المختار
// ==========================================
async function handleFileSelection(file) {
    if (isConverting) {
        cancelCurrentConversion();
    }

    cleanupPreviousFile();
    statusText.classList.remove("error-mode");

    const extension = (file.name.split(".").pop() || "").toLowerCase();
    const isVideoExtension = ["mp4", "webm", "mov", "mkv", "avi", "wmv", "flv", "m4v"].includes(extension);
    const isAudioExtension = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma"].includes(extension);

    // 1. التحقق من التوافق مع الوضع المختار
    if (currentMode === "video") {
        const isVideoMime = file.type.startsWith("video/");
        if (!isVideoMime && !isVideoExtension) {
            showError("تم رفض الملف! يرجى رفع ملف فيديو صالح في هذا التبويب.");
            return;
        }
    } else {
        const isAudioMime = file.type.startsWith("audio/");
        if (!isAudioMime && !isAudioExtension) {
            showError("تم رفض الملف! يرجى رفع ملف صوتي صالح في هذا التبويب.");
            return;
        }
    }

    // 2. التحقق من حجم الملف
    const sizeInMB = file.size / (1024 * 1024);
    if (sizeInMB > MAX_FILE_SIZE_MB) {
        showError(`الملف كبير جدًا للمعالجة داخل المتصفح (${sizeInMB.toFixed(1)} ميجابايت). الحد الأقصى المسموح هو ${MAX_FILE_SIZE_MB} ميجابايت لحماية ذاكرة جهازك.`);
        return;
    }

    // 3. التحقق من مدة الملف لحماية المتصفح من التجمد
    try {
        const durationSec = await checkMediaDuration(file);
        if (durationSec && durationSec > (MAX_DURATION_MINUTES * 60)) {
            const minutes = Math.round(durationSec / 60);
            showError(`مدة الملف (${minutes} دقيقة) تتجاوز الحد الآمن للمعالجة داخل المتصفح (${MAX_DURATION_MINUTES} دقيقة).`);
            return;
        }
    } catch (_) {
        // إذا لم يدعم المتصفح قراءة المدة مسبقاً، نترك FFmpeg يتولى ذلك
    }

    // حفظ الملف كملف حالي
    currentFile = file;

    // تحديث بطاقة التفاصيل
    fileDetailsCard.style.display = "block";
    detailName.innerText = file.name;
    detailSize.innerText = `${sizeInMB.toFixed(2)} ميجابايت`;
    fileTypeIcon.innerText = currentMode === "video" ? "🎬" : "🎵";

    uploadText.innerText = "تم اختيار الملف بنجاح! 🎉";
    statusText.innerText = "الحالة: جاهز تماماً لبدء التحويل الحقيقي.";

    progressContainer.style.display = "none";
    updateProgress(0, "");

    if (currentMode === "video") {
        captureVideoThumbnail(file);
    } else {
        previewThumbnailContainer.style.display = "none";
    }
}

// فحص مدة الميديا باستخدام عنصر صوت/فيديو محلي مؤقت
function checkMediaDuration(file) {
    return new Promise((resolve, reject) => {
        const isVideo = file.type.startsWith("video/") || ["mp4", "webm", "mov", "mkv"].includes((file.name.split(".").pop() || "").toLowerCase());
        const mediaElem = document.createElement(isVideo ? "video" : "audio");
        const url = URL.createObjectURL(file);
        mediaElem.preload = "metadata";

        const cleanup = () => {
            URL.revokeObjectURL(url);
            mediaElem.removeAttribute("src");
            mediaElem.load();
        };

        mediaElem.onloadedmetadata = () => {
            const dur = mediaElem.duration;
            cleanup();
            resolve(dur);
        };

        mediaElem.onerror = () => {
            cleanup();
            reject(new Error("Cannot read metadata"));
        };

        mediaElem.src = url;
    });
}

// ==========================================
// 📸 7. استخراج غلاف الفيديو وعرضه مع تنظيف الذاكرة
// ==========================================
function captureVideoThumbnail(file) {
    statusText.innerText = "الحالة: جاري توليد صورة معاينة للفيديو...";

    const video = document.createElement("video");
    const videoUrl = URL.createObjectURL(file);
    video.src = videoUrl;
    video.muted = true;
    video.playsInline = true;

    video.onloadeddata = () => {
        // الانتقال لثانية 1 أو منتصف الفيديو إذا كان قصيراً جداً
        video.currentTime = Math.min(1, Math.max(0, video.duration / 2));
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
                if (blob) {
                    currentThumbnailUrl = URL.createObjectURL(blob);
                    videoPreview.src = currentThumbnailUrl;
                    previewThumbnailContainer.style.display = "block";
                }
            }, "image/jpeg", 0.7);
        } catch (e) {
            console.warn("Could not capture thumbnail:", e);
        } finally {
            URL.revokeObjectURL(videoUrl);
            video.removeAttribute("src");
            video.load();
            statusText.innerText = "الحالة: جاهز ومستعد للتحويل.";
        }
    };

    video.onerror = () => {
        URL.revokeObjectURL(videoUrl);
        video.removeAttribute("src");
        video.load();
        previewThumbnailContainer.style.display = "none";
        statusText.innerText = "الحالة: جاهز ومستعد للتحويل.";
    };
}

// ==========================================
// 🚀 8. بدء عملية التحويل الحقيقية
// ==========================================
convertBtn.addEventListener("click", async () => {
    if (isConverting) return;

    if (!currentFile) {
        showError(currentMode === "video" ? "قم باختيار أو سحب ملف فيديو أولاً!" : "قم باختيار أو سحب ملف صوتي أولاً!");
        return;
    }

    const chosenFormat = formatSelect.value;
    const currentExt = (currentFile.name.split(".").pop() || "").toLowerCase();

    // التحذير إذا كان الملف الصوتي بالفعل بالصيغة المطلوبة
    if (currentMode === "audio" && currentExt === chosenFormat) {
        showError(`عذراً! الملف الذي اخترته هو بالفعل بصيغة (${chosenFormat.toUpperCase()}). اختر صيغة أخرى.`);
        return;
    }

    // تفعيل حالة التحويل وقفل الزر
    isConverting = true;
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

    statusText.innerText = "الحالة: جاري إرسال الملف لمحرك التحويل...";
    progressContainer.style.display = "flex";
    updateProgress(5, "جاري تحضير الملف...");

    try {
        initWorker();

        // قراءة الملف كـ ArrayBuffer
        const arrayBuffer = await currentFile.arrayBuffer();

        // إرسال البيانات إلى الـ Worker مع نقل الملكية (Zero-copy transfer)
        converterWorker.postMessage(
            {
                action: "convert",
                fileData: arrayBuffer,
                fileName: currentFile.name,
                chosenFormat: chosenFormat
            },
            [arrayBuffer]
        );
    } catch (err) {
        console.error("Conversion start error:", err);
        handleConversionError("تعذر قراءة الملف من الذاكرة. حاول مرة أخرى.");
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
    if (!isConverting && !converterWorker) return;

    // إنهاء الـ Worker فورياً لوقف تشغيل الـ WebAssembly وحرية الذاكرة
    terminateWorker();

    clearInterval(phraseInterval);
    phraseInterval = null;
    isConverting = false;

    restoreConvertButton();
    if (cancelBtn) cancelBtn.style.display = "none";
    progressContainer.style.display = "none";
    updateProgress(0, "");

    // إعادة تهيئة Worker جديد ونظيف في الخلفية
    initWorker();
}

// ==========================================
// 🎉 10. معالجة نجاح التحويل وتنزيل الملف الحقيقي
// ==========================================
function handleConversionSuccess(data) {
    clearInterval(phraseInterval);
    phraseInterval = null;
    isConverting = false;

    updateProgress(100, "اكتمل التحويل بنجاح! 🚀");

    if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
        currentBlobUrl = null;
    }

    // إنشاء الـ Blob الحقيقي بالصيغة والـ MIME type المعتمد
    const realBlob = new Blob([data.outputBuffer], { type: data.mimeType });
    currentBlobUrl = URL.createObjectURL(realBlob);

    // تفعيل التنزيل الفوري التلقائي
    const downloadLink = document.createElement("a");
    downloadLink.href = currentBlobUrl;
    downloadLink.download = data.outputFileName;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);

    statusText.innerText = `تم التحويل إلى ملف ${data.chosenFormat.toUpperCase()} حقيقي بنجاح وتم بدء التنزيل! 🎉`;
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

    statusText.innerText = "الحالة: " + message;
    statusText.classList.add("error-mode");
    progressContainer.style.display = "none";

    restoreConvertButton();
    if (cancelBtn) cancelBtn.style.display = "none";
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
