/**
 * serverDiscovery.js
 * Auto-discovery untuk PaddleOCR Server di jaringan lokal.
 * Hanya memindai subnet 192.168.0.x (gateway 192.168.0.1).
 */

const SERVER_PORT = 5174;
const SCAN_TIMEOUT_MS = 450;
const DISCOVERY_CACHE_KEY = 'discoveredServerUrl';
const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 menit

// Subnet yang diperbolehkan — HANYA 192.168.0.x
const FIXED_SUBNET = '192.168.0';

/**
 * Cek apakah URL adalah server PaddleOCR yang valid
 */
export async function probeServer(baseUrl, timeoutMs = SCAN_TIMEOUT_MS) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const cleanUrl = baseUrl.replace(/\/+$/, '');
    const res = await fetch(`${cleanUrl}/api/health`, {
      signal: controller.signal,
      headers: { 'bypass-tunnel-reminder': 'true' }
    });
    clearTimeout(timeoutId);
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return data && data.online === true;
  } catch {
    return false;
  }
}

/**
 * Ekstrak subnet dari URL (dipertahankan untuk kompatibilitas ocr.js)
 */
export function extractSubnet(url) {
  if (!url) return null;
  try {
    const raw = url.startsWith('http') ? url : `http://${url}`;
    const u = new URL(raw);
    const m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(u.hostname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Ekstrak port dari URL (dipertahankan untuk kompatibilitas ocr.js)
 */
export function extractPort(url) {
  if (!url) return SERVER_PORT;
  try {
    const raw = url.startsWith('http') ? url : `http://${url}`;
    const u = new URL(raw);
    return u.port ? parseInt(u.port, 10) : SERVER_PORT;
  } catch {
    return SERVER_PORT;
  }
}

/**
 * Urutan IP DHCP yang diprioritaskan untuk 192.168.0.x
 * Router TP-Link / D-Link umumnya mengalokasikan 100-150 terlebih dahulu.
 */
function getPrioritizedHostIps() {
  const ips = [];
  for (let i = 2; i <= 254; i++) ips.push(i); // Urutan dari terkecil ke terbesar
  return ips;
}

/**
 * Jalankan batch IP secara paralel dan langsung resolve saat ada yang merespons.
 */
function probeBatchFast(urls) {
  return new Promise((resolve) => {
    let pending = urls.length;
    let finished = false;

    if (pending === 0) return resolve(null);

    urls.forEach((url) => {
      probeServer(url, SCAN_TIMEOUT_MS).then((ok) => {
        if (finished) return;
        if (ok) {
          finished = true;
          resolve(url);
        } else {
          pending--;
          if (pending === 0) resolve(null);
        }
      });
    });
  });
}

/**
 * Scan HANYA subnet 192.168.0.x
 */
async function scanFixedSubnet(excludeUrl = null, onProgress = null) {
  const hostIps = getPrioritizedHostIps();
  const BATCH_SIZE = 55;
  const total = hostIps.length;

  console.log(`[Discovery] Memindai ${FIXED_SUBNET}.x:${SERVER_PORT}...`);

  for (let start = 0; start < total; start += BATCH_SIZE) {
    const slice = hostIps.slice(start, start + BATCH_SIZE);
    const urls = slice
      .map(host => `http://${FIXED_SUBNET}.${host}:${SERVER_PORT}`)
      .filter(url => !excludeUrl || url.replace(/\/+$/, '') !== excludeUrl.replace(/\/+$/, ''));

    if (onProgress) {
      const pct = Math.min(Math.round(((start + slice.length) / total) * 100), 98);
      onProgress(pct, `Scan ${FIXED_SUBNET}.x (${pct}%)...`);
    }

    const found = await probeBatchFast(urls);
    if (found) {
      console.log('[Discovery] Server ditemukan:', found);
      return found;
    }
  }

  return null;
}

/**
 * Auto-discover server di 192.168.0.x saja.
 * @param {Function} onProgress - callback(percent, message)
 * @param {Object} options - { failedUrl?: string }
 * @returns {Promise<string|null>} URL server atau null
 */
export async function discoverServer(onProgress = null, options = {}) {
  const failedUrl = options.failedUrl ? options.failedUrl.trim().replace(/\/+$/, '') : null;

  // 1. Cek cache
  const cached = getCachedServer();
  if (cached) {
    const cachedClean = cached.replace(/\/+$/, '');
    if (failedUrl && cachedClean === failedUrl) {
      // Cache adalah URL yang baru gagal, hapus cache
      clearCachedServer();
    } else {
      if (onProgress) onProgress(10, 'Memeriksa server terakhir...');
      const still_ok = await probeServer(cached, 600);
      if (still_ok) {
        if (onProgress) onProgress(100, 'Server ditemukan!');
        return cached;
      }
      clearCachedServer();
    }
  }

  // 2. Pindai subnet 192.168.0.x
  if (onProgress) onProgress(15, `Memindai ${FIXED_SUBNET}.x...`);
  const result = await scanFixedSubnet(failedUrl, onProgress);

  if (result) {
    setCachedServer(result);
    if (onProgress) onProgress(100, `Server ditemukan di ${result}!`);
    return result;
  }

  if (onProgress) onProgress(100, 'Server tidak ditemukan.');
  return null;
}

function getCachedServer() {
  try {
    const raw = localStorage.getItem(DISCOVERY_CACHE_KEY);
    if (!raw) return null;
    const { url, timestamp } = JSON.parse(raw);
    if (Date.now() - timestamp > DISCOVERY_CACHE_TTL_MS) return null;
    return url;
  } catch { return null; }
}

function setCachedServer(url) {
  localStorage.setItem(DISCOVERY_CACHE_KEY, JSON.stringify({ url, timestamp: Date.now() }));
}

export function clearDiscoveryCache() {
  localStorage.removeItem(DISCOVERY_CACHE_KEY);
}
