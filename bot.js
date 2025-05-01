const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const fs = require('fs');
const pino = require('pino');
const readline = require('readline');
const path = require('path');

async function initWhatsAppBot(db) {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  let sock = makeWASocket({
    logger: pino({ level: 'silent' }), 
    auth: state,
    printQRInTerminal: true,
  });

  if (state.creds && state.creds.me) {
    console.log('\nSesi masih ada, langsung terhubung ke WhatsApp');
} else {
    // Menggunakan pairing code atau QR
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    console.log('\n=== Login WhatsApp ===');
    rl.question('\nJika sudah memilih N/Y di atas, tinggal enter saja\nLogin menggunakan pairing code? (y/n): ', (answer) => {
        if (answer.toLowerCase() === 'y') {
            rl.question('Masukkan nomor WhatsApp (contoh: 628123456789): ', async (waNumber) => {
                if (/^\d+$/.test(waNumber.trim()) && waNumber.startsWith('62')) {
                    // Mengirim permintaan pairing code
                    const code = await sock.requestPairingCode(waNumber.trim());
                    console.log('\nMasukkan pairing code di WhatsApp:', code);
                    rl.close();
                } else {
                    console.log('Nomor tidak valid! Harus berupa angka dan diawali dengan 62.');
                    rl.close();
                    process.exit(1); // Hentikan program untuk memperbaiki input
                }
            });
        } else {
            // Ketika memilih N, menampilkan QR code di terminal
            console.log('QR code akan muncul di terminal ini.');
            sock = makeWASocket({
                logger: pino({ level: 'silent' }), // Mengurangi output log
                auth: state,
                printQRInTerminal: true, // Menampilkan QR code di terminal
            });
            rl.close();
        }
    });
}

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
        const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
            console.log('Mencoba menghubungkan ulang ke WhatsApp...');
            initWhatsAppBot(db); 
        } else {
            console.log('Sesi habis. Hapus folder "sessions" untuk login ulang.');
        }
    } else if (connection === 'open') {
        console.log('\nTerhubung ke WhatsApp');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const content = msg.message.conversation || msg.message.extendedTextMessage?.text;
    const messageText = content || `${msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || msg.message.documentMessage?.caption}`;

    /*
        if (messageText && messageText.trim() !== "") {
        db.get(`SELECT b.id AS booking_id, u.id AS user_id, u.name, u.role, u.username, d.phone
                FROM bookings b
                JOIN doctors d ON b.doctor_id = d.id
                JOIN users u ON b.user_id = u.id
                WHERE d.phone = ? AND b.is_active = 1
                ORDER BY b.created_at DESC LIMIT 1`, [sender.split('@')[0]], async (err, booking) => {
          if (booking) {
            // Simpan pesan dokter dan teruskan ke pasien
            db.run(`INSERT INTO messages (booking_id, sender, message) VALUES (?, 'doctor', ?)`, [booking.booking_id, content]);
            const patientJid = booking.username + '@s.whatsapp.net';
            await sock.sendMessage(patientJid, { text: messageText });
          }
        });
      } else {
        console.log("No content to send.");
      }
        */

    db.get(`SELECT b.id AS booking_id, u.id AS user_id, u.name, u.role, u.username, d.phone
            FROM bookings b
            JOIN doctors d ON b.doctor_id = d.id
            JOIN users u ON b.user_id = u.id
            WHERE d.phone = ? AND b.is_active = 1
            ORDER BY b.created_at DESC LIMIT 1`, [sender.split('@')[0]], async (err, booking) => {
      if (booking) {
        // Simpan pesan dokter dan teruskan ke pasien
        db.run(`INSERT INTO messages (booking_id, sender, message) VALUES (?, 'doctor', ?)`, [booking.booking_id, content]);
        const patientJid = booking.username + '@s.whatsapp.net';
        await sock.sendMessage(patientJid, { text: messageText });

        // Jika pesan berisi media, teruskan ke dokter
        if (msg.message.imageMessage || msg.message.videoMessage || msg.message.documentMessage) {
          const mediaMessage = msg.message.imageMessage || msg.message.videoMessage || msg.message.documentMessage;
          await sock.sendMessage(patientJid, { [mediaMessage.mimetype.split('/')[0]]: mediaMessage });
        }
      }
    });
  });

  // Polling berkala untuk cek booking baru dari pasien dan kirim ke dokter
  setInterval(() => {
    db.all(`SELECT b.id AS booking_id, b.message, d.phone FROM bookings b
            JOIN doctors d ON b.doctor_id = d.id
            WHERE b.is_active = 1 AND b.id NOT IN (
              SELECT booking_id FROM messages WHERE sender = 'patient'
            )`, [], async (err, rows) => {
      for (let row of rows) {
        // Simpan pesan pertama dan kirim ke dokter
        if (row.message && row.message.trim() !== "") {
            db.run(`INSERT INTO messages (booking_id, sender, message) VALUES (?, 'patient', ?)`, [row.booking_id, row.message]);
            await sock.sendMessage(row.phone + '@s.whatsapp.net', { text: row.message });
          } else {
            console.log("Booking message is empty, skipping...");
          }
        }
    });
  }, 10000); // Cek setiap 10 detik
}

module.exports = { initWhatsAppBot };
