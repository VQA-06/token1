/**
 * RawBT Print Service
 * Communicates with RawBT Print App via rawbt: scheme
 */

export async function printViaRawBT(data) {
  try {
    const commands = generateEscPosCommands(data);
    const base64Data = btoa(String.fromCharCode(...commands));
    const rawbtUrl = `rawbt:base64,${base64Data}`;
    
    // Buka aplikasi RawBT
    window.location.href = rawbtUrl;
  } catch (error) {
    console.error('RawBT Print Error:', error);
    throw new Error('Gagal membuka aplikasi RawBT.');
  }
}

/**
 * Generate ESC/POS Commands (Copied & Adapted from bluetooth.js)
 */
function generateEscPosCommands(data) {
  const encoder = new TextEncoder();
  const now = new Date();
  const dateStr = now.toLocaleDateString('id-ID') + ' ' + now.toLocaleTimeString('id-id', { hour12: false }).replace(/\./g, ':');
  
  // ESC/POS Commands
  const ESC = 0x1B;
  const GS = 0x1D;
  const LF = 0x0A;
  
  const isPayment = data.mode === 'payment';
  const isPostpaidPLN = data.mode === 'tagihan-pln';

  let commands = [
    // Initialize
    ESC, 0x40,
    
    // Header
    ESC, 0x61, 0x01, // Center
    ...encoder.encode(`** ${data.storeName.toUpperCase()} **\n`),
    ...encoder.encode(`${dateStr} (CU)\n`),
    LF
  ];

  if (isPayment) {
    // === PAYMENT MODE (PDAM) ===
    commands.push(
      ...encoder.encode('STRUK PEMBAYARAN\n'),
      ...encoder.encode('TAGIHAN\n'),
      LF,
      
      ESC, 0x61, 0x00, // Left
      ...encoder.encode(formatRow('IDPEL', `: ${data.idpel || '-'}`)),
      ...encoder.encode(formatRow('NAMA', `: ${data.nama || '-'}`)),
      ...encoder.encode(formatRow('JENIS TAGIHAN', `: PDAM`)),
      ...encoder.encode(formatRow('LOKASI', `: ${(data.lokasi || '-').replace(/\. /g, '.')}`)), 
      ...encoder.encode(formatRow('PERIODE', `: ${data.periode || '-'}`)), 
      ...encoder.encode(formatRow('TAGIHAN', `: RP.${formatNumber(data.tagihan)}`)),
      ...encoder.encode(formatRow('NO. PESANAN', `: ${data.noPesanan || '-'}`)),
      ...encoder.encode(formatRow('BIAYA ADM', `: RP.${formatNumber(data.admin)}`)),
      
      ESC, 0x45, 0x01, // Bold On
      ...encoder.encode(formatRow('TOTAL BAYAR', `: RP.${formatNumber(data.total)}`)),
      ESC, 0x45, 0x00, // Bold Off
      LF, LF,
      
      ESC, 0x61, 0x01, // Center
      ...encoder.encode('Simpan Struk Ini\n'),
      ...encoder.encode('Sebagai Bukti Pembayaran Yang Sah\n'),
      LF,
      ...encoder.encode('-- Terima Kasih --\n'),
      LF
    );
  } else if (isPostpaidPLN) {
    // === POSTPAID PLN MODE ===
    commands.push(
      ...encoder.encode('STRUK PEMBAYARAN TAGIHAN LISTRIK\n'),
      LF,
      
      ESC, 0x61, 0x00, // Left
      ...encoder.encode(formatRow('IDPEL', `: ${data.idpel}`)),
      ...encoder.encode(formatRow('NAMA', `: ${data.nama}`)),
      ...encoder.encode(formatRow('TRF/DAYA', `: ${data.tarif}`)),
      ...encoder.encode(formatRow('PERIODE', `: ${data.periode}`)),
      ...encoder.encode(formatRow('STAND MET', `: ${data.stand}`)),
      ...encoder.encode(formatRow('TAGIHAN', `: RP. ${formatNumber(data.tagihan || data.nominal)}`)),
      ...encoder.encode(formatRow('DENDA', `: RP. ${formatNumber(data.denda)}`)),
      ...encoder.encode(formatRow('PPN', `: RP. ${formatNumberDecimal(data.ppn)}`)),
      ...encoder.encode(formatRow('NO PESANAN', `: ${data.noPesanan}`)),
      ...encoder.encode(formatRow('BIAYA ADM', `: RP. ${formatNumber(data.admin)}`)),
      
      ESC, 0x45, 0x01, // Bold On
      ...encoder.encode(formatRow('TOTAL BAYAR', `: RP. ${formatNumber(data.total)}`)),
      ESC, 0x45, 0x00, // Bold Off
      LF, LF,
      
      ESC, 0x61, 0x01, // Center
      ...encoder.encode('Simpan Struk Ini\n'),
      ...encoder.encode('Sebagai Bukti Pembayaran Yang Sah\n'),
      LF,
      ...encoder.encode('-- Terima Kasih --\n'),
      LF
    );
  } else {
    // === TOKEN MODE ===
    commands.push(
      ...encoder.encode('STRUK PEMBELIAN LISTRIK\n'),
      ...encoder.encode('PRABAYAR\n'),
      LF,
      
      ESC, 0x61, 0x00, // Left
      ...encoder.encode(formatRow('IDPEL', `: ${data.idpel}`)),
      ...encoder.encode(formatRow('NAMA', `: ${data.nama}`)),
      ...encoder.encode(formatRow('TRF/DAYA', `: ${data.tarif}`)),
      ...encoder.encode(formatRow('NOMINAL', `: RP. ${formatNumber(data.nominal)}`)),
      ...encoder.encode(formatRow('PPN', `: RP. ${formatNumberDecimal(data.ppn)}`)),
      ...encoder.encode(formatRow('ANGS/MAT', `: RP. 0,00/0,00`)),
      ...encoder.encode(formatRow('RP TOKEN', `: RP. ${formatNumber(data.nominal)}`)),
      ...encoder.encode(formatRow('JML KWH', `: ${formatKwh(data.kwh)}`)),
      ...encoder.encode(formatRow('BIAYA ADM', `: RP. ${formatNumber(data.admin)}`)),
      ESC, 0x45, 0x01, // Bold On
      ...encoder.encode(formatRow('TOTAL BAYAR', `: RP. ${formatNumber(data.total)}`)),
      ESC, 0x45, 0x00, // Bold Off
      LF, LF,
      
      ESC, 0x61, 0x01, // Center
      ...encoder.encode('-- TOKEN --\n'),
      ESC, 0x45, 0x01, // Bold On
      GS, 0x21, 0x11, // Double height & width
      ...encoder.encode(splitToken(data.token)),
      GS, 0x21, 0x00, // Normal size
      ESC, 0x45, 0x00, // Bold Off
      LF,
      
      ESC, 0x61, 0x01, // Center
      ...encoder.encode('Info Hubungi Call Center 123\n'),
      ...encoder.encode('Atau Hubungi PLN Terdekat\n'),
      LF
    );
  }

  return new Uint8Array(commands); 
}

// Helpers
function formatRow(label, value) {
  const labelWidth = 14; 
  const padding = ' '.repeat(Math.max(0, labelWidth - label.length));
  return `   ${label}${padding}${value}\n`;
}

function splitToken(token) {
  if (!token || token.length !== 20) return '---- ---- ---- ----\n---- ----';
  const line1 = `${token.substring(0, 4)}-${token.substring(4, 8)}-${token.substring(8, 12)}`;
  const line2 = `${token.substring(12, 16)}-${token.substring(16, 20)}`;
  return `${line1}\n${line2}\n`;
}

function formatNumber(num) {
  if (!num) return '0';
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function formatNumberDecimal(val) {
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
  if (!clean.includes('.') && num > 1000) num = num / 100;
  return num.toFixed(1) + 'KWH';
}
