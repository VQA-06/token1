/**
 * Bluetooth Printer Service
 * Using Web Bluetooth API to communicate with ESC/POS printers
 */

let bluetoothDevice = null;
let printCharacteristic = null;

// Standard GATT service and characteristic for most BT printers
const PRINTER_SERVICE_UUID = 0xFF00; 
const PRINTER_CHARACTERISTIC_UUID = 0xFF01;

/**
 * Connect to a Bluetooth Printer
 * Strategy: Auto-connect to previously permitted devices first, then fallback to manual picker.
 */
export async function connectPrinter() {
  try {
    // 0. If already connected, return
    if (bluetoothDevice && bluetoothDevice.gatt.connected && printCharacteristic) {
      return bluetoothDevice.name;
    }

    // 1. Try to find a previously permitted device (Auto-Connect)
    if (!bluetoothDevice) {
      bluetoothDevice = await getPermittedBluetoothDevice();
    }

    // 2. Attempt connection if we have a device (from persistence or previous session)
    if (bluetoothDevice) {
      try {
        if (!bluetoothDevice.gatt.connected) {
          await bluetoothDevice.gatt.connect();
        }
      } catch (e) {
        console.warn('Auto-connect failed, falling back to picker:', e);
        bluetoothDevice = null; // Force manual selection
      }
    }

    // 3. If no persistent device found OR auto-connect failed, ask user to select one (Manual Connect)
    if (!bluetoothDevice) {
      console.log('Requesting new device...');
      bluetoothDevice = await navigator.bluetooth.requestDevice({
        filters: [
          // Common Printer Services
          { services: [0xFF00] },
          { services: ['000018f0-0000-1000-8000-00805f9b34fb'] },
          { services: ['e7810a71-73ae-499d-8c15-faa9aef0c3f2'] },
          { services: ['49535343-fe7d-4ae5-8fa9-9fafd205e455'] }, // ISSC
          
          // Common Printer Name Prefixes
          { namePrefix: 'RPP' }, 
          { namePrefix: 'MPT' },
          { namePrefix: 'MTP' },
          { namePrefix: 'MP' },
          { namePrefix: 'BlueTooth' },
          { namePrefix: 'Printer' },
          { namePrefix: 'Mobile' },
          { namePrefix: 'BTP' }
        ],
        optionalServices: [
          0xFF00, 
          '000018f0-0000-1000-8000-00805f9b34fb',
          'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
          '49535343-fe7d-4ae5-8fa9-9fafd205e455',
          'battery_service'
        ]
      });
      
      // Connect to the manually selected device
      await bluetoothDevice.gatt.connect();
    }

    // At this point, bluetoothDevice.gatt.connected should be true from one of the above paths
    const server = bluetoothDevice.gatt;
    
    // Add disconnect listener for cleanup
    if (!bluetoothDevice.onGattServerDisconnected) {
        bluetoothDevice.addEventListener('gattserverdisconnected', onDisconnected);
        bluetoothDevice.onGattServerDisconnected = true; // Flag to avoid duplicate listeners
    }

    // 4. Multi-Service Fallback Strategy
    // We try specifically verified services first, then fall back to standard ones
    let service = null;
    let verifiedServices = [
      '000018f0-0000-1000-8000-00805f9b34fb',
      'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
      0xFF00
    ];

    const availableServices = await server.getPrimaryServices();
    console.log('Available services:', availableServices.map(s => s.uuid));

    // Try to match a known printer service
    for (const uuid of verifiedServices) {
      try {
        service = await server.getPrimaryService(uuid);
        if (service) {
           console.log(`Found verified service: ${uuid}`);
           break;
        }
      } catch (e) {
        // Continue to next service
      }
    }

    // If no known service matched by ID, try ANY service with a write characteristic
    if (!service) {
        console.warn('No standard printer service found. Scanning all services for WRITE capability...');
        for (const s of availableServices) {
            try {
                const characteristics = await s.getCharacteristics();
                const writeChar = characteristics.find(c => c.properties.write || c.properties.writeWithoutResponse);
                if (writeChar) {
                    service = s;
                    printCharacteristic = writeChar;
                    console.log(`Found write characteristic in service: ${s.uuid}`);
                    break;
                }
            } catch (e) { console.warn(e); }
        }
    } else {
        // If we found a service above, get its characteristic
        // Try specific verified characteristic first
        try {
            printCharacteristic = await service.getCharacteristic('00002af1-0000-1000-8000-00805f9b34fb');
        } catch (e) {
            // Fallback: Find ANY write characteristic in this service
            const characteristics = await service.getCharacteristics();
            printCharacteristic = characteristics.find(c => c.properties.write || c.properties.writeWithoutResponse);
        }
    }

    if (!printCharacteristic) {
      throw new Error('Printer terhubung tapi tidak bisa menerima data (No Write Characteristic).');
    }

    console.log('Printer successfully connected:', bluetoothDevice.name);
    return bluetoothDevice.name;

  } catch (error) {
    console.error('Bluetooth connection failed:', error);
    
    if (!navigator.bluetooth) {
      throw new Error('Browser ini tidak mendukung Bluetooth. Gunakan Chrome di Android/PC.');
    }
    if (error.name === 'NotFoundError') {
      throw new Error('Pencarian dibatalkan atau tidak ada printer yang dipilih.');
    } else if (error.name === 'SecurityError') {
      throw new Error('Akses diblokir. Pastikan web dibuka via HTTPS.');
    } else if (error.name === 'NotAllowedError') {
      throw new Error('Izin Bluetooth ditolak. Silakan izinkan akses pada browser.');
    }
    throw new Error(`Gagal Konek: ${error.message}`);
  }
}

