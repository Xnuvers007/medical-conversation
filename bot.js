const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } = require('baileys');
const fs = require('fs');
const pino = require('pino');
const readline = require('readline');
const path = require('path');
const qrcode = require('qrcode');

const activeSessions = {};

// Create necessary directories if they don't exist
const mediaDir = path.join(__dirname, 'media');
if (!fs.existsSync(mediaDir)) {
  fs.mkdirSync(mediaDir, { recursive: true });
}

function removeAuthFolder() {
  const authDir = path.join(__dirname, 'auth');
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
    console.log('Folder "auth" telah dihapus. Silakan lakukan login ulang.');
  }
}

async function initWhatsAppBot(db) {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  let sock = makeWASocket({
    logger: pino({ level: 'fatal' }),
    auth: state,
    printQRInTerminal: true,
  });

  if (!state.creds.me) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Login dengan pairing code atau QR code? (p/q): ', async (answer) => {
      if (answer.toLowerCase() === 'p') {
        // Pairing code flow
        rl.question('Masukkan nomor WhatsApp (contoh: 628123456789): ', async (waNumber) => {
          if (/^\d+$/.test(waNumber.trim()) && waNumber.startsWith('62')) {
            const code = await sock.requestPairingCode(waNumber.trim());
            console.log('\nMasukkan pairing code di WhatsApp:', code);
            rl.close();
          } else {
            console.log('Nomor tidak valid.');
            rl.close();
            process.exit(1);
          }
        });
      } else if (answer.toLowerCase() === 'q') {
        // QR code flow
        sock.ev.on('connection.update', async (update) => {
          const { connection, lastDisconnect, qr } = update;
          if (qr) {
            // Cetak QR Code ke terminal
            console.log('QR Code sudah dibuat, silakan pindai dengan WhatsApp Anda:');
            console.log(await qrcode.toString(qr, { type: 'terminal', scale: 5 }));
          }

          if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
              removeAuthFolder();
              initWhatsAppBot(db);
            }
            else {
              console.log('Sesi logout. Hapus folder "auth" untuk login ulang.');
            }
          } else if (connection === 'open') {
            console.log('Terhubung ke WhatsApp');
          }
        });
        rl.close();
      } else {
        console.log('Pilihan tidak valid. Harap pilih "p" untuk Pairing Code atau "q" untuk QR Code.');
        rl.close();
        process.exit(1);
      }
    });
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        removeAuthFolder();
        initWhatsAppBot(db);
      }
      else {
        console.log('Sesi logout. Hapus folder "auth" untuk login ulang.');
      }
    } else if (connection === 'open') {
      console.log('Terhubung ke WhatsApp');
    }
  });

  sock.ev.on('creds.update', saveCreds);


  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const senderNumber = sender.split('@')[0];
    
    // Extract text message if exists
    const messageContent = msg.message.conversation || 
                           msg.message.extendedTextMessage?.text || 
                           msg.message.imageMessage?.caption || 
                           msg.message.videoMessage?.caption || 
                           "";

    // Check if the message has media (image, video, document, audio)
    const hasMedia = !!(msg.message.imageMessage || 
                       msg.message.videoMessage || 
                       msg.message.documentMessage || 
                       msg.message.audioMessage);

    // Handle .gambar command
    if (messageContent.toLowerCase() === '.gambar') {
      // Example sending a test image file
      const imagePath = path.join(__dirname, 'media', 'test.jpg');
      
      // Check if test image exists, otherwise send an error message
      if (fs.existsSync(imagePath)) {
        await handleForwardMedia(sock, db, sender, senderNumber, 'image', imagePath, msg);
      } else {
        await sock.sendMessage(sender, { text: "File gambar test.jpg tidak ditemukan di folder media." });
      }
      return;
    }

    // Handle .kirim
    if (messageContent.startsWith(".kirim ")) {
      const dokterPhone = senderNumber;
      const parts = messageContent.split(" ");
      if (parts.length < 3) {
        await sock.sendMessage(sender, { text: "Format salah. Gunakan: .kirim 62xxxx pesan" });
        return;
      }

      const targetNumber = parts[1];
      const actualMessage = parts.slice(2).join(" ");
      const targetJid = `${targetNumber}@s.whatsapp.net`;

      db.get(`
        SELECT b.id AS booking_id, u.username, d.phone, b.is_active
        FROM bookings b
        JOIN doctors d ON b.doctor_id = d.id
        JOIN users u ON b.user_id = u.id
        WHERE d.phone = ? AND u.username = ?
        ORDER BY b.created_at DESC LIMIT 1
      `, [dokterPhone, targetNumber], async (err, booking) => {
        if (err || !booking) {
          await sock.sendMessage(sender, { text: `Tidak ditemukan sesi aktif dengan pasien ${targetNumber}.` });
          return;
        }

        if (!booking.is_active) {
          await sock.sendMessage(sender, { text: `Sesi dengan pasien ${targetNumber} sudah berakhir.` });
          return;
        }

        await sock.sendMessage(targetJid, { text: actualMessage });
        db.run(`INSERT INTO messages (booking_id, sender, message, msg_id) VALUES (?, ?, ?, ?)`,
          [booking.booking_id, "doctor", actualMessage, msg.key.id]);

        await sock.sendMessage(sender, { text: "Pesan berhasil dikirim ke pasien." });
      });
      return;
    }

    // Handle .listpasien
    if (messageContent.toLowerCase() === ".listpasien") {
      const dokterPhone = senderNumber;
      db.all(`
        SELECT u.username, b.created_at
        FROM bookings b
        JOIN users u ON b.user_id = u.id
        JOIN doctors d ON b.doctor_id = d.id
        WHERE d.phone = ? AND b.is_active = 1
        ORDER BY b.created_at DESC
      `, [dokterPhone], async (err, rows) => {
        if (err) {
          await sock.sendMessage(sender, { text: "Gagal mengambil daftar pasien aktif." });
          return;
        }

        if (rows.length === 0) {
          await sock.sendMessage(sender, { text: "Tidak ada pasien yang sedang aktif konsultasi." });
          return;
        }

        // const listText = rows.map((r, i) => `${i + 1}. ${r.username} (mulai ${r.created_at})`).join("\n");
        const listText = rows.map((r, i) => {
          const createdAt = new Date(r.created_at);
          createdAt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }); // Menetapkan zona waktu WIB
          const hari = createdAt.getDate().toString().padStart(2, '0');
          const bulan = (createdAt.getMonth() + 1).toString().padStart(2, '0');
          const tahun = createdAt.getFullYear();
          const jam = createdAt.getHours().toString().padStart(2, '0');
          const menit = createdAt.getMinutes().toString().padStart(2, '0');
          const detik = createdAt.getSeconds().toString().padStart(2, '0');
    
          return `${i + 1}. ${r.username} (mulai ${hari}/${bulan}/${tahun}, ${jam}.${menit}.${detik} WIB)`;
        }).join("\n");    
        
        await sock.sendMessage(sender, { text: `Pasien aktif saat ini:\n\n${listText}` });
      });
      return;
    }

    // Handle .lanjut dan simpan sesi aktif
    if (messageContent.toLowerCase().startsWith(".lanjut")) {
      const dokterPhone = senderNumber;
      const parts = messageContent.split(" ");
      const username = parts[1];

      const sql = `
        SELECT b.id AS booking_id, u.username, d.phone
        FROM bookings b
        JOIN doctors d ON b.doctor_id = d.id
        JOIN users u ON b.user_id = u.id
        WHERE d.phone = ? ${username ? "AND u.username = ?" : ""}
        AND b.is_active = 1
        ORDER BY b.created_at DESC LIMIT 1
      `;

      const params = username ? [dokterPhone, username] : [dokterPhone];

      db.get(sql, params, async (err, booking) => {
        if (err || !booking) {
          await sock.sendMessage(sender, { text: "Tidak ditemukan pasien aktif untuk dilanjutkan." });
          return;
        }

        activeSessions[dokterPhone] = booking.booking_id;

        await sock.sendMessage(sender, {
          text: `Sesi dengan pasien ${booking.username} telah dilanjutkan. Anda dapat mulai berkonsultasi.`
        });

        await sock.sendMessage(`${booking.username}@s.whatsapp.net`, {
          text: `Dokter telah kembali ke sesi konsultasi dengan Anda. Silakan lanjutkan percakapan.`
        });
      });

      return;
    }

    // Handle regular message or media forwarding
    let query = `
      SELECT b.id AS booking_id, u.username, d.phone, b.is_active
      FROM bookings b
      JOIN doctors d ON b.doctor_id = d.id
      JOIN users u ON b.user_id = u.id
      WHERE b.id = ?
    `;
    let params = [activeSessions[senderNumber]];

    if (!activeSessions[senderNumber]) {
      query = `
        SELECT b.id AS booking_id, u.username, d.phone, b.is_active
        FROM bookings b
        JOIN doctors d ON b.doctor_id = d.id
        JOIN users u ON b.user_id = u.id
        WHERE d.phone = ? OR u.username = ?
        ORDER BY b.created_at DESC LIMIT 1
      `;
      params = [senderNumber, senderNumber];
    }

    db.get(query, params, async (err, booking) => {
      if (err || !booking) return;

      const pasienJid = `${booking.username}@s.whatsapp.net`;
      const dokterJid = `${booking.phone}@s.whatsapp.net`;
      let targetJid, fromRole;

      if (sender === dokterJid) {
        targetJid = pasienJid;
        fromRole = "doctor";
      } else if (sender === pasienJid) {
        targetJid = dokterJid;
        fromRole = "patient";
      } else return;

      if (!booking.is_active) {
        await sock.sendMessage(sender, {
          text: "Sesi konsultasi telah berakhir. Silakan buat booking baru di website untuk melanjutkan."
        });
        return;
      }

      if (["akhiri", "stop"].includes(messageContent.toLowerCase())) {
        db.run(`UPDATE bookings SET is_active = 0 WHERE id = ?`, [booking.booking_id]);
        delete activeSessions[booking.phone]; // Reset sesi aktif jika sesi diakhiri
        await sock.sendMessage(dokterJid, { text: "Percakapan telah diakhiri. Silakan ke website untuk konsultasi kembali." });
        await sock.sendMessage(pasienJid, { text: "Percakapan telah diakhiri. Silakan ke website untuk konsultasi kembali." });
        return;
      }

      // Handle text message
      if (messageContent && !hasMedia) {
        await sock.sendMessage(targetJid, { text: messageContent });
        db.run(`INSERT INTO messages (booking_id, sender, message, msg_id) VALUES (?, ?, ?, ?)`,
          [booking.booking_id, fromRole, messageContent, msg.key.id]);
      } 
      // Handle media message
      else if (hasMedia) {
        const mediaType = msg.message.imageMessage ? 'image' : 
                         msg.message.videoMessage ? 'video' : 
                         msg.message.documentMessage ? 'document' : 
                         msg.message.audioMessage ? 'audio' : null;
        
        if (mediaType) {
          // Download and forward the media
          const mediaPath = await downloadMedia(sock, msg.message, mediaType);
          if (mediaPath) {
            // Forward the media to the target
            await forwardMedia(sock, targetJid, mediaType, mediaPath, messageContent);
            
            // Save message to database
            const mediaInfo = `[${mediaType.toUpperCase()}] ${messageContent || ''}`;
            db.run(`INSERT INTO messages (booking_id, sender, message, msg_id, has_media) VALUES (?, ?, ?, ?, 1)`,
              [booking.booking_id, fromRole, mediaInfo, msg.key.id]);
            
            // Clean up downloaded media
            setTimeout(() => {
              try {
                fs.unlinkSync(mediaPath);
              } catch (err) {
                console.error('Error deleting temporary media file:', err);
              }
            }, 30000); // Delete after 30 seconds
          }
        }
      }
    });
  });

  // Kirim pesan pertama dari pasien
  setInterval(() => {
    db.all(`SELECT b.id AS booking_id, b.message, d.phone
            FROM bookings b
            JOIN doctors d ON b.doctor_id = d.id
            WHERE b.is_active = 1 AND b.id NOT IN (
              SELECT booking_id FROM messages WHERE sender = 'patient'
            )`, [], async (err, rows) => {
      for (let row of rows) {
        db.get(`SELECT COUNT(*) AS count FROM messages WHERE booking_id = ? AND sender = 'patient'`, [row.booking_id], async (err, result) => {
          if (result.count === 0 && row.message && row.message.trim() !== "") {
            db.run(`INSERT INTO messages (booking_id, sender, message) VALUES (?, 'patient', ?)`,
              [row.booking_id, row.message]);
            await sock.sendMessage(row.phone + '@s.whatsapp.net', { text: row.message });
          }
        });
      }
    });
  }, 10000);
}

