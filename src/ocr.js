import { runPaddleOcr, getPaddleOcrService } from './paddleOcr.js';
import { runTesseractOcr } from './tesseractOcr.js';
import { discoverServer } from './serverDiscovery.js';

// PDF.js is loaded via CDN in index.html to avoid bundling issues
// The library exposes 'pdfjsLib' to window
const pdfjsLib = window.pdfjsLib;

if (pdfjsLib) {
  // Use a local worker version for offline capability
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
}


/**
 * Helper to parse Indonesian/US money strings, handling decimal cents (e.g., ,00 or .00)
 */
function parseMoneyString(str) {
  if (!str) return '0';
  let clean = str.trim().replace(/,\d{2}$/, ''); // Strip Indonesian cents (e.g. ,00)
  clean = clean.replace(/\.\d{2}$/, '');       // Strip US cents (e.g. .00)
  clean = clean.replace(/[^0-9]/g, '');         // Remove all non-digits
  return clean;
}

/**
 * Get configured PC Server URL
 */
export function getPcServerUrl() {
  const saved = localStorage.getItem('pcServerUrl');
  if (saved && saved.trim()) {
    return saved.trim().replace(/\/+$/, '');
  }
  // If running on localhost or 127.0.0.1, use relative origin
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return '';
  }
  return '';
}

/**
 * Save configured PC Server URL
 */
export function setPcServerUrl(url) {
  const clean = (url || '').trim().replace(/\/+$/, '');
  if (clean) {
    localStorage.setItem('pcServerUrl', clean);
  } else {
    localStorage.removeItem('pcServerUrl');
  }
  return clean;
}

/**
 * Check if the PC server is online and responding
 */
export async function checkPcServerHealth(serverUrl = getPcServerUrl(), timeoutMs = 2500) {
  const base = serverUrl || '';
  const url = base ? `${base}/api/health` : '/api/health';
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 
        'Accept': 'application/json',
        'bypass-tunnel-reminder': 'true' // Bypass Localtunnel warning page
      }
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      // Must validate JSON body - Vercel rewrites /api/health to index.html (HTTP 200 but HTML)
      // Only treat as online if the JSON body explicitly has online: true
      const data = await response.json().catch(() => null);
      if (data && data.online === true) {
        return { online: true, engine: data.engine || 'PaddleOCR Native PC Server' };
      }
      return { online: false, error: 'URL bukan Server PC yang valid (tidak ada respons JSON yang sesuai)' };
    }
    return { online: false, error: `HTTP ${response.status}` };
  } catch (err) {
    return { online: false, error: err.name === 'AbortError' ? 'Koneksi timeout' : err.message };
  }
}

/**
 * Resize image if too large to speed up network transfer and processing
 */
