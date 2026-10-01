# PLN Token & Struk OCR Application

Aplikasi Progressive Web App (PWA) untuk pemindaian struk pembayaran Token PLN dan Tagihan Listrik/PDAM secara cerdas dengan dukungan cetak printer thermal via RawBT.

## 🚀 Fitur Utama

- **Dual-Engine OCR Otomatis**:
  - **PaddleOCR (Primary)**: Menghubungi Server PC lokal/tunnel untuk pemrosesan super cepat dan akurat.
  - **Tesseract OCR (Fallback/Backup)**: Otomatis aktif di browser klien jika server PC sedang offline atau tidak terjangkau.
- **Deteksi Otomatis & Cerdas**:
  - Mendeteksi 20 digit nomor token PLN, ID Pelanggan, Nama, Tarif/Daya, KWh, dan nominal tagihan.
  - Dukungan dokumen struk berupa Foto maupun file PDF digital.
- **Pencetakan Cepat**: Integrasi langsung dengan RawBT Print Service untuk printer thermal Bluetooth (ESC/POS).
- **Siap Deploy ke Vercel**: Frontend dapat di-deploy langsung ke Vercel.

## 💻 Menjalankan Server PaddleOCR di PC

Jalankan server PaddleOCR lokal di PC Anda:
```bash
npm install
npm run server
```

Server akan aktif di `http://localhost:5174` (atau IP Wi-Fi lokal).

## 🌐 Menjalankan Frontend secara Lokal

```bash
npm run dev
```

Buka `http://localhost:5174` di browser.

## ☁️ Deploy ke Vercel

1. Hubungkan repository GitHub ini ke Vercel.
2. Build command: `npm run build`
3. Output directory: `dist`
4. Di aplikasi Vercel, buka menu **Pengaturan (⚙️)** untuk memasukkan URL Server PC (IP Wi-Fi atau HTTPS Tunnel Cloudflare/Ngrok).
