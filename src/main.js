import { processReceipt, processPdf, preprocessImage, getPcServerUrl, setPcServerUrl, checkPcServerHealth } from './ocr';
import { getPaddleOcrService } from './paddleOcr';
import { printViaRawBT } from './rawbt';
// import { registerSW } from 'virtual:pwa-register';

// State
let currentReceiptData = null;
let appMode = 'token'; // 'token' or 'payment'
let autoPrintEnabled = localStorage.getItem('autoPrint') === 'true';

// DEBUG: Global Error Handler
window.onerror = function(msg, url, line) {
  alert("System Error:\n" + msg + "\nLine: " + line);
  console.error("Global Error:", msg, url, line);
};
console.log("Main.js loaded");

// Pre-warm OCR worker silently in background for instant scanning
setTimeout(() => {
  getPaddleOcrService().catch(e => console.warn('[PaddleOCR Prewarm]:', e.message));
}, 500);

// DOM Elements
const scannerSection = document.getElementById('scanner-section');
const resultSection = document.getElementById('result-section');
const imagePreview = document.getElementById('image-preview');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const ocrStatus = document.getElementById('ocr-status');
const statusText = document.getElementById('status-text');
const installBtn = document.getElementById('install-btn');
const autoPrintSwitch = document.getElementById('auto-print-switch');

// Server Status Elements
const serverStatusBadge = document.getElementById('server-status-badge');
const serverStatusText = document.getElementById('server-status-text');

// Restore auto-print toggle state
if (autoPrintSwitch) {
  autoPrintSwitch.checked = autoPrintEnabled;
  autoPrintSwitch.addEventListener('change', () => {
    autoPrintEnabled = autoPrintSwitch.checked;
    localStorage.setItem('autoPrint', autoPrintEnabled);
    showToast(autoPrintEnabled ? 'Auto-Print DIAKTIFKAN 🖨️' : 'Auto-Print NONAKTIF');
  });
}

// Mode Switch Elements
const modeToken = document.getElementById('mode-token');
const modePayment = document.getElementById('mode-payment');

// Dropdown Elements
const plnDropdown = document.getElementById('mode-pln-dropdown');
const plnMenu = document.getElementById('pln-menu');
const plnLabel = document.getElementById('pln-label');
const dropdownItems = document.querySelectorAll('.dropdown-item');

// Result Elements
const resToken = document.getElementById('res-token'); 
const resIdpel = document.getElementById('res-idpel');
const resNama = document.getElementById('res-nama');
const resTarif = document.getElementById('res-tarif');
const resKwh = document.getElementById('res-kwh');
const resNominal = document.getElementById('res-nominal');
const resPpn = document.getElementById('res-ppn');
const resAngsmat = document.getElementById('res-angsmat');
const resTotal = document.getElementById('res-total');
const adminSelect = document.getElementById('res-admin-select');

// New Payment Result Elements
const itemLokasi = document.getElementById('item-lokasi');
const resLokasi = document.getElementById('res-lokasi');
const itemPeriode = document.getElementById('item-periode');
const resPeriode = document.getElementById('res-periode');
const itemNoPesanan = document.getElementById('item-nopesanan');
const itemStand = document.getElementById('item-stand');
const resStand = document.getElementById('res-stand');
const itemDenda = document.getElementById('item-denda');
const resDenda = document.getElementById('res-denda');

// Buttons & Settings Elements
const uploadBtn = document.getElementById('upload-btn');
const printBtn = document.getElementById('print-btn');
const resetBtn = document.getElementById('reset-btn');
const settingsBtn = document.getElementById('settings-btn');
const saveSettingsBtn = document.getElementById('save-settings');
const closeSettingsBtn = document.getElementById('close-settings');
const settingsModal = document.getElementById('settings-modal');
const storeNameInput = document.getElementById('store-name-input');
const pcServerUrlInput = document.getElementById('pc-server-url-input');
const testServerBtn = document.getElementById('test-server-btn');
const serverTestResult = document.getElementById('server-test-result');