/**
 * Retrieve a previously permitted device
 */
async function getPermittedBluetoothDevice() {
  if (!navigator.bluetooth.getDevices) {
    console.warn('navigator.bluetooth.getDevices() is not supported.');
    return null;
  }

  const devices = await navigator.bluetooth.getDevices();
  if (devices.length > 0) {
    console.log('Found permitted device(s):', devices.map(d => d.name));
    return devices[0]; 
  }
  return null;
}

function onDisconnected() {
  console.log('Bluetooth Device disconnected');
  printCharacteristic = null;
  // Note: We don't unset bluetoothDevice so we can try to reconnect to it later
}

/**
 * Send data to printer with chunking
 * @param {Uint8Array} data 
 */
async function sendToPrinter(data) {
  if (!printCharacteristic) throw new Error('Printer belum terkoneksi');
  
  // 512 byte chunks (verified size from reference app)
  const chunkSize = 512;
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.slice(i, i + chunkSize);
    await printCharacteristic.writeValue(chunk);
    // Small delay between chunks for stability
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * Format and Print PLN Receipt
 * @param {Object} data - Parsed PLN data
 */
export async function printReceipt(data) {
  if (!printCharacteristic) {
    await connectPrinter();
  }

  const encoder = new TextEncoder();
  const now = new Date();
  const dateStr = now.toLocaleDateString('id-ID') + ' ' + now.toLocaleTimeString('id-id', { hour12: false }).replace(/\./g, ':');
  
  // ESC/POS Commands
  const ESC = 0x1B;
  const GS = 0x1D;
  const LF = 0x0A;
  
  const commands = [
    // Initialize
    ESC, 0x40,
    
    // Header
    ESC, 0x61, 0x01, // Center
    ...encoder.encode(`** ${data.storeName.toUpperCase()} **\n`),
    ...encoder.encode(`${dateStr} (CU)\n`),
    LF,
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
    LF,
    
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
    LF, LF, LF, LF // Feed
  ];

  await sendToPrinter(new Uint8Array(commands));
}

function formatRow(label, value) {
  const labelWidth = 10; // Adjusted for margin
  const padding = ' '.repeat(Math.max(0, labelWidth - label.length));
  return `   ${label}${padding}${value}\n`; // ADDED 3 SPACES FOR LEFT MARGIN
}

function splitToken(token) {
  if (!token || token.length !== 20) return '---- ---- ---- ----\n---- ----';
  const line1 = `${token.substring(0, 4)}-${token.substring(4, 8)}-${token.substring(8, 12)}`;
  const line2 = `${token.substring(12, 16)}-${token.substring(16, 20)}`;
  return `${line1}\n${line2}\n`;
}

function formatNumber(num) {
  if (!num) return '0,00';
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".") + ',00';
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

console.log('[TEST] Bluetooth Module Loaded');
