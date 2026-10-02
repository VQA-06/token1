/**
 * serverDiscovery.js
 * Ultra-fast Auto-Discovery untuk PaddleOCR Server di jaringan lokal.
 * 
 * Dioptimalkan untuk gateway 192.168.0.1:
 * - Prioritas utama subnet: 192.168.0.x
 * - Rentang IP DHCP paling umum (100-150 & 2-50) dipindai di batch pertama
 * - Fast-resolve: langsung mengembalikan IP yang merespons dalam hitungan milidetik tanpa menunggu timeout IP lain
 */

const SERVER_PORT = 5174;
const HEALTH_TIMEOUT_MS = 1200;
const SCAN_TIMEOUT_MS = 450; // Timeout cukup 450ms untuk jaringan WiFi lokal
const DISCOVERY_CACHE_KEY = 'discoveredServerUrl';
const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 menit

/**
 * Ekstrak subnet dari URL IP (contoh: http://192.168.0.102:5174 -> 192.168.0)
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
 * Ekstrak port dari URL (default 5174)
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
 * Cek apakah URL adalah server PaddleOCR yang valid
 */
export async function probeServer(baseUrl, timeoutMs = HEALTH_TIMEOUT_MS) {
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
 * Coba via mDNS hostname (paddleocr.local) secara cepat
 */
async function tryMdns(port = SERVER_PORT) {
  const url = `http://paddleocr.local:${port}`;
  console.log('[Discovery] Mencoba mDNS:', url);
  const ok = await probeServer(url, 400); // 400ms cepat
  if (ok) {
    console.log('[Discovery] Server ditemukan via mDNS:', url);
    return url;
  }
  return null;
}

/**
 * Deteksi subnet dari IP browser menggunakan WebRTC (cepat, maks 350ms)
 */
async function getLocalSubnet() {
  return new Promise((resolve) => {
    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel('');
      pc.createOffer().then(o => pc.setLocalDescription(o));
      const timeout = setTimeout(() => { pc.close(); resolve(null); }, 350);
      pc.onicecandidate = (e) => {
        if (!e || !e.candidate) return;
        const match = /(\d+\.\d+\.\d+)\.\d+/.exec(e.candidate.candidate);
        if (match) {
          clearTimeout(timeout);
          pc.close();
          resolve(match[1]);
        }
      };
    } catch {
      resolve(null);
    }
  });
}

/**
 * Buat urutan IP prioritas untuk subnet lokal (khususnya 192.168.0.x / 192.168.1.x)
 * Router umum (TP-Link, D-Link, Tenda, dll.) memakai DHCP:
 * 1. 100 s/d 150 (Default TP-Link/D-Link paling sering digunakan)
 * 2. 2 s/d 50 (Tenda / Totolink / IP awal)
 * 3. 151 s/d 200
 * 4. 51 s/d 99
 * 5. 201 s/d 254
 */
function getPrioritizedHostIps() {
  const ips = [];
  // Batch prioritas #1: 100 - 150
  for (let i = 100; i <= 150; i++) ips.push(i);
  // Batch prioritas #2: 2 - 50
  for (let i = 2; i <= 50; i++) ips.push(i);
  // Batch prioritas #3: 151 - 200
  for (let i = 151; i <= 200; i++) ips.push(i);
  // Batch prioritas #4: 51 - 99
  for (let i = 51; i <= 99; i++) ips.push(i);
  // Batch prioritas #5: 201 - 254
  for (let i = 201; i <= 254; i++) ips.push(i);
  return ips;
}

/**
 * Pindai kumpulan URL secara paralel dan LANGSUNG selesaikan begitu ada 1 server yang merespons OK.
 * Tidak perlu menunggu IP lain yang timeout!
 */
function probeBatchFast(urls, timeoutMs = SCAN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let pending = urls.length;
    let finished = false;

    if (pending === 0) return resolve(null);

    urls.forEach((url) => {
      probeServer(url, timeoutMs).then((ok) => {
        if (finished) return;
        if (ok) {
          finished = true;
          resolve(url);
        } else {
          pending--;
          if (pending === 0) {
            resolve(null);
          }
        }
      });
    });
  });
}

/**
 * Scan subnet dengan prioritas IP DHCP dan fast-resolve
 */
