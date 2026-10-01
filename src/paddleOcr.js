import { PaddleOcrService } from 'ppu-paddle-ocr/web';

let paddleServiceInstance = null;
let paddleInitPromise = null;

export async function getPaddleOcrService() {
  if (paddleServiceInstance) return paddleServiceInstance;
  if (paddleInitPromise) return paddleInitPromise;

  paddleInitPromise = (async () => {
    console.log('[PaddleOCR] Menginisialisasi PP-OCRv6 Web Service...');
    
    const service = new PaddleOcrService({
      model: {
        detection: '/models/PP-OCRv6_tiny_det.ort',
        recognition: '/models/PP-OCRv6_tiny_rec.ort',
        charactersDictionary: '/models/ppocrv6_tiny_dict.txt',
      },
      processing: {
        engine: 'canvas-native',
      },
      recognition: {
        strategy: 'per-line',
        rotateVerticalCrops: true,
        spaceRecovery: true,
      }
    });

    await service.initialize();
    paddleServiceInstance = service;
    console.log('[PaddleOCR] Model PP-OCRv6 siap digunakan!');
    return service;
  })();

  return paddleInitPromise;
}

/**
 * Recognize text from image using PaddleOCR Web (Deep Learning)
 * @param {string|HTMLCanvasElement|Blob} imageSource 
 * @returns {Promise<string>} Combined text
 */
export async function runPaddleOcr(imageSource) {
  const service = await getPaddleOcrService();
  
  let canvas;
  if (imageSource instanceof HTMLCanvasElement) {
    canvas = imageSource;
  } else {
    // Convert dataUrl/blob to Canvas
    const img = new Image();
    img.src = typeof imageSource === 'string' ? imageSource : URL.createObjectURL(imageSource);
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });

    canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
  }

  const result = await service.recognize(canvas);
  console.log('[PaddleOCR] Full Result:', result);
  
  // result.text is the extracted text
  return result.text || '';
}
