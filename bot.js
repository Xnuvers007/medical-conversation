const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const fs = require('fs');
const pino = require('pino');
const readline = require('readline');

const activeSessions = {};

async function initWhatsAppBot(db) {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  let sock = makeWASocket({
    logger: pino({ level: 'fatal' }),
    auth: state,
    printQRInTerminal: true,
  });

  if (!state.creds.me) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Login dengan pairing code? (y/n): ', answer => {
      if (answer.toLowerCase() === 'y') {
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
      } else {
        rl.close();
      }
    });
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) initWhatsAppBot(db);
      else console.log('Sesi logout. Hapus folder "auth" untuk login ulang.');
    } else if (connection === 'open') {
      console.log('Terhubung ke WhatsApp');
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const senderNumber = sender.split('@')[0];
    const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (!messageContent || messageContent.trim() === "") return;

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

        const listText = rows.map((r, i) => `${i + 1}. ${r.username} (mulai ${r.created_at})`).join("\n");
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

    // Penanganan pesan biasa tanpa prefix
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

      await sock.sendMessage(targetJid, { text: messageContent });
      db.run(`INSERT INTO messages (booking_id, sender, message, msg_id) VALUES (?, ?, ?, ?)`,
        [booking.booking_id, fromRole, messageContent, msg.key.id]);
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

module.exports = { initWhatsAppBot };
