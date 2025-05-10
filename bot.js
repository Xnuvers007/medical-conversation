const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } = require('baileys');
const { promiseTimeout } = require('baileys/lib/Utils/generics');
const fs = require('fs');
const pino = require('pino');
const readline = require('readline');
const path = require('path');
const chalk = require('chalk');

const axios = require('axios');

require('dotenv').config();

const activeSessions = {};

const { DEEPSEEKER_API_KEY } = process.env;
if (!DEEPSEEKER_API_KEY) {
  console.error(chalk.red('DEEPSEEKER_API_KEY is not set in .env file.'));
  process.exit(1);
}

// Create necessary directories if they don't exist
const mediaDir = path.join(__dirname, 'media');
if (!fs.existsSync(mediaDir)) {
  fs.mkdirSync(mediaDir, { recursive: true });
}

async function queryAI(question) {
  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'deepseek/deepseek-prover-v2:free',
        messages: [
          {
            role: 'user',
            content: question,
          },
        ],
        // max_tokens: 200,
        // temperature: 0.7,
        temperature: 0,
        top_p: 1,
        n: 1,
        stop: null,
        presence_penalty: 0,
        frequency_penalty: 0,
        stream: false,
        language: 'id',
      },
      {
        headers: {
          'Authorization': `Bearer ${DEEPSEEKER_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const data = response.data;
    console.log(JSON.stringify(data, null, 2)); // Print response with indent
    return data.choices[0].message.content;  // Return the AI's message

  } catch (error) {
    console.error('Error querying AI:', error);
    return "Sorry, there was an issue contacting the AI.";
  }
}


async function initWhatsAppBot(db) {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  let sock = makeWASocket({
    logger: pino({ level: 'info' }),
    auth: state,
    printQRInTerminal: true,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    timeoutMs: 60000,
  });

  if (!state.creds.me) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(chalk.yellow('Apakah anda ingin login ? (y/n): '), answer => {
      if (answer.toLowerCase() === 'y') {
        rl.question(chalk.green('Masukkan nomor WhatsApp (contoh: 628123456789): '), async (waNumber) => {
          if (!waNumber) {
            console.log('Nomor tidak boleh kosong.');
            rl.close();
            process.exit(1);
          } else if (!waNumber.startsWith('62')) {
            console.log('Nomor harus diawali dengan 62.');
            rl.close();
            process.exit(1);
          } else if (waNumber.length < 11) {
            console.log('Nomor tidak valid.');
            rl.close();
            process.exit(1);
          } else if (waNumber.length > 15) {
            console.log('Nomor tidak valid.');
            rl.close();
            process.exit(1);
          }
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
      } else {
        rl.close();
        process.exit(1);
      }
    });
  }
    
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    let jam = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' });
    let date = new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log(chalk.yellow('Koneksi terputus. Mencoba untuk reconnect...'));
        setTimeout(() => {
          initWhatsAppBot(db); // Melakukan reconnect setelah 5 detik
        }, 5000);
      }
      else {
        console.log('Sesi logout. Hapus folder "auth" untuk login ulang.');
      }
    } else if (connection === 'open') {
      console.log('Terhubung ke WhatsApp');
      sock.sendMessage(sock.user.id, { text: `Bot aktif pada ${jam} WIB\nTanggal: ${date}` });
      sock.updateProfileStatus(`Bot aktif pada ${jam} WIB\nTanggal: ${date}`);
      sock.rejectCall();
      sock.sendMessage('status@broadcast', { text: `Bot aktif pada ${jam} WIB\nTanggal: ${date}` });
      console.log('Bot aktif pada', jam, 'WIB', date);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  const menus = {
    general: [
      { command: '.menu', description: 'Menampilkan menu' },
      { command: '.gambar', description: 'Mengirim gambar contoh' },
      { command: '.ai', description: 'Bertanya kepada AI' },
      { command: '.tanyaai', description: 'Bertanya kepada AI dengan format lain' },
    ],
    doctor: [
      { command: '.listpasien', description: 'Menampilkan daftar pasien aktif' },
      { command: '.kirim', description: 'Mengirim pesan ke pasien' },
      { command: '.lanjut', description: 'Melanjutkan sesi konsultasi dengan pasien' },
      { command: '.akhiri', description: 'Mengakhiri sesi konsultasi' },
      { command: '.stop', description: 'Mengakhiri sesi konsultasi' },
      { command: '.ai', description: 'Bertanya kepada AI' },
      { command: '.tanyaai', description: 'Bertanya kepada AI dengan format lain' },
    ],
    patient: [
      { command: '.ai', description: 'Bertanya kepada AI' },
      { command: '.tanyaai', description: 'Bertanya kepada AI dengan format lain' },
      { command: '.gambar', description: 'Mengirim gambar contoh' },
      { command: '.akhiri', description: 'Mengakhiri sesi konsultasi' },
      { command: '.stop', description: 'Mengakhiri sesi konsultasi' },
    ],
  };

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const senderNumber = sender.split('@')[0];
    
    // sock.sendMessage('status@broadcast', { text: `Pesan dari ${senderNumber}` });
    // sock.sendMessage('status@broadcast', { text: `Bot aktif pada ${jam} WIB\nTanggal: ${date}` }, { quoted: { key: { fromMe: true, remoteJid: 'status@broadcast' }, message: { text: `Bot aktif pada ${jam} WIB\nTanggal: ${date}` } } });

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

  //   const isFirstMessage = !activeSessions[senderNumber];
    
  //   if (isFirstMessage) {
  //     db.get(`
  //         SELECT role FROM users WHERE phone = ?
  //     `, [senderNumber], async (err, user) => {
  //         if (err || !user) {
  //             await sock.sendMessage(sender, { text: "Selamat datang! Ketik .menu untuk melihat fitur yang tersedia." });
  //             return;
  //         }

  //         if (user.role === 'doctor') {
  //             await sock.sendMessage(sender, { text: "Selamat datang Dokter! Ketik .menu untuk melihat fitur yang tersedia." });
  //         } else if (user.role === 'patient') {
  //             await sock.sendMessage(sender, { text: "Selamat datang Pasien! Ketik .menu untuk melihat fitur yang tersedia. Fitur yang tersedia untuk Anda: .ai dan .gambar." });
  //         }
  //     });
  // }

  const isFirstMessage = !activeSessions[senderNumber];

if (isFirstMessage) {
  db.get(`
      SELECT role, welcome_sent FROM users WHERE phone = ?
  `, [senderNumber], async (err, user) => {
      if (err || !user) {
          await sock.sendMessage(sender, { text: "Selamat datang! Ketik .menu untuk melihat fitur yang tersedia." });
          db.run(`UPDATE users SET welcome_sent = 1 WHERE phone = ?`, [senderNumber]);
      } else if (!user.welcome_sent) {
          if (user.role === 'doctor') {
              await sock.sendMessage(sender, { text: "Selamat datang Dokter! Ketik .menu untuk melihat fitur yang tersedia." });
          } else if (user.role === 'patient') {
              await sock.sendMessage(sender, { text: "Selamat datang Pasien! Ketik .menu untuk melihat fitur yang tersedia. Fitur yang tersedia untuk Anda: .ai dan .gambar." });
          }

          // Tandai bahwa pesan selamat datang sudah dikirim
          db.run(`UPDATE users SET welcome_sent = 1 WHERE phone = ?`, [senderNumber]);
      }
  });
}

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

    console.log("Message Content:", messageContent); // Menampilkan isi pesan yang diterima
    if (messageContent.toLowerCase().startsWith('.ai') || messageContent.toLowerCase().startsWith('.tanyaai')) {
        // Extract the question part by removing the command
        const command = messageContent.toLowerCase().startsWith('.ai') ? '.ai' : '.tanyaai';
        const question = messageContent.substring(command.length).trim();
        
        if (!question.length) {
            console.log("Pesan kosong diterima");
            await sock.sendMessage(sender, { text: "Teksnya mana?" });
        } else {
            const filteredQuestion = `Sebagai asisten dokter, jawab pertanyaan berikut dengan menggunakan pengetahuan medis: ${question}`;
            await sock.sendMessage(sender, { text: "Silakan tunggu sebentar, saya sedang mencari jawabannya..." });
            
            // Query AI for the question
            const aiResponse = await queryAI(filteredQuestion);
            await sock.sendMessage(sender, { text: aiResponse });
        }
        return;
    }

    if (messageContent.toLowerCase() === '.menu') {
      try {
          // Ekstrak nomor telepon dari sender JID
          const senderJid = msg.key.remoteJid;
          const senderNumber = senderJid.split('@')[0];
          
          // Periksa apakah nomor telepon valid
          if (!/^\+?[1-9]\d{1,14}$/.test(senderNumber.replace('whatsapp:', ''))) {
              await sock.sendMessage(senderJid, { text: "Nomor telepon tidak valid." });
              return;
          }
  
          let menuText = "Menu:\n\n";
  
          // Periksa pengguna di database
          const userQuery = `SELECT id, username, role FROM users WHERE username = ?`;
          const doctorQuery = `SELECT id, phone FROM doctors WHERE phone = ?`;
  
          // Cek di users tabel
          db.get(userQuery, [senderNumber], async (err, user) => {
              if (err) {
                  console.error('Error saat memeriksa pengguna:', err);
                  await sock.sendMessage(senderJid, { text: 'Terjadi kesalahan saat memeriksa pengguna.' });
                  return;
              }
  
              if (user) {
                  // Pengguna terdaftar di users, tampilkan menu pasien
                  menuText += "Anda terdaftar sebagai: Pasien\n\n";
                  menus.patient.forEach(item => {
                      menuText += `${item.command} - ${item.description}\n`;
                  });
                  await sock.sendMessage(senderJid, { text: menuText });
                  return;
              }
  
              // Cek di doctors tabel
              db.get(doctorQuery, [senderNumber], async (err, doctor) => {
                  if (err) {
                      console.error('Error saat memeriksa dokter:', err);
                      await sock.sendMessage(senderJid, { text: 'Terjadi kesalahan saat memeriksa dokter.' });
                      return;
                  }
  
                  if (doctor) {
                      // Dokter terdaftar, tampilkan menu dokter
                      menuText += "Anda terdaftar sebagai: Dokter\n\n";
                      menus.doctor.forEach(item => {
                          menuText += `${item.command} - ${item.description}\n`;
                      });
                      await sock.sendMessage(senderJid, { text: menuText });
                      return;
                  }
  
              if (!user && !doctor) {
                  // Pengguna tidak terdaftar, tampilkan menu umum
                  menuText += "Anda tidak terdaftar dan Anda adalah pengguna umum. Silakan daftar untuk menggunakan layanan kami.\n\n";
                  menus.general.forEach(item => {
                      menuText += `${item.command} - ${item.description}\n`;
                  });
                  await sock.sendMessage(senderJid, { text: menuText });
                  return;
              }
              });
          });
      } catch (error) {
          console.error('Error saat menampilkan menu:', error);
          await sock.sendMessage(sender, { text: 'Terjadi kesalahan saat menampilkan menu.' });
      }
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
// Handle .listpasien
if (messageContent.toLowerCase() === ".listpasien") {
  const dokterPhone = senderNumber;
  db.all(`SELECT u.username, b.created_at, b.is_active
      FROM bookings b
      JOIN users u ON b.user_id = u.id
      JOIN doctors d ON b.doctor_id = d.id
      WHERE d.phone = ?
      ORDER BY b.created_at DESC`, [dokterPhone], async (err, rows) => {
      if (err) {
          await sock.sendMessage(sender, { text: "Gagal mengambil daftar pasien." });
          return;
      }

      if (rows.length === 0) {
          await sock.sendMessage(sender, { text: "Tidak ada pasien yang sedang konsultasi." });
          return;
      }

      const listText = rows.map((r, i) => {
          const createdAt = new Date(r.created_at);
          createdAt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }); // Menetapkan zona waktu WIB
          const hari = createdAt.getDate().toString().padStart(2, '0');
          const bulan = (createdAt.getMonth() + 1).toString().padStart(2, '0');
          const tahun = createdAt.getFullYear();
          const jam = createdAt.getHours().toString().padStart(2, '0');
          const menit = createdAt.getMinutes().toString().padStart(2, '0');
          const detik = createdAt.getSeconds().toString().padStart(2, '0');
          const aktif = r.is_active ? "Aktif" : "Tidak Aktif";
          
          return `${i + 1}. ${r.username} (mulai ${hari}/${bulan}/${tahun}, ${jam}.${menit}.${detik} WIB) - Status: ${aktif}`;
      }).join("\n");    
      
      await sock.sendMessage(sender, { text: `Daftar pasien:\n\n${listText}` });
  });
  return;
}

    // Handle .lanjut dan simpan sesi aktif
    if (messageContent.toLowerCase().startsWith(".lanjut")) {
      if (!activeSessions[senderNumber]) {
        await sock.sendMessage(sender, { text: "Tidak ada sesi aktif untuk dilanjutkan." });
        return;
      }
      if (!messageContent.includes(" ")) {
        await sock.sendMessage(sender, { text: "Format salah. Gunakan: .lanjut 62xxx" });
        return;
      }
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

async function waitForMessage(sock, timeout = timeout = 120000) {
  try {
    const message = await promiseTimeout(
      sock.waitForMessage(), // Tunggu pesan baru
      timeout, // Batas waktu dalam milidetik
      new Error('Timeout: Tidak ada pesan dalam waktu yang ditentukan')
    );
    return message;
  } catch (error) {
    console.error('Error saat menunggu pesan:', error);
    return null; // Mengembalikan null jika timeout
  }
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