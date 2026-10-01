import { createWorker } from 'tesseract.js';

let tesseractWorker = null;
let tesseractInitPromise = null;

/**
 * Inisialisasi Tesseract Worker
 */
export async function getTesseractWorker(onProgress) {
  if (tesseractWorker) return tesseractWorker;
  if (tesseractInitPromise) return tesseractInitPromise;

  tesseractInitPromise = (async () => {
    console.log('[Tesseract] Menginisialisasi worker (ind+eng)...');
    const worker = await createWorker('ind+eng', 1, {
      logger: m => {
        if (onProgress && m.status === 'recognizing text') {
          onProgress(Math.round((m.progress || 0) * 100));
        }
        console.log('[Tesseract Progress]', m);
      }
    });
    tesseractWorker = worker;
    console.log('[Tesseract] Worker siap digunakan!');
    return worker;
  })();

  return tesseractInitPromise;
}

/**
 * Jalankan Tesseract OCR di browser (client-side backup)
 * @param {string|HTMLCanvasElement|Blob} imageSource 
 * @param {Function} [onProgress] 
 * @returns {Promise<string>} Hasil teks OCR
 */
export async function runTesseractOcr(imageSource, onProgress) {
  console.log('[Tesseract] Memulai OCR backup di browser...');
  const t0 = performance.now();
  const worker = await getTesseractWorker(onProgress);
  const result = await worker.recognize(imageSource);
  const t1 = performance.now();
  const duration = Math.round(t1 - t0);
  console.log(`[Tesseract] Selesai membaca dalam ${duration} ms! Teks:\n`, result.data.text);
  return {
    text: result.data.text || '',
    durationMs: duration
  };
}