/**
 * Check and refresh server status badge
 */
export async function refreshServerStatus(showToastFeedback = false, isBackground = false) {
  if (!serverStatusBadge || !serverStatusText) return;

  if (!isBackground) {
    serverStatusBadge.className = 'server-badge badge-checking';
    serverStatusText.textContent = 'Mengecek PC...';
  }

  const health = await checkPcServerHealth(getPcServerUrl(), 3000);
  if (health.online) {
    serverStatusBadge.className = 'server-badge badge-online';
    serverStatusText.textContent = 'PC: PaddleOCR Online';
    serverStatusBadge.title = 'Server PC aktif & terhubung! PaddleOCR akan digunakan sebagai mesin utama. Klik untuk refresh.';
    if (showToastFeedback) showToast('🟢 Server PC Online (PaddleOCR Siap)', 2500);
  } else {
    serverStatusBadge.className = 'server-badge badge-offline';
    serverStatusText.textContent = 'PC Offline (Tesseract Backup)';
    serverStatusBadge.title = `Server PC tidak terhubung (${health.error}). Tesseract OCR otomatis aktif sebagai cadangan. Klik untuk refresh.`;
    if (showToastFeedback) showToast('🟡 Server PC Offline. Tesseract Backup aktif.', 3000);
  }
}

if (serverStatusBadge) {
  serverStatusBadge.addEventListener('click', () => refreshServerStatus(true));
}

// Initial status check and periodic check every 3 seconds (real-time)
refreshServerStatus();
setInterval(() => refreshServerStatus(false, true), 3000);





/**
 * PWA Registration
 */
// const updateSW = registerSW({
//   onNeedRefresh() {
//     showToast('Aplikasi tersedia versi baru. Muat ulang?', 5000);
//   },
//   onOfflineReady() {
//     showToast('Aplikasi siap digunakan secara offline');
//   },
// });

/**
 * Mode Switching
 */
function setMode(mode) {
  appMode = mode;
  console.log("Mode Switch Clicked:", mode);
  
  // UI Updates
  if (mode === 'token' || mode === 'tagihan-pln') {
    plnDropdown.classList.add('active');
    modePayment.classList.remove('active');
    plnLabel.textContent = mode === 'token' ? 'Token PLN' : 'Tagihan Listrik';
  } else {
    modePayment.classList.add('active');
    plnDropdown.classList.remove('active');
  }
  plnMenu.classList.add('hidden');
}

plnDropdown.addEventListener('click', (e) => {
  e.stopPropagation();
  plnMenu.classList.toggle('hidden');
});

dropdownItems.forEach(item => {
  item.addEventListener('click', () => {
    setMode(item.dataset.mode);
  });
});

window.addEventListener('click', () => plnMenu.classList.add('hidden'));

modePayment.addEventListener('click', () => setMode('payment'));

/**
 * UI State Management
 */
function showScanner() {
  scannerSection.classList.remove('hidden');
  resultSection.classList.add('hidden');
  ocrStatus.classList.add('hidden');
  imagePreview.classList.add('hidden');
  dropZone.classList.remove('hidden');
  document.querySelector('.scanner-container').classList.remove('has-image');
  if (fileInput) fileInput.value = '';
  currentReceiptData = null;
}

