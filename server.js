import http from 'http';
import os from 'os';
import { PaddleOcrService } from 'ppu-paddle-ocr';
import { Bonjour } from 'bonjour-service';

const PORT = process.env.PORT || 5174;

let paddleService = null;
let isInitializing = false;

async function getPaddleService() {
  if (paddleService) return paddleService;
  if (isInitializing) {
    while (isInitializing) {
      await new Promise(r => setTimeout(r, 100));
    }
    return paddleService;
  }

  isInitializing = true;
  console.log('[PaddleOCR PC Server] Menginisialisasi PaddleOCR Native...');
  try {
    const service = new PaddleOcrService({
      model: {
        detection: './public/models/PP-OCRv6_tiny_det.ort',
        recognition: './public/models/PP-OCRv6_tiny_rec.ort',
        charactersDictionary: './public/models/ppocrv6_tiny_dict.txt',
      },
      recognition: {
        strategy: 'per-line',
        spaceRecovery: true,
        rotateVerticalCrops: true,
      }
    });

    await service.initialize();
    paddleService = service;
    console.log('[PaddleOCR PC Server] Model PP-OCRv6 siap melayani permintaan!');
    return paddleService;
  } finally {
    isInitializing = false;
  }
}

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

const server = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, bypass-tunnel-reminder');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Health Check Endpoint
  if (req.method === 'GET' && (req.url === '/' || req.url === '/api/health')) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      status: 'ok',
      engine: 'PaddleOCR Native PC Server',
      online: true,
      uptime: Math.round(process.uptime()),
      timestamp: Date.now()
    }));
    return;
  }

  // Auto-Discovery Endpoint: returns IP addresses of this PC
  if (req.method === 'GET' && req.url === '/api/discover') {
    const ips = getLocalIpAddresses();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      service: 'paddleocr-server',
      port: PORT,
      ips,
      hostname: os.hostname()
    }));
    return;
  }

  // Paddle OCR Recognition Endpoint
  if (req.method === 'POST' && req.url === '/api/paddle-ocr') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const body = JSON.parse(rawBody);

        if (!body.image) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: 'Parameter image (base64) wajib ada.' }));
          return;
        }

        const base64Data = body.image.replace(/^data:image\/\w+;base64,/, '');
        const imgBuffer = Buffer.from(base64Data, 'base64');
        const arrayBuffer = imgBuffer.buffer.slice(imgBuffer.byteOffset, imgBuffer.byteOffset + imgBuffer.byteLength);

        console.log(`[PaddleOCR PC Server] Menerima request (${Math.round(imgBuffer.length / 1024)} KB)...`);
        const service = await getPaddleService();

        const t0 = performance.now();
        const result = await service.recognize(arrayBuffer);
        const t1 = performance.now();
        const duration = Math.round(t1 - t0);

        console.log(`[PaddleOCR PC Server] Selesai dalam ${duration} ms! Teks: ${(result.text || '').substring(0, 100).replace(/\n/g, ' ')}...`);

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          success: true,
          text: result.text || '',
          durationMs: duration
        }));
      } catch (err) {
        console.error('[PaddleOCR PC Server Error]:', err.message);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          success: false,
          error: err.message
        }));
      }
    });
    return;
  }

  // 404 for other routes
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Endpoint tidak ditemukan' }));
});

// Warm up paddle model in background on startup
getPaddleService().catch(err => {
  console.warn('[PaddleOCR PC Server] Inisialisasi awal tertunda:', err.message);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIpAddresses();
  console.log('====================================================');
  console.log('🚀 PADDLEOCR PC SERVER SIAP DIGUNAKAN');
  console.log('====================================================');
  console.log(`- Localhost      : http://localhost:${PORT}`);
  console.log(`- mDNS (auto)    : http://paddleocr.local:${PORT}`);
  ips.forEach(ip => {
    console.log(`- Local Wi-Fi    : http://${ip}:${PORT}`);
  });
  console.log('----------------------------------------------------');
  console.log('Koneksi dari Vercel:');
  console.log('1. Masukkan URL server di atas pada Pengaturan (⚙️) aplikasi di Vercel.');
  console.log('2. Jika browser HP memblokir (Mixed Content HTTPS->HTTP), gunakan HTTPS tunnel gratis:');
  console.log('   npx localtunnel --port ' + PORT + '  atau  cloudflared tunnel --url http://localhost:' + PORT);
  console.log('3. Jika PC ini mati/offline, aplikasi Vercel akan OTOMATIS beralih ke Tesseract OCR!');
  console.log('====================================================');

  // Broadcast mDNS so app can find server as paddleocr.local
  try {
    const bonjour = new Bonjour();
    bonjour.publish({
      name: 'PaddleOCR Token Server',
      type: 'paddleocr',
      port: Number(PORT),
      txt: { version: '1.0', service: 'paddleocr-server' }
    });
    console.log(`[mDNS] Service terdaftar: paddleocr.local:${PORT} (auto-discovery aktif)`);

    // Graceful shutdown
    process.on('SIGINT', () => { bonjour.unpublishAll(() => process.exit()); });
    process.on('SIGTERM', () => { bonjour.unpublishAll(() => process.exit()); });
  } catch (e) {
    console.warn('[mDNS] Gagal broadcast mDNS (tidak kritis):', e.message);
  }
});
