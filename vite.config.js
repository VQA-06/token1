import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

function paddleOcrServerPlugin() {
  let paddleService = null;
  return {
    name: 'paddle-ocr-server',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        // Enable CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }

        // Health check endpoint
        if (req.method === 'GET' && (req.url === '/api/health' || req.url === '/api/health/')) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            status: 'ok',
            engine: 'PaddleOCR Native PC Server',
            online: true,
            timestamp: Date.now()
          }));
          return;
        }

        if (req.method !== 'POST' || !req.url.startsWith('/api/paddle-ocr')) {
          return next();
        }

        try {
          if (!paddleService) {
            console.log('[Server PC] Menginisialisasi PaddleOCR Native di Komputer...');
            const { PaddleOcrService } = await import('ppu-paddle-ocr');
            paddleService = new PaddleOcrService({
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
            await paddleService.initialize();
            console.log('[Server PC] PaddleOCR Native siap!');
          }

          const chunks = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const rawBody = Buffer.concat(chunks).toString('utf8');
          const body = JSON.parse(rawBody);

          if (!body.image) {
            throw new Error('Gambar tidak ditemukan dalam request.');
          }

          const base64Data = body.image.replace(/^data:image\/\w+;base64,/, '');
          const imgBuffer = Buffer.from(base64Data, 'base64');
          const arrayBuffer = imgBuffer.buffer.slice(imgBuffer.byteOffset, imgBuffer.byteOffset + imgBuffer.byteLength);

          console.log('[Server PC] Menerima foto dari HP (' + Math.round(imgBuffer.length / 1024) + ' KB), mengeksekusi PaddleOCR...');
          const t0 = performance.now();
          const result = await paddleService.recognize(arrayBuffer);
          const t1 = performance.now();
          const duration = Math.round(t1 - t0);
          console.log('[Server PC] Selesai membaca dalam ' + duration + ' ms! Hasil:\n' + (result.text || '').substring(0, 150) + '...');

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            success: true,
            text: result.text || '',
            durationMs: duration
          }));
        } catch (err) {
          console.error('[Server PC Error]:', err.message);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            success: false,
            error: err.message
          }));
        }
      });
    }
  };
}

export default defineConfig({
  server: {
    port: 5174,
    strictPort: true,
    host: true,
  },
  preview: {
    port: 5174,
    strictPort: true,
    host: true,
  },
  plugins: [
    paddleOcrServerPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'mask-maskable-icon.svg'],
      manifest: {
        name: 'PLN Token OCR (PaddleOCR Server PC)',
        short_name: 'PLN OCR Server',
        description: 'Scan PLN Token receipts via PaddleOCR PC Server and print to Bluetooth printer',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0f172a',
        theme_color: '#00A3E1',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,wasm,mjs,gz,json}']
      },
      devOptions: {
        enabled: true
      }
    })
  ]
});