function showResult(data) {
  const customAdmin = parseInt(localStorage.getItem('customAdmin') || '3000');
  
  const baseAmount = parseInt(appMode === 'token' ? (data.nominal || '0') : (data.tagihan || '0'));
  
  let ocrAdmin = parseInt(data.admin || '0');
  if (isNaN(ocrAdmin)) ocrAdmin = 0;

  data.admin = customAdmin;
  data.total = baseAmount + data.admin;

  currentReceiptData = data;

  resIdpel.textContent = data.idpel || '-';
  resNama.textContent = data.nama || '-';
  
  if (appMode === 'token' || appMode === 'tagihan-pln') {
    const isToken = appMode === 'token';
    toggleElement(resToken.parentElement, isToken);
    toggleElement(resTarif.parentElement, true);
    toggleElement(resKwh.parentElement, isToken);
    toggleElement(resPpn.parentElement, true);
    toggleElement(resAngsmat.parentElement, isToken);
    
    toggleElement(itemLokasi, false);
    toggleElement(itemPeriode, !isToken);
    toggleElement(itemNoPesanan, !isToken);
    toggleElement(itemStand, !isToken);
    toggleElement(itemDenda, !isToken);
    
    if (isToken) {
        resToken.textContent = formatToken(data.token);
        resKwh.textContent = formatKwh(data.kwh) || '-';
    } else {
        resStand.textContent = data.stand || '-';
        resDenda.textContent = `Rp${formatRp(data.denda)}`;
    }

    resTarif.textContent = data.tarif || '-';
    resNominal.previousElementSibling.textContent = isToken ? 'Nominal' : 'Total Tagihan';
    resNominal.textContent = `Rp${formatRp(isToken ? data.nominal : data.tagihan)}`;
    resPpn.textContent = `Rp${formatRpDecimal(data.ppn)}`;
    resAngsmat.textContent = `Rp${data.angsmat}`;
    resPeriode.textContent = data.periode || '-';
    const noPesananEl = document.getElementById('res-nopesanan');
    if (noPesananEl) noPesananEl.textContent = data.noPesanan || '-';

  } else {
    toggleElement(resToken.parentElement, false);
    toggleElement(resTarif.parentElement, false);
    toggleElement(resKwh.parentElement, false);
    toggleElement(resPpn.parentElement, false);
    toggleElement(resAngsmat.parentElement, false);
    
    toggleElement(itemLokasi, true);
    toggleElement(itemPeriode, true);
    toggleElement(itemNoPesanan, !!data.noPesanan);

    resLokasi.textContent = data.lokasi || '-';
    resPeriode.textContent = data.periode || '-';
    const noPesananEl = document.getElementById('res-nopesanan');
    if (noPesananEl) noPesananEl.textContent = data.noPesanan || '-';
    resNominal.previousElementSibling.textContent = 'Tagihan';
    resNominal.textContent = `Rp${formatRp(data.tagihan)}`;
  }

  resTotal.textContent = `Rp${formatRp(data.total)}`;
  adminSelect.value = data.admin.toString();

  scannerSection.classList.add('hidden');
  resultSection.classList.remove('hidden');
}