// Function to download media from message
async function downloadMedia(sock, message, mediaType) {
  try {
    let mediaMessage;
    let stream;
    
    switch (mediaType) {
      case 'image':
        mediaMessage = message.imageMessage;
        stream = await downloadContentFromMessage(mediaMessage, 'image');
        break;
      case 'video':
        mediaMessage = message.videoMessage;
        stream = await downloadContentFromMessage(mediaMessage, 'video');
        break;
      case 'document':
        mediaMessage = message.documentMessage;
        stream = await downloadContentFromMessage(mediaMessage, 'document');
        break;
      case 'audio':
        mediaMessage = message.audioMessage;
        stream = await downloadContentFromMessage(mediaMessage, 'audio');
        break;
      default:
        return null;
    }
    
    // Generate filename
    const filename = mediaMessage.fileName || 
                    `${mediaType}_${Date.now()}.${getExtensionFromMimetype(mediaMessage.mimetype)}`;
    const mediaPath = path.join(__dirname, 'media', filename);
    
    // Write to file
    const buffer = await streamToBuffer(stream);
    fs.writeFileSync(mediaPath, buffer);
    
    return mediaPath;
  } catch (error) {
    console.error(`Error downloading ${mediaType}:`, error);
    return null;
  }
}

// Function to forward media
async function forwardMedia(sock, targetJid, mediaType, mediaPath, caption = '') {
  try {
    let mediaMessage = {};
    
    switch (mediaType) {
      case 'image':
        mediaMessage = {
          image: { url: mediaPath },
          caption: caption || ''
        };
        break;
      case 'video':
        mediaMessage = {
          video: { url: mediaPath },
          caption: caption || ''
        };
        break;
      case 'document':
        mediaMessage = {
          document: { url: mediaPath },
          caption: caption || '',
          fileName: path.basename(mediaPath)
        };
        break;
      case 'audio':
        mediaMessage = {
          audio: { url: mediaPath },
          mimetype: 'audio/mp4'
        };
        break;
      default:
        return false;
    }
    
    await sock.sendMessage(targetJid, mediaMessage);
    return true;
  } catch (error) {
    console.error(`Error forwarding ${mediaType}:`, error);
    return false;
  }
}

