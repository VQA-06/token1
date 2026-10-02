/**
 * serverDiscovery.js
 * Auto-discovery untuk PaddleOCR Server di jaringan lokal.
 * 
 * Strategi:
 * 1. Coba connect ke paddleocr.local (via mDNS broadcast dari server)
 * 2. Fallback: scan subnet lokal (192.168.x.x) mencari server aktif
 */

const SERVER_PORT = 5174;
const HEALTH_TIMEOUT_MS = 1500;
const SCAN_TIMEOUT_MS = 800;
const DISCOVERY_CACHE_KEY = 'discoveredServerUrl';
const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 menit

/**
 * Cek apakah URL adalah server PaddleOCR yang valid
 */
async function probeServer(baseUrl, timeoutMs = HEALTH_TIMEOUT_MS) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${baseUrl}/api/health`, {
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
async function tryMdns() {
  const url = `http://paddleocr.local:${SERVER_PORT}`;
  console.log('[Discovery] Mencoba mDNS:', url);
  const ok = await probeServer(url);
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
      const timeout = setTimeout(() => { pc.close(); resolve(null); }, 3000);
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
async function scanSubnet(subnet, onProgress = null) {
  console.log(`[Discovery] Scanning subnet ${subnet}.1-254 ...`);
  const BATCH_SIZE = 20;
  const total = 254;

  for (let start = 1; start <= total; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, total);
    const batch = [];

    for (let i = start; i <= end; i++) {
      const ip = `${subnet}.${i}`;
      const url = `http://${ip}:${SERVER_PORT}`;
      batch.push(
        probeServer(url, SCAN_TIMEOUT_MS).then(ok => ok ? url : null)
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
 * Auto-discover server: cache -> mDNS -> scan
 * @param {Function} onProgress - callback(percent, message)
 * @returns {Promise<string|null>} URL server atau null
 */
export async function discoverServer(onProgress = null) {
  // 1. Cek cache
  const cached = getCachedServer();
  if (cached) {
    console.log('[Discovery] Cache hit, verifying:', cached);
    if (onProgress) onProgress(10, 'Memeriksa server terakhir...');
    const still_ok = await probeServer(cached);
    if (still_ok) {
      if (onProgress) onProgress(100, 'Server ditemukan!');
      return cached;
    }
    clearCachedServer();
  }

  // 2. Coba mDNS
  if (onProgress) onProgress(15, 'Mencari via mDNS (paddleocr.local)...');
  const mdnsResult = await tryMdns();
  if (mdnsResult) {
    setCachedServer(mdnsResult);
    if (onProgress) onProgress(100, 'Server ditemukan via mDNS!');
    return mdnsResult;
  }

  // 3. Fallback: scan jaringan lokal
  if (onProgress) onProgress(25, 'Mendeteksi subnet lokal...');
  const subnet = await getLocalSubnet();

  const subnetsToTry = subnet
    ? [subnet]
    : ['192.168.1', '192.168.0', '192.168.2', '10.0.0', '10.0.1'];

  for (const sub of subnetsToTry) {
    if (onProgress) onProgress(30, `Scanning ${sub}.x...`);
    const result = await scanSubnet(sub, (pct) => {
      if (onProgress) onProgress(30 + Math.round(pct * 0.6), `Scanning ${sub}.x (${pct}%)...`);
    });
    if (result) {
      setCachedServer(result);
      if (onProgress) onProgress(100, 'Server ditemukan!');
      return result;
    }
  }

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