function formatRp(num) {
  if (!num) return '0';
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function formatRpDecimal(val) {
  if (!val) return '0,00';
  let clean = val.toString().replace(/[^0-9,.]/g, '').replace(',', '.');
  let num = parseFloat(clean);
  if (isNaN(num)) return val;
  return num.toFixed(2).replace('.', ',');
}

function formatKwh(val) {
  if (!val) return '0,0';
  let clean = val.toString().replace(/[^0-9,.]/g, '').replace(',', '.');
  let num = parseFloat(clean);
  if (isNaN(num)) return val;
  if (!clean.includes('.') && num > 1000) {
    num = num / 100;
  }
  return num.toFixed(1) + 'KWH';
}

function formatToken(token) {
  if (!token) return '---- ---- ---- ---- ----';
  return token.replace(/(\d{4})/g, '$1 ').trim();
}

async function processImage(source, isPdf = false) {
  ocrStatus.classList.remove('hidden');
  statusText.textContent = 'Menghubungi Server OCR...';
  
  const updateStatus = (text) => {
    if (statusText) statusText.textContent = text;
  };

  try {
    let data;
    if (isPdf) {
      imagePreview.classList.add('hidden');
      dropZone.classList.remove('hidden'); // Keep icon for PDF
      try {
        data = await processPdf(source, appMode, updateStatus);
      } catch (pdfErr) {
        // If PDF parsing fails with "Invalid PDF structure", the file is likely an image
        // with a misleading .pdf extension. Retry as image.
        if (pdfErr.message && pdfErr.message.includes('Invalid PDF structure')) {
          console.warn('[processImage] PDF parsing failed, retrying as image...', pdfErr.message);
          updateStatus('File bukan PDF asli, memproses sebagai gambar...');
          // Fix the data URL prefix if it says application/pdf but is actually an image
          let imageSource = source;
          if (source.startsWith('data:application/pdf')) {
            imageSource = source.replace('data:application/pdf', 'data:image/png');
          }
          imagePreview.src = imageSource;
          imagePreview.classList.remove('hidden');
          dropZone.classList.add('hidden');
          document.querySelector('.scanner-container').classList.add('has-image');
          data = await processReceipt(imageSource, appMode, updateStatus);
        } else {
          throw pdfErr; // Re-throw other PDF errors
        }
      }
    } else {
      imagePreview.src = source;
      imagePreview.classList.remove('hidden');
      dropZone.classList.add('hidden');
      document.querySelector('.scanner-container').classList.add('has-image');
      data = await processReceipt(source, appMode, updateStatus);
    }

    // Update server status badge to match actual execution
    if (data.isServerOnline) {
      serverStatusBadge.className = 'server-badge badge-online';
      serverStatusText.textContent = 'PC: PaddleOCR Online';
    } else {
      serverStatusBadge.className = 'server-badge badge-offline';
      serverStatusText.textContent = 'PC Offline (Tesseract Backup)';
    }

    // Allow displaying result if token OR any key PLN field (IDPEL/Nama/Tagihan) is found
    const hasAnyPLNData = data && (data.token || data.idpel || data.nama || data.tagihan || data.nominal);
    if (appMode === 'token' && !hasAnyPLNData) {
      statusText.textContent = 'Data struk tidak terbaca. Pastikan foto cukup terang.';
      setTimeout(() => ocrStatus.classList.add('hidden'), 4000);
      return;
    }

    if (appMode === 'payment' && !data.tagihan && !data.total && !data.idpel && !data.nama) {
      statusText.textContent = 'Bukan struk pembayaran yang dikenali. Coba lagi.';
      setTimeout(() => ocrStatus.classList.add('hidden'), 4000);
      return;
    }

    showResult(data);
    if (data.usedEngine) {
      showToast(data.isServerOnline ? `🚀 ${data.usedEngine}` : `⚡ ${data.usedEngine}`, 4000);
    }


    // Auto-print if enabled
    if (autoPrintEnabled && currentReceiptData) {
      setTimeout(async () => {
        try {
          const storeName = localStorage.getItem('storeName') || 'SA CELL';
          await printViaRawBT({ ...currentReceiptData, storeName, mode: appMode });
          showToast('Auto-print: Dikirim ke RawBT! 🖨️');
        } catch (err) {
          showToast('Auto-print gagal: ' + err.message);
        }
      }, 300);
    }
  } catch (err) {
    showToast('Gagal memproses file: ' + err.message);
    ocrStatus.classList.add('hidden');
  } finally {
    if (fileInput) fileInput.value = '';
  }
}

/**
 * Detect actual MIME type of a file by reading its magic bytes.
 * Supports PDF, PNG, JPEG, GIF, and WebP.
 * @param {File} file 
 * @returns {Promise<string>}
 */
function detectFileType(file) {
  return new Promise((resolve) => {
    const slice = file.slice(0, 12);
    const reader = new FileReader();
    reader.onload = (e) => {
      const buffer = e.target.result;
      const view = new Uint8Array(buffer);
      if (view.length < 4) {
        console.warn('[detectFileType] File too small, returning unknown');
        resolve('unknown');
        return;
      }
      
      const hex = Array.from(view).map(b => b.toString(16).padStart(2, '0')).join('');
      console.log('[detectFileType] Magic bytes:', hex.substring(0, 16), 'file.name:', file.name, 'file.type:', file.type);
      
      if (hex.startsWith('89504e47')) {
        resolve('image/png');
      } else if (hex.startsWith('ffd8ff')) {
        resolve('image/jpeg');
      } else if (hex.startsWith('25504446')) {
        resolve('application/pdf');
      } else if (hex.startsWith('47494638')) {
        resolve('image/gif');
      } else if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') {
        resolve('image/webp');
      } else {
        resolve('unknown');
      }
    };
    reader.onerror = () => {
      console.warn('[detectFileType] FileReader error, returning unknown');
      resolve('unknown');
    };
    reader.readAsArrayBuffer(slice);
  });
}

