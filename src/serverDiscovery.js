/**
 * serverDiscovery.js
 * Auto-discovery untuk PaddleOCR Server di jaringan lokal.
 * 
 * Strategi:
 * 1. Coba connect ke paddleocr.local (via mDNS broadcast dari server)
 * 2. Fallback: scan subnet lokal (192.168.x.x) mencari server aktif secara otomatis
 */

const SERVER_PORT = 5174;
const HEALTH_TIMEOUT_MS = 1500;
const SCAN_TIMEOUT_MS = 550;
const DISCOVERY_CACHE_KEY = 'discoveredServerUrl';
const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 menit

/**
 * Ekstrak subnet dari URL IP (contoh: http://192.168.1.50:5174 -> 192.168.1)
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
 * Coba via mDNS hostname (paddleocr.local)
 */
async function tryMdns(port = SERVER_PORT) {
  const url = `http://paddleocr.local:${port}`;
  console.log('[Discovery] Mencoba mDNS:', url);
  const ok = await probeServer(url, 1200);
  if (ok) {
    console.log('[Discovery] Server ditemukan via mDNS:', url);
    return url;
  }
  return null;
}

/**
 * Deteksi subnet dari IP browser menggunakan WebRTC
 */
async function getLocalSubnet() {
  return new Promise((resolve) => {
    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel('');
      pc.createOffer().then(o => pc.setLocalDescription(o));
      const timeout = setTimeout(() => { pc.close(); resolve(null); }, 2000);
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
 * Scan subnet untuk mencari server PaddleOCR
 */
async function scanSubnet(subnet, port = SERVER_PORT, onProgress = null, excludeUrl = null) {
  console.log(`[Discovery] Scanning subnet ${subnet}.1-254 pada port ${port}...`);
  const BATCH_SIZE = 50;
  const total = 254;

  for (let start = 1; start <= total; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, total);
    const batch = [];

    for (let i = start; i <= end; i++) {
      const ip = `${subnet}.${i}`;
      const url = `http://${ip}:${port}`;
      if (excludeUrl && url.replace(/\/+$/, '') === excludeUrl.replace(/\/+$/, '')) {
        continue;
      }
      batch.push(
        probeServer(url, SCAN_TIMEOUT_MS).then(ok => (ok ? url : null))
      );
    }

    if (onProgress) onProgress(Math.round((start / total) * 100));

    const results = await Promise.all(batch);
    const found = results.find(r => r !== null);
    if (found) {
      console.log('[Discovery] Server ditemukan via scan:', found);
      return found;
    }
  }
  return null;
}

/**
 * Auto-discover server: cache -> mDNS -> scan subnet
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
      const still_ok = await probeServer(cached);
      if (still_ok) {
        if (onProgress) onProgress(100, 'Server ditemukan!');
        return cached;
      }
      clearCachedServer();
    }
  }

  // 2. Coba mDNS (paddleocr.local)
  if (onProgress) onProgress(15, 'Mencari via mDNS (paddleocr.local)...');
  const mdnsResult = await tryMdns(targetPort);
  if (mdnsResult && (!failedUrl || mdnsResult.replace(/\/+$/, '') !== failedUrl)) {
    setCachedServer(mdnsResult);
    if (onProgress) onProgress(100, 'Server ditemukan via mDNS!');
    return mdnsResult;
  }

  // 3. Kumpulkan subnet kandidat
  if (onProgress) onProgress(20, 'Mendeteksi subnet jaringan WiFi...');
  const knownSubnet = extractSubnet(failedUrl) || extractSubnet(localStorage.getItem('pcServerUrl'));
  const detectedSubnet = await getLocalSubnet();

  const candidateSubnets = [
    knownSubnet,
    detectedSubnet,
    '192.168.1',
    '192.168.0',
    '192.168.100',
    '192.168.18',
    '192.168.43',
    '192.168.2',
    '10.0.0',
    '172.20.10'
  ].filter(Boolean);

  // Buat urutan unik: subnet lama/terdeteksi dicoba paling awal
  const subnetsToTry = [...new Set(candidateSubnets)];

  for (let sIdx = 0; sIdx < subnetsToTry.length; sIdx++) {
    const sub = subnetsToTry[sIdx];
    const basePct = 25 + Math.round((sIdx / subnetsToTry.length) * 70);
    if (onProgress) onProgress(basePct, `Scanning ${sub}.x...`);

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