// Helper function for the .gambar command
async function handleForwardMedia(sock, db, sender, senderNumber, mediaType, mediaPath, quotedMsg) {
  let query = `
    SELECT b.id AS booking_id, u.username, d.phone, b.is_active
    FROM bookings b
    JOIN doctors d ON b.doctor_id = d.id
    JOIN users u ON b.user_id = u.id
    WHERE b.id = ?
  `;
  let params = [activeSessions[senderNumber]];

  if (!activeSessions[senderNumber]) {
    query = `
      SELECT b.id AS booking_id, u.username, d.phone, b.is_active
      FROM bookings b
      JOIN doctors d ON b.doctor_id = d.id
      JOIN users u ON b.user_id = u.id
      WHERE d.phone = ? OR u.username = ?
      ORDER BY b.created_at DESC LIMIT 1
    `;
    params = [senderNumber, senderNumber];
  }

  db.get(query, params, async (err, booking) => {
    if (err || !booking) {
      await sock.sendMessage(sender, { text: "Tidak ditemukan sesi konsultasi aktif." });
      return;
    }

    const pasienJid = `${booking.username}@s.whatsapp.net`;
    const dokterJid = `${booking.phone}@s.whatsapp.net`;
    let targetJid, fromRole;

    if (sender === dokterJid) {
      targetJid = pasienJid;
      fromRole = "doctor";
    } else if (sender === pasienJid) {
      targetJid = dokterJid;
      fromRole = "patient";
    } else {
      await sock.sendMessage(sender, { text: "Tidak dapat menentukan target penerima." });
      return;
    }

    if (!booking.is_active) {
      await sock.sendMessage(sender, {
        text: "Sesi konsultasi telah berakhir. Silakan buat booking baru di website untuk melanjutkan."
      });
      return;
    }

    // Forward the media to the target
    await forwardMedia(sock, targetJid, mediaType, mediaPath, "Gambar dari sistem");
    
    // Save message to database
    const mediaInfo = `[${mediaType.toUpperCase()}] Gambar dari sistem`;
    db.run(`INSERT INTO messages (booking_id, sender, message, msg_id, has_media) VALUES (?, ?, ?, ?, 1)`,
      [booking.booking_id, fromRole, mediaInfo, quotedMsg.key.id]);
      
    await sock.sendMessage(sender, { text: "Gambar berhasil dikirim." });
  });
}

// Helper function to convert stream to buffer
async function streamToBuffer(stream) {
  let chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Helper function to get file extension from mimetype
function getExtensionFromMimetype(mimetype) {
  const mimeMap = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'video/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/msword': 'doc'
  };
  
  return mimeMap[mimetype] || 'bin';
}

module.exports = { initWhatsAppBot };