/**
 * Event Listeners
 */

uploadBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) {
    const realType = await detectFileType(file);
    const isPdf = realType === 'application/pdf' || (realType === 'unknown' && file.name.toLowerCase().endsWith('.pdf'));
    
    console.log('[FileUpload] realType:', realType, 'isPdf:', isPdf, 'file.type:', file.type, 'file.name:', file.name);
    
    // If the file is actually an image but has application/pdf MIME type due to extension,
    // we wrap it as a Blob with the corrected type so FileReader uses the right data URL prefix.
    const isImageMaskedAsPdf = realType.startsWith('image/') && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
    const fileToProcess = isImageMaskedAsPdf
      ? new Blob([file], { type: realType })
      : file;

    if (isImageMaskedAsPdf) {
      console.log('[FileUpload] Corrected MIME type from', file.type, 'to', realType);
    }

    const reader = new FileReader();
    reader.onload = (event) => processImage(event.target.result, isPdf);
    reader.readAsDataURL(fileToProcess);
  }
});

adminSelect.addEventListener('change', () => {
  if (!currentReceiptData) return;
  const value = parseInt(adminSelect.value);
  currentReceiptData.admin = value;
  
  const baseAmount = parseInt(appMode === 'token' ? (currentReceiptData.nominal || '0') : (currentReceiptData.tagihan || '0'));
  currentReceiptData.total = baseAmount + value;
  
  resTotal.textContent = `Rp${formatRp(currentReceiptData.total)}`;
  localStorage.setItem('customAdmin', value);
});

resToken.addEventListener('input', () => {
  if (!currentReceiptData) return;
  const raw = resToken.textContent.replace(/\D/g, '');
  currentReceiptData.token = raw;
  console.log('[Token Edit] Token diperbarui:', raw);
});

resNama.addEventListener('input', () => {
  if (!currentReceiptData) return;
  currentReceiptData.nama = resNama.textContent.trim();
  console.log('[Nama Edit] Nama diperbarui:', currentReceiptData.nama);
});

resIdpel.addEventListener('input', () => {
  if (!currentReceiptData) return;
  currentReceiptData.idpel = resIdpel.textContent.trim().replace(/\D/g, '');
  console.log('[IDPEL Edit] IDPEL diperbarui:', currentReceiptData.idpel);
});

dropZone.addEventListener('click', () => fileInput.click());

printBtn.addEventListener('click', async () => {
  if (!currentReceiptData) return;

  const originalText = printBtn.innerHTML;
  printBtn.disabled = true;
  printBtn.innerHTML = '<div class="spinner"></div> Mencetak...';

  try {
    const storeName = localStorage.getItem('storeName') || 'SA CELL';
    await printViaRawBT({ ...currentReceiptData, storeName, mode: appMode });
    showToast('Berhasil dikirim ke RawBT!');
  } catch (err) {
    showToast(err.message); 
    if (err.message.includes('RawBT')) {
        showToast('Pastikan RawBT aktif & "Server Pencetakan" ON', 5000);
    }
  } finally {
    printBtn.disabled = false;
    printBtn.innerHTML = originalText;
  }
});