export async function resizeImageForOcr(dataUrl, maxDimension = 1400) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let width = img.width;
      let height = img.height;
      if (width <= maxDimension && height <= maxDimension) {
        resolve(dataUrl);
        return;
      }
      if (width > height) {
        height = Math.round((height * maxDimension) / width);
        width = maxDimension;
      } else {
        width = Math.round((width * maxDimension) / height);
        height = maxDimension;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/**
 * Perform OCR on an image and extract PLN receipt data
 * Automatically prioritizes PC PaddleOCR, falls back to Tesseract OCR if PC is offline.
 * @param {string|Blob|File} imageSource 
 * @param {string} mode - 'token', 'tagihan-pln', or 'payment'
 * @param {Function} [onStatusUpdate]
 */
export async function processReceipt(imageSource, mode = 'token', onStatusUpdate = null) {
  // 1. Optimize image before sending over local Wi-Fi to PC server
  let optimizedSource = imageSource;
  if (typeof imageSource === 'string' && imageSource.startsWith('data:image')) {
    try {
      optimizedSource = await resizeImageForOcr(imageSource, 1400);
    } catch (e) {
      console.warn('Image optimization error:', e);
    }
  }

  const serverUrl = getPcServerUrl();
  const paddleEndpoint = serverUrl ? `${serverUrl}/api/paddle-ocr` : '/api/paddle-ocr';

  let ocrText = '';
  let engineUsed = '';
  let duration = 0;
  let serverAvailable = false;

  // 2. Try Primary: PaddleOCR on PC Server
  try {
    if (onStatusUpdate) onStatusUpdate('Menghubungi Server PC (PaddleOCR)...');
    console.log(`[OCR Client] Mencoba request PaddleOCR ke PC Server: ${paddleEndpoint}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6500); // 6.5s timeout for PC server

    const response = await fetch(paddleEndpoint, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'bypass-tunnel-reminder': 'true' // Bypass Localtunnel warning page
      },
      body: JSON.stringify({ image: optimizedSource }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || ('Server error ' + response.status));
    }

    const json = await response.json();
    if (!json.success) {
      throw new Error(json.error || 'Server PaddleOCR gagal mengekstrak teks.');
    }

    ocrText = json.text;
    duration = json.durationMs || 0;
    engineUsed = `PaddleOCR (${duration} ms)`;
    serverAvailable = true;
    console.log(`[OCR Client] Respon berhasil dari Server PC (${duration} ms)`);
  } catch (error) {
    console.warn('[OCR Client] Server PC gagal dihubungi di', paddleEndpoint, error.message);
    serverAvailable = false;

    // Otomatis cari IP server baru jika PC berubah IP tanpa perlu tombol / campur tangan pengguna
    try {
      if (onStatusUpdate) onStatusUpdate('🔍 Mendeteksi IP baru Server PC otomatis...');
      const discoveredUrl = await discoverServer(null, { failedUrl: serverUrl });
      if (discoveredUrl) {
        console.log('[OCR Client] Server PC ditemukan di IP baru:', discoveredUrl);
        setPcServerUrl(discoveredUrl);
        if (typeof window !== 'undefined' && typeof window.__onServerDiscovered === 'function') {
          window.__onServerDiscovered(discoveredUrl);
        }

        if (onStatusUpdate) onStatusUpdate('Mengirim ke IP baru Server PC...');
        const retryEndpoint = `${discoveredUrl}/api/paddle-ocr`;
        const retryController = new AbortController();
        const retryTimeout = setTimeout(() => retryController.abort(), 6500);

        const retryRes = await fetch(retryEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'bypass-tunnel-reminder': 'true'
          },
          body: JSON.stringify({ image: optimizedSource }),
          signal: retryController.signal
        });
        clearTimeout(retryTimeout);

        if (retryRes.ok) {
          const json = await retryRes.json();
          if (json.success) {
            ocrText = json.text;
            duration = json.durationMs || 0;
            engineUsed = `PaddleOCR (${duration} ms)`;
            serverAvailable = true;
            console.log(`[OCR Client] Berhasil diproses oleh Server PC IP baru (${duration} ms)`);
          }
        }
      }
    } catch (discoveryErr) {
      console.warn('[OCR Client] Auto-scan IP baru tidak menemukan server:', discoveryErr.message);
    }

    if (!serverAvailable && typeof window !== 'undefined' && typeof window.__triggerServerAutoDiscovery === 'function') {
      window.__triggerServerAutoDiscovery();
    }
  }

  // 3. Automatic Fallback to In-Browser Tesseract OCR if PC Server is offline
  if (!serverAvailable) {
    if (onStatusUpdate) onStatusUpdate('⚠️ Server PC Offline. Menggunakan Tesseract OCR (Backup)...');
    console.log('[OCR Client] Server PC offline. Memulai Tesseract OCR di browser sebagai cadangan...');

    try {
      const tesseractResult = await runTesseractOcr(imageSource, (pct) => {
        if (onStatusUpdate) onStatusUpdate(`Memproses Tesseract OCR... ${pct}%`);
      });

      ocrText = tesseractResult.text;
      duration = tesseractResult.durationMs;
      engineUsed = `Tesseract (${duration} ms)`;
    } catch (tessErr) {
      console.error('[OCR Client] Tesseract Error:', tessErr);
      throw new Error(`Server PC offline dan Tesseract OCR gagal: ${tessErr.message}`);
    }
  }

  const parsed = (mode === 'payment') ? parsePaymentText(ocrText) : parsePLNText(ocrText);
  parsed.usedEngine = engineUsed;
  parsed.durationMs = duration;
  parsed.isServerOnline = serverAvailable;
  return parsed;
}

/**
 * Parse raw text into structured PLN object
 * @param {string} text 
 */
function parsePLNText(text) {
  const result = {
    token: '',
    idpel: '',
    nama: '',
    tarif: '',
    kwh: '',
    nominal: '',
    tagihan: '',
    admin: '',
    total: '',
    ppn: '0',
    angsmat: '0,00/0,00',
    noPesanan: '', 
    stand: '',
    denda: '0',
    raw: text
  };

  // 0. Extract No Pesanan (Order Number)
  const noPesananMatch = text.match(/(?:No\.?\s*Pesanan|Nomor\s*Pesanan|Order\s*No)\s*[:]?\s*([A-Z0-9]+)/i);
  if (noPesananMatch) {
    result.noPesanan = noPesananMatch[1].trim();
  }

  // 1. Extract Token (20 digits) using robust multi-tier extraction
  result.token = extractTokenFromText(text);

  // 2. Extract IDPEL / Nomor Pelanggan
  const idpelMatch = text.match(/Nomor Pelanggan\s*(\d{11,12})/i) ||
                     text.match(/IDPEL\s*[:]?\s*(\d{11,12})/i) ||
                     text.match(/ID\s*PEL\s*[:]?\s*(\d{11,12})/i);
  if (idpelMatch) {
    result.idpel = idpelMatch[1];
  }

  // 3. Extract Nama
  // 3a. Tier 1: Ambil teks setelah label NAMA hingga sebelum TARIF/DAYA (atau label berikutnya)
  let namaMatch = text.match(/Nama\s*[:]?\s*([\s\S]+?)(?=\s*(?:Tarif\/Daya|Tarif Daya|IDPEL|Nomor|Stroom|Total|No\.\s*Pesanan|No\.\s*Meter|Bulan|Periode|$))/i);
  
  // 3b. Tier 2: Aturan di antara IDPEL (11-12 digit) dan TARIF/DAYA
  if (!namaMatch && result.idpel) {
    const betweenIdpelAndTarif = new RegExp(`${result.idpel}\\s*([\\s\\S]+?)(?=\\s*(?:Tarif\\/Daya|Tarif\\s*Daya|Tarif|R[\\d\\w]))`, 'i');
    namaMatch = text.match(betweenIdpelAndTarif);
  }

  if (namaMatch) {
    let cleanNama = namaMatch[1].trim()
      .replace(/[\r\n]+/g, ' ')
      .replace(/^(?:NAMA\s*[:\-]?\s*)/i, '')
      .replace(/\s+/g, ' ')
      .replace(/^[:\-.\s]+/, '')
      .replace(/[:\-.\s]+$/, '');
    result.nama = cleanNama;
  }

  // 4. Extract Tarif/Daya
  // Robust Strategy: Capture widely, then sanitize.
  
  // Try to find specific pattern R../... VA first (most reliable)
  // Updated to support decimals like 900.00
  let tarifMatch = text.match(/(R[\d\w]+\s*\/[\s\d.]+\s*VA)/i);
  
  if (!tarifMatch) {
    // Fallback: Look for label. 
    // Use word boundaries \b to avoid matching "HIDAYAT" as "DAYA"
    tarifMatch = text.match(/\b(?:Tarif\/Daya|Tarif Daya|Tarif|Daya)\s*[:]?\s*([A-Z0-9\/\s.-]+)/i);
  }

  if (tarifMatch) {
    let raw = tarifMatch[1] ? tarifMatch[1] : tarifMatch[0];
    // Sanitize: 
    // 1. Normalize spaces
    let clean = raw.replace(/\s+/g, ' ').trim();
    
    // 2. Remove redundant labels if they got caught (e.g. "Tarif Daya R1M")
    clean = clean.replace(/^(Tarif\/Daya|Tarif Daya|Tarif|Daya)\s*/i, '');

    // 3. Stop at common garbage words
    clean = clean.replace(/\s(No|Ref|Nomor|Jam).*$/i, '');
    
    // Final Polish: Ensure VA suffix exists if it looks like a power value
    if (clean && !clean.toUpperCase().includes('VA') && /[\d]/.test(clean)) {
        clean += ' VA';
    }
    
    result.tarif = clean.trim();
  }
  // 5. Extract KWh
  const kwhMatch = text.match(/(?:Jumlah|Jml|Total)\s*(?:K\s*W\s*H|KWH|KwH)\s*[:.]?\s*([\d,.]+)/i) || 
                   text.match(/([\d,.]+)\s*(?:k\s*w\s*h|kwh)/i);

  if (kwhMatch) {
    let rawKwh = kwhMatch[1].trim();
    if (rawKwh.includes(',') || rawKwh.includes('.')) {
      result.kwh = rawKwh.replace('.', ',');
    } else {
      let val = rawKwh.replace(/[^0-9]/g, '');
      if (val.length === 2) {
          result.kwh = val + ',0';
      } else if (val.length >= 3) {
          const num = parseInt(val);
          const scaled = (num / 100).toFixed(1).replace('.', ',');
          result.kwh = scaled;
      } else {
          result.kwh = val;
      }
    }
  }

  // 5.5 Extract Periode (for Postpaid)
  // Look for specific patterns like "BULAN/TAHUN" or months
  const periodeLabelMatch = text.match(/(?:Bulan|Periode)(?:\s*tagihan)?\s*[:]?\s*(\d{2}[/-]\d{4})/i) ||
                            text.match(/(?:Bulan|Periode)(?:\s*tagihan)?\s*[:]?\s*([A-Za-z]+\s*20\d{2})/i) ||
                            text.match(/(?:Bulan|Periode)(?:\s*tagihan)?\s*[:]?\s*(\d{4}[/-]\d{2})/i);
  if (periodeLabelMatch) {
    result.periode = periodeLabelMatch[1].trim();
  }

  // 6. Extract Nominal (Rp Stroom/Token)
  // Relaxed: Look for main nominal amount which is usually the largest Rp value aside from the total, 
  // or specifically labeled Rp Stroom
  const nominalMatch = text.match(/(?:Rp Stroom\/Token|Stroom\/Token|Nilai Token)\s*[:]?\s*Rp?[\s.]*([\d,.]+)/i) ||
                       text.match(/NOMINAL\s*[:]\s*Rp?[\s.]*([\d,.]+)/i);
  
  if (nominalMatch) {
    result.nominal = snapToNearestPLN(parseMoneyString(nominalMatch[1]));
  } else {
    // Fallback: Smart Guess - Look for 20k, 50k, 100k patterns in text if label is missing
    // We look for isolated numbers that match known denominations
    const rawDigits = text.replace(/[^0-9\s]/g, ' ');
    const possible = rawDigits.match(/\b(20000|50000|100000|200000|500000|1000000)\b/);
    if (possible) {
        result.nominal = possible[1];
    }
  }

  // 7. Extract Admin (Biaya Admin)
  const adminMatch = text.match(/(?:Biaya Admin|ADMIN BANK|ADMIN)\s*[:]?\s*Rp?[\s.]*([\d,.]+)/i);
  if (adminMatch) {
    result.admin = parseMoneyString(adminMatch[1]);
  }

  // 8. Extract Total Tagihan & Total Bayar
  // Robust Strategy: Capture everything after label until next newline or label
  const tagihanLabelPattern = /(?:Total\s*Tagihan|Tagihan)\s*[:]?\s*Rp?[\s.]*([\d,.]+)/i;
  const tagihanMatch = text.match(tagihanLabelPattern);
  if (tagihanMatch) {
    result.tagihan = parseMoneyString(tagihanMatch[1]);
  }

  const totalLabelPattern = /(?:Total\s*Bayar|Jumlah\s*Bayar|RP\s*BAYAR|TOTAL)\s*[:]?\s*Rp?[\s.]*([\d,.]+)/i;
  const totalMatch = text.match(totalLabelPattern);
  if (totalMatch) {
    result.total = totalMatch[1].trim();
  }

  // 8.5 Extract Stand Meter
  // Prune output before common next labels
  const standMatch = text.match(/Stand Meter\s*[:]?\s*([A-Z0-9-/ ]+?)(?=\s*(?:Periode|No|Total|Rp|$))/i);
  if (standMatch) {
    result.stand = standMatch[1].trim();
  }

  // 8.6 Extract Denda
  const dendaMatch = text.match(/Denda\s*Rp?[\s.]*([\d,.]+)/i);
  if (dendaMatch) {
    result.denda = parseMoneyString(dendaMatch[1]);
  }

  // 9. Extract PPN
  const ppnMatch = text.match(/PPn\s*Rp?([\d,.]+)/i);
  if (ppnMatch) {
    result.ppn = parseMoneyString(ppnMatch[1]);
  }

  // Final sanitization for all results
  Object.keys(result).forEach(key => {
    if (typeof result[key] === 'string' && key !== 'raw') {
        result[key] = cleanValue(result[key]);
    }
  });

  return result;
}

/**
 * Extract 20-digit PLN Token from raw text with high precision.
 * Handles OCR noise, delimiters, and letter-to-digit typos.
 * @param {string} text
 * @returns {string} 20 digits token string
 */
export function extractTokenFromText(text) {
  if (!text) return '';

  // Normalisasi awal: ganti karakter OCR yang sering tertukar dengan spasi/digit yang benar
  // PENTING: Jangan replace l/I/O di sini secara global — hanya lakukan di konteks digit (Tier 4)
  let normalizedText = text.replace(/[|¦\[\]{}]/g, ' ');

  // ── TIER 1: Cari di antara label STROOM/TOKEN dan label berikutnya ───────────
  // Strategi: ambil teks SETELAH label token hingga sebelum label berikutnya
  // Khusus format ShopeePay: "STROOM/TOKEN   4942 7804 7776 2675 9609"
  //                         (nilai berada di baris yang sama, kolom kanan)
  const betweenMatch = normalizedText.match(
    /(?:Stroom\/Nomor\s*Token|Stroom\/Token|Kode\s*Token|No\.?\s*Token|PLN\s*Token|Stroom|Token)\s*[:.-]?\s*([\s\S]+?)(?=\s*(?:ADMIN\s*BANK|ADMIN|KB\s*BUKOPIN|INFORMASI|TOTAL|RP\s*BAYAR|BAYAR|$))/i
  );
  if (betweenMatch) {
    const section = betweenMatch[1].trim();
    // 1a. 5 blok 4 digit (dengan satu atau lebih pemisah: spasi, titik, strip)
    const m5x4 = section.match(/(\d{4})[\s.-]+(\d{4})[\s.-]+(\d{4})[\s.-]+(\d{4})[\s.-]+(\d{4})/);
    if (m5x4) {
      return `${m5x4[1]}${m5x4[2]}${m5x4[3]}${m5x4[4]}${m5x4[5]}`;
    }
    // 1b. 5 blok 4 digit tanpa pemisah (rapat)
    const m5x4tight = section.match(/(\d{4})[\s.-]*(\d{4})[\s.-]*(\d{4})[\s.-]*(\d{4})[\s.-]*(\d{4})/);
    if (m5x4tight) {
      const token = `${m5x4tight[1]}${m5x4tight[2]}${m5x4tight[3]}${m5x4tight[4]}${m5x4tight[5]}`;
      if (token.length === 20) return token;
    }
    // 1c. 20 digit berurutan
    const digitsOnly = section.replace(/[^0-9]/g, '');
    if (digitsOnly.length === 20) return digitsOnly;
  }

  // ── TIER 2: Cari di baris setelah label STROOM/TOKEN (cocok untuk format tabel) ──
  // Format ShopeePay sering menempatkan nilai di baris yang sama setelah beberapa spasi
  const labelLineMatch = normalizedText.match(
    /(?:Stroom\/Nomor\s*Token|Stroom\/Token|Kode\s*Token|No\.?\s*Token|PLN\s*Token|Stroom|Token)\s*[:.-]?\s*([^\n\r]+)/i
  );
  if (labelLineMatch) {
    const lineAfterLabel = labelLineMatch[1].trim();
    // Cek 5 blok 4 digit di baris yang sama
    const line5x4 = lineAfterLabel.match(/(\d{4})[\s.-]+(\d{4})[\s.-]+(\d{4})[\s.-]+(\d{4})[\s.-]+(\d{4})/);
    if (line5x4) {
      return `${line5x4[1]}${line5x4[2]}${line5x4[3]}${line5x4[4]}${line5x4[5]}`;
    }
    // Cek 20 digit berurutan di baris yang sama
    const line20 = lineAfterLabel.replace(/[^0-9]/g, '');
    if (line20.length === 20) return line20;
    if (line20.length > 20) {
      const sub5x4 = lineAfterLabel.match(/(\d{4})[\s.-]*(\d{4})[\s.-]*(\d{4})[\s.-]*(\d{4})[\s.-]*(\d{4})/);
      if (sub5x4) return `${sub5x4[1]}${sub5x4[2]}${sub5x4[3]}${sub5x4[4]}${sub5x4[5]}`;
    }
  }

  // ── TIER 3: Cari 5 blok 4 digit di seluruh teks ────────────────────────────
  const exact5x4Match = normalizedText.match(/\b(\d{4})[\s.-]+(\d{4})[\s.-]+(\d{4})[\s.-]+(\d{4})[\s.-]+(\d{4})\b/);
  if (exact5x4Match) {
    const token = `${exact5x4Match[1]}${exact5x4Match[2]}${exact5x4Match[3]}${exact5x4Match[4]}${exact5x4Match[5]}`;
    if (token.length === 20) return token;
  }

  // ── TIER 4: Cari 20 digit berurutan di seluruh teks ────────────────────────
  const exact20Match = normalizedText.match(/\b(\d{20})\b/);
  if (exact20Match) return exact20Match[1];

  // ── TIER 5: Fallback — koreksi OCR typo (O→0, l/I→1) lalu ulangi pencarian ─
  // Hanya terapkan substitusi pada area yang kemungkinan berisi token (20-35 karakter alfanumerik)
  const sanitizedText = normalizedText.replace(/([0-9OIlo\s.-]{18,35})/g, (m) => {
    return m.replace(/[Oo]/g, '0').replace(/[Il]/g, '1');
  });
  const fallback5x4 = sanitizedText.match(/\b(\d{4})[\s.-]+(\d{4})[\s.-]+(\d{4})[\s.-]+(\d{4})[\s.-]+(\d{4})\b/);
  if (fallback5x4) {
    return `${fallback5x4[1]}${fallback5x4[2]}${fallback5x4[3]}${fallback5x4[4]}${fallback5x4[5]}`;
  }

  // ── TIER 6: Fallback — 20 digit setelah koreksi typo ───────────────────────
  const fallback20 = sanitizedText.match(/\b(\d{20})\b/);
  if (fallback20) return fallback20[1];

  return '';
}

/**
 * Global Sanitizer: Removes common labels that often get caught in OCR
 * @param {string} val 
 */
function cleanValue(val) {
  if (!val) return '';
  let clean = val.replace(/\s+/g, ' ').trim();
  
  // List of labels to strip from the START of results
  const labelsToRemove = [
    /^T\s/i, // Prefix "T " like in user's error
    /^(Nama|Tarif\/Daya|Tarif Daya|Tarif|Daya|IDPEL|Nomor Pelanggan|Nomor Meter|No\.\s*Ref|No|Ref|Stroom|Token)\s*[:.-]?\s*/i,
    /^(Rp|RP)\.?\s*/i
  ];

  labelsToRemove.forEach(pattern => {
    clean = clean.replace(pattern, '');
  });

  return clean.trim();
}

/**
 * Parse raw text into structured Payment (PDAM) object
 * @param {string} text 
 */
function parsePaymentText(text) {
  const result = {
    mode: 'payment',
    lokasi: '',
    nama: '',
    idpel: '',
    periode: '',
    stand: '', // optional
    tagihan: '',
    admin: '',
    total: '',
    noPesanan: '', 
    raw: text
  };

  // 1. Extract Lokasi
  // Looks for common patterns like "PDAM ...", "KAB ...", "KOTA ..."
  // or takes the first meaningful line if it looks like a header
  // User Feedback: "KAB. SOLOK No" -> Remove " No"
  const lokasiMatch = text.match(/(?:PDAM|PERUMDA|TIRTA)\s+([A-Z\s.]+)/i) || 
                      text.match(/(?:KAB\.|KOTA)\s+([A-Z\s.]+)/i);
  
  if (lokasiMatch) {
     let val = lokasiMatch[0].trim();
     // Clean suffix " No", " Nomor", etc if captured accidentally
     result.lokasi = val.replace(/\s(No|Nomor|Pelanggan).*$/i, '').trim();
  } else {
     // Fallback: Take first non-empty line that isn't a date
     const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 3);
     if (lines.length > 0 && !lines[0].match(/\d{4}-\d{2}-\d{2}/)) {
        result.lokasi = lines[0].replace(/\s(No|Nomor|Pelanggan).*$/i, '').trim();
     }
  }

  // 2. Extract Nama
  // Robust Strategy: Capture EVERYTHING until the next known label
  const namaLabelPattern = /(?:\bNama Pelanggan|\bNama|\bNAMA\b)\s*[:]?\s*([\s\S]+?)(?=\s*(?:NO\.PEL|NO\. PEL|ID PEL|IDPEL|NO SAMB|NO\.SAMB|PERIODE|ALAMAT|TOTAL|TAGIHAN|Tarif\/Daya|Tarif Daya|$))/i;
  const namaMatch = text.match(namaLabelPattern);
  if (namaMatch) {
    result.nama = namaMatch[1].trim();
  }

  // 3. Extract IDPEL / No Sambungan
  const idpelMatch = text.match(/(?:Nomor|No\.|ID)\s*(?:Pelanggan|Sambungan|PEL|SAMB)\s*[:.]?\s*(\d+)/i) ||
                     text.match(/(\d{6,12})/); // Raw digits fallback
  if (idpelMatch) {
    result.idpel = idpelMatch[1].trim();
  }

  // 4. Extract Periode
  // Strategy: 
  // A. Look for specific labels first
  // B. Search for known date formats (Month Year)
  
  // 4. Extract Periode
  
  // A. Label Search
  // User Feedback: "Periode Tagihan" is a specific section.
  // We must match "Periode Tagihan" explicitly so "Tagihan" isn't treated as part of the value (and subsequently deleted by cleanup).
  const periodeLabelMatch = text.match(/(?:Periode Tagihan|Periode|Bulan|Thn\.Bln|Rekoning Bulan|Rek\.Bulan)\s*[:]?\s*([^\n\r]+)/i);
  if (periodeLabelMatch) {
    let raw = periodeLabelMatch[1].trim();
    
    // Clean potential trailing garbage labels, BUT be careful not to delete the value itself if it starts with 'Tagihan' (unlikely if label fixed)
    // We only remove if it looks like a separate label starting with "Tagihan:" or "Tagihan Rp" or similar noise at the END
    // Original aggressive replace was: raw = raw.replace(/\s*(?:Tagihan|Meter|Lalu|Kini|Stanst|Stand).*$/i, '');
    // New safer replace searches for known Next-Field labels
    raw = raw.replace(/\s+(?:Meter|Lalu|Kini|Stanst|Stand|Total).*$/i, '');
    
    // Also remove "Tagihan" if it appears as a suffix label match, e.g. "202512 Tagihan..."
    raw = raw.replace(/\s+Tagihan.*$/i, '');

    if ((/\d{4}/.test(raw) || /[A-Za-z]{3}/.test(raw)) && raw.length < 20) {
        result.periode = raw;
    }
  }

  // A.5 Global Search REMOVED as per user request ("tidak perlu mencari YYYYMM pada keseluruhan")

  // B. Fallback: Robust Date Pattern Search (Indonesian Months)
  // If no result yet, look for "JAN 2025", "MEI 25"
  if (!result.periode) {
     const indoMonths = 'JAN|FEB|MAR|APR|MEI|JUN|JUL|AGU|SEP|OKT|NOV|DES|JANUARI|FEBRUARI|MARET|APRIL|MEI|JUNI|JULI|AGUSTUS|SEPTEMBER|OKTOBER|NOVEMBER|DESEMBER';
     const datePattern = new RegExp(`\\b(${indoMonths})[\\s-]*(\\d{2,4})`, 'i');
     const dateMatch = text.match(datePattern);
     if (dateMatch) {
         result.periode = `${dateMatch[1]} ${dateMatch[2]}`.toUpperCase();
     }
  }
  
  // C. Fallback: Numeric patterns MM/YYYY
  if (!result.periode) {
     const mmyyyyMatch = text.match(/\b(0[1-9]|1[0-2])[\/-](20\d{2})\b/);
     if (mmyyyyMatch) {
         result.periode = formatIndoMonth(mmyyyyMatch[1]) + ' ' + mmyyyyMatch[2];
     }
  }

  // --- POST-PROCESSING PERIODE ---
  // Ensure we format "202512" -> "DESEMBER 2025" regardless of how it was captured (Label or Fallback)
  if (result.periode) {
      // Clean up common noise
      let clean = result.periode.replace(/\s*(?:Tagihan|Meter|Lalu|Kini|Stanst|Stand).*$/i, '').trim();
      
      // Check if it matches YYYYMM (ex: 202512)
      // Allow minor noise or spaces: 2025 12
      const yyyymmFormat = clean.match(/\b(20\d{2})\s?(0[1-9]|1[0-2])\b/); 
      if (yyyymmFormat) {
          const year = yyyymmFormat[1];
          const month = yyyymmFormat[2];
          clean = formatIndoMonth(month) + ' ' + year;
      }

      result.periode = clean.toUpperCase();
  }

  // 5. Extract Total Tagihan (before admin)
  // Usually labeled "Tagihan", "Jumlah Tagihan", "Total Air"

  // 5. Extract Total Tagihan (before admin)
  const tagihanMatch = text.match(/(?:Tagihan|Jml Tagihan|Total Air|Biaya Air|Total Tagihan)\s*[:]?\s*Rp?[\s.]*([\d,.]+)/i);
  if (tagihanMatch) {
    result.tagihan = parseMoneyString(tagihanMatch[1]);
  }

  // 6. Extract Admin (if present on receipt)
  const adminMatch = text.match(/(?:Biaya Admin|Admin|Adm)\s*[:]?\s*Rp?[\s.]*([\d,.]+)/i);
  if (adminMatch) {
     result.admin = parseMoneyString(adminMatch[1]);
  }

  // 7. Extract Total Bayar
  const totalMatch = text.match(/(?:Total Bayar|Total)\s*[:]?\s*Rp?[\s.]*([\d,.]+)/i);
  if (totalMatch) {
    result.total = parseMoneyString(totalMatch[1]);
  }
  
  // If we found tagihan but no total, default total = tagihan
  if (!result.total && result.tagihan) result.total = result.tagihan;
  // If we found total but no tagihan, default tagihan = total
  if (!result.tagihan && result.total) result.tagihan = result.total;

  // 8. Extract No Pesanan
  // Pattern: "No. Pesanan : 12345..." or "No Pesanan 12345..."
  const noPesananMatch = text.match(/(?:No\.?|Nomor)\s*Pesanan\s*[:]?\s*([A-Z0-9]+)/i);
  if (noPesananMatch) {
    result.noPesanan = noPesananMatch[1].trim();
  }

  // Final sanitization for all results
  Object.keys(result).forEach(key => {
    if (typeof result[key] === 'string' && key !== 'raw' && key !== 'mode' && key !== 'nama') {
        result[key] = cleanValue(result[key]);
    }
  });

  return result;
}

// Helper to extract text from PDF items
async function extractPdfText(page) {
  try {
    const textContent = await page.getTextContent();
    const strings = textContent.items.map(item => item.str);
    // Join with space, but preserve some formatting hints if possible
    return strings.join(' ').replace(/\s+/g, ' ');
  } catch (err) {
    console.error('Text extraction failed:', err);
    return null;
  }
}

/**
 * Helper: Extract text from PDF preserving line breaks (for table-style PDFs)
 */
async function extractPdfTextWithLines(page) {
  try {
    const textContent = await page.getTextContent();
    // Group items by their Y position to reconstruct rows/lines
    const lineMap = {};
    for (const item of textContent.items) {
      const y = Math.round(item.transform[5]); // Y coordinate
      if (!lineMap[y]) lineMap[y] = [];
      lineMap[y].push(item.str);
    }
    // Sort lines from top to bottom (descending Y in PDF coords)
    const sortedY = Object.keys(lineMap).map(Number).sort((a, b) => b - a);
    return sortedY.map(y => lineMap[y].join(' ')).join('\n');
  } catch (err) {
    console.error('Line text extraction failed:', err);
    return null;
  }
}

/**
 * Strategi "between-label": ambil teks di antara dua label anchor.
 * Mirip dengan: "nilai field = teks setelah label_awal dan sebelum label_akhir"
 * @param {string} text - seluruh teks PDF
 * @param {string|RegExp} startLabel - label pembuka (regex atau string)
 * @param {string|RegExp} endLabel   - label penutup (regex atau string)
 * @returns {string} nilai yang ditemukan, sudah di-trim
 */
function extractBetween(text, startLabel, endLabel) {
  // Bangun pola: (?:startLabel)\s*([\s\S]+?)\s*(?:endLabel)
  const startSrc = (startLabel instanceof RegExp) ? startLabel.source : escapeRegex(startLabel);
  const endSrc   = (endLabel   instanceof RegExp) ? endLabel.source   : escapeRegex(endLabel);
  const pattern  = new RegExp(startSrc + '\\s*([\\s\\S]+?)\\s*(?=' + endSrc + ')', 'i');
  const m = text.match(pattern);
  return m ? m[1].trim() : '';
}

/** Escape karakter regex spesial dalam string biasa */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parser untuk format struk web baru (mis. Sa Cell / Tokopedia PLN).
 * Menggunakan strategi "between-label": nilai diambil sebagai teks
 * DI ANTARA dua label anchor, sehingga nama/nilai dengan karakter
 * khusus, spasi, atau format tak biasa tetap tertangkap dengan benar.
 *
 * Contoh aturan Nama Pemilik:
 *   Teks: "Nama Pemilik 842tbnfjseb8v--/*-;''' Tarif/Daya R1 /1300"
 *   Aturan: antara "Nama Pemilik" dan "Tarif/Daya"
 *   Hasil: "842tbnfjseb8v--/*-;'''"
 *
 * @param {string} text - Teks mentah dari PDF
 * @returns {object|null} data terstruktur, atau null jika format tidak dikenali
 */
function parseNewFormatPdf(text) {
  // Deteksi format ini berdasarkan label khas
  const isNewFormat =
    /PLN\s*Meter\s*No/i.test(text) ||
    /Nama\s*Pemilik/i.test(text) ||
    /PLN\s*Token/i.test(text);

  if (!isNewFormat) return null;

  console.log('[NewFormat] Format baru terdeteksi, parsing dengan strategi between-label...');

  const result = {
    token: '',
    idpel: '',
    nama: '',
    tarif: '',
    kwh: '',
    nominal: '',
    tagihan: '',
    admin: '',
    total: '',
    ppn: '0',
    angsmat: '0,00/0,00',
    noPesanan: '',
    stand: '',
    denda: '',
    raw: text
  };

  // ─── 1. ID Pelanggan: antara "PLN Meter No" dan label berikutnya ─────────────
  result.idpel = extractBetween(
    text,
    /PLN\s*Meter\s*No/i,
    /Nama\s*Pemilik|Tarif\/Daya|Jumlah\s*KWH|PLN\s*Token|Nama\s*Pengguna|No\s*Telp|Email|Tagihan/i
  ).replace(/[^0-9]/g, ''); // Hanya digit

  // Fallback jika extractBetween gagal (PDFs yang menyatukan teks tanpa spasi antar label)
  if (!result.idpel) {
    const m = text.match(/PLN\s*Meter\s*No[\s:]*(\d{6,15})/i);
    if (m) result.idpel = m[1];
  }

  // ─── 2. Nama Pemilik: antara "Nama Pemilik" dan "Tarif/Daya" ─────────────────
  // ATURAN UTAMA: nilai = semua teks setelah "Nama Pemilik" sebelum "Tarif/Daya"
  // Contoh: "Nama Pemilik 842tbnfjseb8v--/*-;''' Tarif/Daya R1 /1300"
  //         → nama = "842tbnfjseb8v--/*-;'''"
  result.nama = extractBetween(
    text,
    /Nama\s*Pemilik/i,
    /Tarif\/Daya|Tarif\s*Daya|Jumlah\s*KWH|PLN\s*Token|Nama\s*Pengguna/i
  );

  // ─── 3. Tarif/Daya: antara "Tarif/Daya" dan label berikutnya ─────────────────
  result.tarif = extractBetween(
    text,
    /Tarif\s*\/\s*Daya/i,
    /Jumlah\s*KWH|PLN\s*Token|Nama\s*Pengguna|No\s*Telp|Email|Tagihan|Rincian/i
  );
  // Normalisasi: pastikan format "R1/1300" → "R1 /1300 VA" jika perlu
  if (result.tarif) {
    result.tarif = result.tarif.replace(/\s+/g, ' ').trim();
    // Tambahkan "VA" jika ada angka daya tapi belum ada satuan
    if (result.tarif && !result.tarif.toUpperCase().includes('VA') && /\/[\s]?\d+/.test(result.tarif)) {
      result.tarif += ' VA';
    }
  }

  // ─── 4. Jumlah KWH: antara "Jumlah KWH" dan label berikutnya ─────────────────
  const kwhRaw = extractBetween(
    text,
    /Jumlah\s*KWH/i,
    /PLN\s*Token|Nama\s*Pengguna|No\s*Telp|Email|Tagihan|Rincian/i
  );
  if (kwhRaw) {
    // Normalisasi: ganti koma desimal (format Indonesia "46,8") ke titik sebelum parseFloat
    // Tanpa ini: "46,8" → regex [^0-9.] membuang koma → "468" (salah)
    // Dengan ini: "46,8" → "46.8" → parseFloat → 46.8 (benar)
    const normalized = kwhRaw.trim().replace(',', '.');   // "46,8" → "46.8" | "66.00" → tetap
    const numKwh = parseFloat(normalized.replace(/[^0-9.]/g, ''));
    result.kwh = isNaN(numKwh) ? kwhRaw : numKwh.toFixed(2).replace('.', ',');
  }

  // ─── 5. PLN Token: antara "PLN Token" dan label berikutnya ───────────────────
  const tokenRaw = extractBetween(
    text,
    /PLN\s*Token/i,
    /Nama\s*Pengguna|No\s*Telp|Email|Tagihan|Rincian|Produk|Kode\s*Transaksi/i
  );
  if (tokenRaw) {
    result.token = tokenRaw.replace(/[^0-9]/g, '');
  }
  // Fallback: cari 20 digit berurutan jika extractBetween menghasilkan empty
  if (!result.token) {
    const m = text.match(/PLN\s*Token[\s:]*(\d[\d\s-]{15,25}\d)/i);
    if (m) result.token = m[1].replace(/[^0-9]/g, '');
  }

  // ─── 6. Tagihan/Nominal ──────────────────────────────────────────────────────
  // Format PDF baru: "Rincian Pembayaran" → "Tagihan   Rp 100.000" → "Biaya Layanan   Gratis" → "Kode Unik   Rp 0"
  // Strategi 1 (between-label): nilai antara "Tagihan" dan "Biaya Layanan" / "Kode Unik"
  //   Contoh teks: "Tagihan Rp 100.000 Biaya Layanan Gratis"
  //   → nominale = "100000"
  const tagihanBetween = extractBetween(
    text,
    /Tagihan/i,
    /Biaya\s*Layanan|Kode\s*Unik|Total\s*Pembayaran|Metode\s*Pembayaran/i
  );
  if (tagihanBetween) {
    const cleaned = tagihanBetween.replace(/^Rp\.?\s*/i, '').replace(/\./g, '').replace(/,/g, '').trim();
    if (/\d/.test(cleaned)) {
      result.nominal = cleaned;
      result.tagihan = cleaned;
    }
  }

  // Strategi 2 (regex langsung): tangkap nilai Rp tepat setelah "Tagihan" sebelum spasi/label berikutnya
  // Paling andal jika antara-label masih menghasilkan noise
  if (!result.nominal) {
    const tagihanDirectMatch = text.match(/Tagihan\s+Rp\s*([\d.,]+)/i);
    if (tagihanDirectMatch) {
      const cleaned = tagihanDirectMatch[1].replace(/\./g, '').replace(/,/g, '').trim();
      if (/\d/.test(cleaned)) {
        result.nominal = cleaned;
        result.tagihan = cleaned;
      }
    }
  }

  // Fallback Produk: "Produk PLN 100.000" → nominal
  if (!result.nominal) {
    const m = text.match(/Produk\s+PLN\s+([\d.,]+)/i);
    if (m) result.nominal = m[1].replace(/\./g, '').replace(',', '');
  }

  // ─── 7. PPN – opsional ───────────────────────────────────────────────────────
  const ppnRaw = extractBetween(
    text,
    /PP[Nn]/i,
    /ANGS|Angsuran|Total|Admin|Kode|Nama\s*Pengguna/i
  ).replace(/^Rp\.?\s*/i, '').replace(/\./g, '').replace(',', '.').trim();
  result.ppn = ppnRaw && /\d/.test(ppnRaw) ? ppnRaw : '0';

  // ─── 8. ANGS/MAT – opsional ─────────────────────────────────────────────────
  const angsmatRaw = extractBetween(
    text,
    /ANGS\s*\/\s*MAT|Angsuran/i,
    /Total|Tagihan|Kode|Nama\s*Pengguna/i
  ).trim();
  result.angsmat = angsmatRaw || '0,00/0,00';

  // ─── 9. Kode Transaksi / No Pesanan ─────────────────────────────────────────
  result.noPesanan = extractBetween(
    text,
    /Kode\s*Transaksi/i,
    /Waktu\s*Transaksi|Produk|PLN\s*Meter|Nama\s*Pemilik/i
  );
  if (!result.noPesanan) {
    const m = text.match(/Kode\s*Transaksi[\s:]*(TKN-[A-Z0-9]+)/i);
    if (m) result.noPesanan = m[1];
  }

  console.log('[NewFormat] Hasil parsing between-label:', result);
  return result;
}

/**
 * Process PDF file and return extracted data
 */
export async function processPdf(pdfDataUrl, mode = 'token', onStatusUpdate = null) {
  if (!pdfjsLib) {
    throw new Error('PDF library belum dimuat. Silakan muat ulang halaman.');
  }
  const loadingTask = pdfjsLib.getDocument(pdfDataUrl);
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);
  
  // 1. Try Direct Text Extraction (Digital PDF) - HIGH ACCURACY
  console.log('Mencoba ekstraksi teks langsung dari PDF mode:', mode);
  const directText = await extractPdfText(page);

  if (directText && directText.length > 20) {
    // 1a. Try NEW format parser FIRST (web receipt: PLN Meter No, Nama Pemilik, PLN Token, etc.)
    const newFormatData = parseNewFormatPdf(directText);
    if (newFormatData) {
      const hasToken = newFormatData.token && newFormatData.token.length >= 20;
      const hasIdpel = newFormatData.idpel && newFormatData.idpel.length >= 6;
      if (hasToken || hasIdpel) {
        console.log('[NewFormat] Extraction success:', newFormatData);
        return newFormatData;
      }
      // If only partial data found but we have token or idpel, still try line-based
    }

    // 1b. Also try with line-preserved text for new format (table PDFs)
    const lineText = await extractPdfTextWithLines(page);
    if (lineText) {
      const newFormatDataLines = parseNewFormatPdf(lineText);
      if (newFormatDataLines) {
        const hasToken = newFormatDataLines.token && newFormatDataLines.token.length >= 20;
        const hasIdpel = newFormatDataLines.idpel && newFormatDataLines.idpel.length >= 6;
        if (hasToken || hasIdpel) {
          console.log('[NewFormat] Line-based extraction success:', newFormatDataLines);
          return newFormatDataLines;
        }
      }
    }

    // 1c. Legacy format parsers
    console.log('Digital PDF detected. Parsing direct text (legacy)...');
    const data = (mode === 'payment') ? parsePaymentText(directText) : parsePLNText(directText);
    
    // Validate if mandatory fields found
    const hasToken = data.token && data.token.length >= 20;
    const hasIdpel = data.idpel && data.idpel.length >= 11;
    const hasTagihan = data.tagihan || data.total;
    
    if ((mode === 'token' && hasToken) || 
        (mode === 'tagihan-pln' && hasIdpel) || 
        (mode === 'payment' && (hasIdpel || hasTagihan))) {
      console.log('Direct extraction success (legacy):', data);
      return data;
    }
    console.log('Data penting tidak ditemukan di teks digital, lanjut ke mode visual...');
  }
  
  // 2. Fallback: Render to canvas for Vision/OCR
  const viewport = page.getViewport({ scale: 3.0 });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  canvas.height = viewport.height;
  canvas.width = viewport.width;

  await page.render({ canvasContext: context, viewport: viewport }).promise;
  
  const imageData = canvas.toDataURL('image/png');
  return await processReceipt(imageData, mode, onStatusUpdate);
}

/**
 * Snaps a value to the nearest common PLN denomination if within threshold
 */
function snapToNearestPLN(value) {
  const num = parseInt(value);
  if (isNaN(num)) return value;

  const denominations = [20000, 50000, 100000, 200000, 500000, 1000000];
  const threshold = 0.15; // 15% margin for OCR errors (e.g. 42k -> 50k, 18k -> 20k)
  
  for (const den of denominations) {
    const diff = Math.abs(num - den);
    if (diff / den <= threshold) {
      return den.toString();
    }
  }
  
  return value;
}

/**
 * Preprocess image to improve OCR (optional but recommended)
 * @param {HTMLImageElement|HTMLCanvasElement} image 
 */
export function preprocessImage(image) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = image.width;
  canvas.height = image.height;
  
  ctx.drawImage(image, 0, 0);
  
  // Grayscale filtering
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // Simple sharpening (Unsharp Masking style)
  for (let i = 0; i < data.length; i += 4) {
    const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
    // Basic thresholding for higher contrast
    const val = avg < 128 ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = val;
  }
  ctx.putImageData(imageData, 0, 0);
  
  return canvas.toDataURL('image/png');
}

function formatIndoMonth(monthStr) {
    const months = [
        'JANUARI', 'FEBRUARI', 'MARET', 'APRIL', 'MEI', 'JUNI', 
        'JULI', 'AGUSTUS', 'SEPTEMBER', 'OKTOBER', 'NOVEMBER', 'DESEMBER'
    ];
    let idx = parseInt(monthStr) - 1;
    if (idx >= 0 && idx < 12) return months[idx];
    return monthStr;
}