async function scanSubnet(subnet, port = SERVER_PORT, onProgress = null, excludeUrl = null) {
  console.log(`[Discovery] Scanning subnet ${subnet}.x pada port ${port}...`);
  const hostIps = getPrioritizedHostIps();
  const BATCH_SIZE = 55; // Pindai 55 IP sekaligus dalam 1 batch
  const total = hostIps.length;

  for (let start = 0; start < total; start += BATCH_SIZE) {
    const slice = hostIps.slice(start, start + BATCH_SIZE);
    const urls = [];

    for (const host of slice) {
      const url = `http://${subnet}.${host}:${port}`;
      if (excludeUrl && url.replace(/\/+$/, '') === excludeUrl.replace(/\/+$/, '')) {
        continue;
      }
      urls.push(url);
    }

    if (onProgress) {
      const pct = Math.min(Math.round(((start + slice.length) / total) * 100), 98);
      onProgress(pct);
    }

    // Jalankan batch: jika ada server merespons, langsung return dalam ~10ms!
    const found = await probeBatchFast(urls, SCAN_TIMEOUT_MS);
    if (found) {
      console.log('[Discovery] Server ditemukan kilat:', found);
      return found;
    }
  }

  return null;
}

/**
 * Auto-discover server: cache -> mDNS -> scan subnet kilat
 * @param {Function} onProgress - callback(percent, message)
 * @param {Object} options - { failedUrl?: string }
 * @returns {Promise<string|null>} URL server atau null
 */
export async function discoverServer(onProgress = null, options = {}) {
  const failedUrl = options.failedUrl ? options.failedUrl.trim().replace(/\/+$/, '') : null;
  const targetPort = extractPort(failedUrl) || SERVER_PORT;

  // 1. Cek cache (kecuali jika cache adalah failedUrl yang baru saja mati)
  const cached = getCachedServer();
  if (cached) {
    if (failedUrl && cached.replace(/\/+$/, '') === failedUrl) {
      clearCachedServer();
    } else {
      console.log('[Discovery] Cache hit, verifying:', cached);
      if (onProgress) onProgress(10, 'Memeriksa server terakhir...');
      const still_ok = await probeServer(cached, 600);
      if (still_ok) {
        if (onProgress) onProgress(100, 'Server ditemukan!');
        return cached;
      }
      clearCachedServer();
    }
  }

  // 2. Coba mDNS cepat (paddleocr.local)
  if (onProgress) onProgress(15, 'Mengecek paddleocr.local...');
  const mdnsResult = await tryMdns(targetPort);
  if (mdnsResult && (!failedUrl || mdnsResult.replace(/\/+$/, '') !== failedUrl)) {
    setCachedServer(mdnsResult);
    if (onProgress) onProgress(100, 'Server ditemukan via mDNS!');
    return mdnsResult;
  }

  // 3. Kumpulkan subnet kandidat dengan 192.168.0 sebagai PRIORITAS UTAMA (gateway 192.168.0.1)
  if (onProgress) onProgress(20, 'Memindai subnet 192.168.0.x...');
  const detectedSubnet = await getLocalSubnet();
  const knownSubnet = extractSubnet(failedUrl) || extractSubnet(localStorage.getItem('pcServerUrl'));

  // Susunan prioritas: 192.168.0 SELALU PERTAMA karena gateway pengguna adalah 192.168.0.1
  const candidateSubnets = [
    '192.168.0',          // Gateway 192.168.0.1 (TOP PRIORITY)
    knownSubnet,          // Subnet sebelumnya jika berbeda
    detectedSubnet,       // Dari WebRTC jika ada
    '192.168.1',
    '192.168.100',
    '192.168.18',
    '192.168.43'
  ].filter(Boolean);

  const subnetsToTry = [...new Set(candidateSubnets)];

  for (let sIdx = 0; sIdx < subnetsToTry.length; sIdx++) {
    const sub = subnetsToTry[sIdx];
    const basePct = 25 + Math.round((sIdx / subnetsToTry.length) * 70);
    if (onProgress) onProgress(basePct, `Scan ${sub}.x...`);

    const result = await scanSubnet(sub, targetPort, (pct) => {
      if (onProgress) {
        const currentPct = basePct + Math.round((pct / 100) * (70 / subnetsToTry.length));
        onProgress(Math.min(currentPct, 95), `Scan ${sub}.x (${pct}%)...`);
      }
    }, failedUrl);

    if (result) {
      setCachedServer(result);
      if (onProgress) onProgress(100, `Server ditemukan di ${result}!`);
      return result;
    }
  }

  if (onProgress) onProgress(100, 'Pencarian selesai.');
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