resetBtn.addEventListener('click', showScanner);

settingsBtn.addEventListener('click', () => {
  storeNameInput.value = localStorage.getItem('storeName') || 'SA CELL';
  if (pcServerUrlInput) {
    pcServerUrlInput.value = getPcServerUrl();
  }
  if (serverTestResult) {
    serverTestResult.classList.add('hidden');
    serverTestResult.className = 'test-result-box hidden';
    serverTestResult.textContent = '';
  }
  settingsModal.classList.remove('hidden');
});

if (closeSettingsBtn) {
  closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });
}

saveSettingsBtn.addEventListener('click', () => {
  localStorage.setItem('storeName', storeNameInput.value);
  if (pcServerUrlInput) {
    setPcServerUrl(pcServerUrlInput.value);
  }
  settingsModal.classList.add('hidden');
  refreshServerStatus(true);
  if (currentReceiptData) {
    showResult(currentReceiptData);
  }
});

if (testServerBtn) {
  testServerBtn.addEventListener('click', async () => {
    const testUrl = (pcServerUrlInput ? pcServerUrlInput.value : '').trim();
    testServerBtn.disabled = true;
    testServerBtn.innerHTML = '<span class="icon">⏳</span> Menghubungi...';
    serverTestResult.classList.remove('hidden');
    serverTestResult.className = 'test-result-box';
    serverTestResult.textContent = 'Mengecek endpoint /api/health ke ' + (testUrl || '(server lokal)...');

    const res = await checkPcServerHealth(testUrl, 4000);
    testServerBtn.disabled = false;
    testServerBtn.innerHTML = '<span class="icon">🔌</span> Tes Koneksi PC';

    if (res.online) {
      serverTestResult.className = 'test-result-box success';
      serverTestResult.innerHTML = `✅ <strong>Berhasil terhubung!</strong><br>Engine: ${res.engine}. PaddleOCR siap digunakan.`;
    } else {
      serverTestResult.className = 'test-result-box error';
      serverTestResult.innerHTML = `❌ <strong>Gagal terhubung:</strong> ${res.error}.<br><span style="font-size:0.75rem;">Pastikan server di PC aktif (<code>npm run server</code>). Jika aplikasi di Vercel, pastikan memakai HTTPS tunnel jika diblokir mixed content.</span>`;
    }
  });
}

/**
 * 100% Fully Automatic Cleanup:
 * Clears temporary session storage, runtime image cache, memory state, and input data
 * automatically whenever the application is closed, exited, or re-opened.
 */
async function autoCleanSessionAndCache() {
  currentReceiptData = null;
  sessionStorage.clear();

  if (fileInput) fileInput.value = '';
  if (imagePreview) {
    imagePreview.src = '';
    imagePreview.classList.add('hidden');
  }

  // Clear runtime dynamic caches automatically
  if ('caches' in window) {
    try {
      const keys = await caches.keys();
      for (const key of keys) {
        if (key.includes('runtime') || key.includes('dynamic')) {
          await caches.delete(key);
        }
      }
    } catch (e) {
      console.warn('[AutoClean] Cache cleanup note:', e);
    }
  }
}

window.addEventListener('pagehide', autoCleanSessionAndCache);
window.addEventListener('beforeunload', autoCleanSessionAndCache);
window.addEventListener('DOMContentLoaded', () => {
  autoCleanSessionAndCache();
  showScanner();
});

function toggleElement(element, visible) {
  if (!element) return;
  if (visible) {
    element.classList.remove('hidden');
  } else {
    element.classList.add('hidden');
  }
}

function showToast(message, duration = 3000) {
  const toast = document.getElementById('toast');
  if (toast) {
    toast.textContent = message;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), duration);
  }
}

let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (installBtn) installBtn.classList.remove('hidden');
});

if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        installBtn.classList.add('hidden');
      }
      deferredPrompt = null;
    }
  });
}
