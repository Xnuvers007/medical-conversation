const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const { initWhatsAppBot, sendOtpViaBot } = require('./bot');
const path = require('path');
const session = require('express-session');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { body, validationResult } = require('express-validator');
const chalk = require('chalk');
const fs = require('fs');
const csrf = require('csurf');
const cookieParser = require('cookie-parser');
const os = require('os');

require('dotenv').config();

const randomHex = crypto.randomBytes(16).toString('hex');

const app = express();
const db = new sqlite3.Database('./db.sqlite');

const otpStore = {};
const otpRequestStore = {};

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

app.use('/gambar', express.static(path.join(__dirname, 'public/gambar')));

app.use(express.static('public'));
// app.use('/gambar', express.static(path.join(__dirname, 'public/gambar')));


app.use(session({
    secret: randomHex,
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        // secure: process.env.NODE_ENV === 'production' ? true : false,
        maxAge: 1000 * 60 * 60 * 24, // 1 day
        sameSite: 'strict',
        httpOnly: true,
    }
  }));

app.use(helmet());
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
    imgSrc: ["'self'", "*"],
    // scriptSrcAttr: ["'none'"],
    // styleSrcAttr: ["'none'"],
    scriptSrcAttr: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
    styleSrcAttr: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
  }
}));

const csrfProtection = csrf({ cookie: true });
app.use(csrfProtection);

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 menit
    max: 50, // Maksimum 13 percakapan
    message: "Terlalu banyak permintaan, coba lagi nanti. tunggu 15 menit.",
    standardHeaders: true,
    legacyHeaders: false,
  });
  
  app.use(limiter);

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 menit
    max: 5, // Maksimum 5 permintaan login
    message: "Terlalu banyak permintaan login, coba lagi nanti.",
});

const registerLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 menit
    max: 5, // Maksimum 5 permintaan registrasi
    message: "Terlalu banyak permintaan registrasi, coba lagi nanti.",
});

const otpLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 menit
    max: 20, // Maksimum 5 permintaan OTP
    message: "Terlalu banyak permintaan OTP, coba lagi nanti.",
});
  

function isAuthenticated(req, res, next) {
    // if (req.session.user) {
      if (req.session && req.session.user) {
        return next();
    }
    res.status(403).json({ error: 'Unauthorized' });
}

function isAdmin(req, res, next) {
    // if (req.session.user && req.session.user.role === 'admin') {
    if (req.session && req.session.user && req.session.user.role === 'admin') {
        return next();
    }
    res.status(403).json({ error: 'Unauthorized - Admins only' });
}

function isUser(req, res, next) {
    // if (req.session.user && req.session.user.role === 'patient') {
    if (req.session && req.session.user && req.session.user.role === 'patient') {
        return next();
    }
    res.status(403).json({ error: 'Unauthorized - Users only' });
}

app.set('trust proxy', 1);

// === Setup Database ===
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    role TEXT CHECK(role IN ('admin', 'patient')),
    username TEXT UNIQUE,
    password TEXT,
    welcome_sent BOOLEAN DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS doctors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    specialization TEXT,
    phone TEXT,
    photo_url TEXT,
    welcome_sent BOOLEAN DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    doctor_id INTEGER,
    message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    notified_end INTEGER DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(doctor_id) REFERENCES doctors(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER,
    sender TEXT CHECK(sender IN ('doctor', 'patient')),
    message TEXT,
    msg_id TEXT,
    has_media BOOLEAN, 
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(booking_id) REFERENCES bookings(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id)
  )`);
});

function logUserActivity(userId, action) {
  db.run(
    `INSERT INTO user_logs (user_id, action) VALUES (?, ?)`,
    [userId, action],
    (err) => {
      if (err) {
        console.error('Gagal menyimpan log aktivitas pengguna:', err);
      } else {
        console.log(`Log aktivitas pengguna disimpan: User ID ${userId}, Action: ${action}`);
      }
    }
  );
}

app.get('/csrf-token', (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    // Token CSRF tidak valid
    res.status(403).json({ error: 'Invalid CSRF token' });
  } else {
    next(err);
  }
});

// === Routes ===
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);  // Log error for debugging
  res.status(500).json({ message: 'Internal Server Error' });
});

// if (process.env.NODE_ENV === 'production') {
//   app.use((req, res, next) => {
//     if (req.protocol === 'http') {
//       return res.redirect(301, 'https://' + req.headers.host + req.url);
//     }
//     next();
//   });
// }

// Route untuk halaman admin (hanya untuk admin)
app.get('/admin.html', isAuthenticated, isAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin.html'));
});

// Route untuk halaman pasien (hanya untuk pasien)
app.get('/patient.html', isAuthenticated, isUser, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/patient.html'));
});

app.get('/bookings', isAuthenticated, (req, res) => {
  const { user_id, is_active } = req.query;
  db.all(`SELECT * FROM bookings WHERE user_id = ? AND is_active = ?`, [user_id, is_active], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(rows);
  });
});

app.post('/book', isAuthenticated, (req, res) => {
  if (!req.session.user) return res.status(403).json({ error: 'Unauthorized' });
  const { user_id, doctor_id, message } = req.body;

  // Periksa apakah pengguna sudah memiliki booking aktif
  db.get(`SELECT * FROM bookings WHERE user_id = ? AND is_active = 1`, [user_id], (err, existingBooking) => {
    if (err) return res.status(500).send('Database error');
    if (existingBooking) {
      return res.status(400).json({ status: 'error', message: 'Anda sudah memiliki konsultasi aktif dengan dokter lain.' });
    }

    db.run(`INSERT INTO bookings (user_id, doctor_id, message) VALUES (?, ?, ?)`,
      [user_id, doctor_id, message],
      function (err) {
        if (err) return res.status(500).send('Database error');
        return res.json({ status: 'success', booking_id: this.lastID });
      });
  });
});

app.get('/dashboard', isAuthenticated, (req, res) => {
    if (!req.session.user) return res.redirect('/');
  
    if (req.session.user.role === 'admin') {
      res.sendFile(path.join(__dirname, 'public/admin.html'));
    } else {
      res.sendFile(path.join(__dirname, 'public/patient.html'));
    }
  });
  

// Register route
app.post('/register', registerLimiter, [
  body('username')
    .isAlphanumeric().withMessage('Username harus berupa alfanumerik')
    .not().matches(/\s/).withMessage('Username tidak boleh mengandung spasi'),
  body('password')
    .isLength({ min: 8 }).withMessage('Password harus memiliki minimal 6 karakter')
    .not().matches(/\s/).withMessage('Password tidak boleh mengandung spasi'),
  body('name').notEmpty().withMessage('Name is required').isLength({ max: 50 }).withMessage('Name cannot exceed 50 characters'),
  body('username').isLength({ max: 15 }).withMessage('Username cannot exceed 15 characters or number'),
  body('password').isLength({ max: 30 }).withMessage('Password cannot exceed 30 characters')

], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

    const { username, password, name } = req.body;
    console.log(`Mencoba mendaftarkan pengguna baru: ${username}`);
  
    db.run(`INSERT INTO users (name, role, username, password) VALUES (?, 'patient', ?, ?)`,
      [name, username, password], function (err) {
        if (err) {
          console.log('Gagal mendaftarkan pengguna:', err.message);
          return res.status(400).json({ status: 'error', message: 'Username already exists' });
        }
        console.log('Pengguna berhasil didaftarkan:', username);
        req.session.user = { id: this.lastID, name, role: 'patient', username };
        res.json({ status: 'success' });
      });
  });
  // Login route
  app.post('/login', loginLimiter, (req, res) => {
    const { username, password } = req.body;

    if (/\s/.test(username) || /\s/.test(password)) {
      return res.status(400).json({ error: 'Username dan password tidak boleh mengandung spasi' });
    }
  
    // Hardcoded admin login
    const adminUsername = process.env.ADMIN_USERNAME;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (username === adminUsername && password === adminPassword) {
      req.session.user = { username: adminUsername, role: 'admin' };
      return res.json({ status: 'success', role: 'admin' });
    }
  
    db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password], (err, user) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Database error' });
      }
  
      if (user) {
        req.session.user = { id: user.id, username: user.username, name: user.name, role: user.role };
        logUserActivity(user.id, 'login');
        res.json({ status: 'success', role: user.role });
      } else {
        res.status(401).json({ error: 'Invalid credentials' });
      }
    });
  });

// Get current logged in user
app.get('/get-user', isAuthenticated || isUser, (req, res) => {
    // if (!req.session.user) return res.status(403).json({ error: 'Unauthorized' });
    // res.json(req.session.user);
    if (!req.session.user) {
      return res.status(401).json({ error: 'Pengguna belum login' });
    }
    
    if (!req.session.user) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { id, username, name, role } = req.session.user;

    // if (!id || !username || !role) {
    //   return res.status(500).json({ error: 'Data pengguna tidak lengkap' });
    // }

    res.json({ id, username, name: name || 'Pengguna', role });
  });
  
  // Get all doctors
  app.get('/doctors', isAuthenticated, (req, res) => {
    if (!req.session.user) return res.status(403).json({ error: 'Unauthorized' });
    db.all('SELECT * FROM doctors', (err, rows) => {
    //   res.json(rows);
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!req.session.user) return res.status(403).json({ error: 'Unauthorized' });
        res.json(rows);
    });
  });

  // get all photo from public/gambar
  app.get('/images', (req, res) => {
    const fs = require('fs');
    const path = require('path');
    const directoryPath = path.join(__dirname, 'public/gambar');

    fs.readdir(directoryPath, (err, files) => {
      if (err) {
        return res.status(500).json({ error: 'Unable to scan directory: ' + err });
      }
      const images = files.map(file => path.join('/gambar', file));
      res.json(images);
    });
  });
  
  // Add new doctor (admin only)
  app.post('/doctors', csrfProtection, isAuthenticated && isAdmin, [
    body('name')
    .notEmpty().withMessage('Nama harus diisi')
    .matches(/^[A-Za-z .,'-]+$/).withMessage('Nama hanya boleh berisi huruf, spasi, dan tanda baca sederhana'),
  body('specialization')
    .notEmpty().withMessage('Spesialisasi harus diisi')
    .matches(/^[A-Za-z .,'-]+$/).withMessage('Spesialisasi hanya boleh berisi huruf, spasi, dan tanda baca sederhana'),
  body('phone')
    .notEmpty().withMessage('Nomor telepon harus diisi')
    .matches(/^(62)[0-9]{8,13}$/).withMessage('Nomor telepon harus dalam format 62xxx'),
  body('photo_url')
    .notEmpty().withMessage('URL foto harus diisi')
    .isURL().withMessage('URL foto harus valid')
    .matches(/\.(jpg|jpeg|png|gif)$/i).withMessage('URL foto harus diakhiri dengan format gambar yang valid (.jpg, .jpeg, .png, .gif)')
  ] ,(req, res) => {

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    if (!req.session.user) return res.status(403).json({ error: 'Unauthorized' });
    const { name, specialization, phone, photo_url } = req.body;
    
    if (
      !(photo_url.startsWith('http://') || photo_url.startsWith('https://')) ||
      !(photo_url.endsWith('.jpg') || photo_url.endsWith('.jpeg') || photo_url.endsWith('.png'))
    ) {
      return res.status(400).json({ error: 'Invalid photo URL' });
    }
    

    db.run(`INSERT INTO doctors (name, specialization, phone, photo_url) VALUES (?, ?, ?, ?)`,
      [name, specialization, phone, photo_url], (err) => {
        if (err) return res.status(500).json({ error: 'Gagal tambah dokter' });
        res.json({ status: 'success' });
      });
  });

  app.delete('/users/:id', isAuthenticated && isUser, (req, res) => {
    const userId = req.params.id;
  
    // Pastikan hanya pengguna terautentikasi yang dapat menghapus akun mereka sendiri
    if (req.session.user.id !== parseInt(userId)) {
      return res.status(403).json({ error: 'Unauthorized - Cannot delete other user accounts' });
    }
  
    console.log('Session during account deletion:', req.session);

    db.run(`DELETE FROM users WHERE id = ?`, [userId], function (err) {
      if (err) {
        console.error('Error deleting user:', err);
        if (req.session && req.session.user && req.session.user.id) {
          logUserActivity(req.session.user.id, 'delete_account_failed');
        }
        return res.status(500).json({ error: 'Gagal menghapus akun pengguna' });
      }
    
      if (req.session && req.session.user && req.session.user.id) {
        logUserActivity(req.session.user.id, 'delete_account');
      } else {
        console.log('User ID tidak ditemukan dalam sesi saat penghapusan akun.');
      }
    
      req.session.destroy(); // Akhiri sesi setelah penghapusan
      res.json({ status: 'success', message: 'Akun berhasil dihapus' });
    });
  });

  // Hapus akun pengguna (admin only)
app.delete('/admin/users/:id', isAuthenticated && isAdmin, (req, res) => {
  const userId = req.params.id;

  db.run(`DELETE FROM users WHERE id = ?`, [userId], function (err) {
    if (err) {
      console.error('Error deleting user:', err);
      return res.status(500).json({ error: 'Gagal menghapus akun pengguna' });
    }
    console.log(`Akun dengan ID ${userId} berhasil dihapus oleh admin.`);
    logUserActivity(`${userId}`, 'delete_account_by_admin');
    res.json({ status: 'success', message: `Akun dengan ID ${userId} berhasil dihapus` });
  });
});

// Mendapatkan daftar semua pengguna (admin only)
app.get('/admin/users', isAuthenticated && isAdmin, (req, res) => {
  db.all(`SELECT id, username, name, role FROM users`, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Gagal mendapatkan daftar pengguna' });
    }
    res.json(rows);
  });
});

  // app.delete('/users/:id', (req, res) => {
  //   const userId = req.params.id;
  
  //   db.run(`DELETE FROM users WHERE id = ?`, [userId], function (err) {
  //     if (err) {
  //       console.error('Error deleting user:', err);
  //       return res.status(500).json({ status: 'error', message: 'Gagal menghapus akun' });
  //     }
  
  //     res.json({ status: 'success', message: 'Akun berhasil dihapus' });
  //   });
  // });

  // Delete doctor (admin only)
  app.delete('/doctors/:id', isAuthenticated && isAdmin, (req, res) => {
    if (!req.session.user) return res.status(403).json({ error: 'Unauthorized' });
    const id = req.params.id;
    db.run(`DELETE FROM doctors WHERE id = ?`, [id], function(err) {
      if (err) return res.status(500).json({ error: 'Gagal hapus dokter' });
      res.json({ status: 'deleted' });
    });
  });

  app.post('/logout', (req, res) => {
    console.log('Session before logout:', req.session);
  
    if (req.session && req.session.user && req.session.user.id) {
      logUserActivity(req.session.user.id, 'logout');
      console.log(`User ${req.session.user.username} logged out successfully.`);
    } else {
      console.log('User ID tidak ditemukan dalam sesi saat logout.');
    }
  
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: 'Gagal logout' });
      }
      res.clearCookie('connect.sid');
      res.json({ status: 'success', message: 'Logged out successfully' });
    });
  });

  app.get('/admin/logs', isAuthenticated && isAdmin, (req, res) => {
    db.all(`SELECT l.id, u.username, l.action, l.timestamp
            FROM user_logs l
            JOIN users u ON l.user_id = u.id
            ORDER BY l.timestamp DESC`, [], (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Gagal mengambil log aktivitas' });
      }
      res.json(rows);
    });
  });

  app.delete('/admin/logs', isAuthenticated && isAdmin, (req, res) => {
    db.run(`DELETE FROM user_logs`, [], function (err) {
      if (err) {
        console.error('Error deleting logs:', err);
        return res.status(500).json({ error: 'Gagal menghapus log aktivitas' });
      }
  
      console.log('Semua log aktivitas berhasil dihapus oleh admin.');
      res.json({ status: 'success', message: 'Semua log aktivitas berhasil dihapus' });
    });
  });

  app.post('/forgot-password/send-otp', [
    body('phone')
      .isMobilePhone('any', { strictMode: false }) // Memastikan nomor telepon valid
      .withMessage('Nomor telepon tidak valid'),
    body('phone')
      .notEmpty()
      .withMessage('Nomor telepon tidak boleh kosong'),
    body('phone')
      .isLength({ max: 15 })
      .withMessage('Nomor telepon tidak boleh lebih dari 15 karakter'),
  ], otpLimiter, async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { phone } = req.body;

        // Validasi nomor telepon
        if (!req.body.phone || typeof req.body.phone !== 'string') {
          return res.status(400).json({ error: 'Nomor telepon tidak valid' });
        }
  
    // Periksa apakah nomor telepon terdaftar
    db.get(`SELECT * FROM users WHERE username = ?`, [phone], async (err, user) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
      }
  
      if (!user) {
        return res.status(404).json({ error: 'Nomor tersebut tidak tersedia.' });
      }
  
      // Periksa apakah nomor sudah mencapai batas permintaan
      const now = Date.now();
      if (!otpRequestStore[phone]) {
        otpRequestStore[phone] = { count: 0, lastRequestTime: 0 };
      }
  
      const { count, lastRequestTime } = otpRequestStore[phone];
  
      // Jika sudah mencapai batas 3 permintaan, periksa waktu tunggu
      if (count >= 3) {
        // const waitTime = Math.random() * (10 - 1) + 1; // Random antara 1 hingga 10 menit
        const waitTime = Math.random() * (2 - 1) + 1; // Random antara 1 hingga 2 menit
        const waitUntil = lastRequestTime + waitTime * 60 * 1000; // Waktu tunggu dalam milidetik
  
        if (now < waitUntil) {
          const remainingTime = Math.ceil((waitUntil - now) / 1000 / 60); // Sisa waktu dalam menit
          return res.status(429).json({ error: `Anda telah mencapai batas permintaan OTP. Silakan coba lagi dalam ${remainingTime} menit.` });
        }
  
        // Reset hitungan setelah waktu tunggu selesai
        otpRequestStore[phone].count = 0;
      }
  
      // Generate OTP 6 digit
      const otp = crypto.randomInt(100000, 999999);
      otpStore[phone] = { otp, expiresAt: now + 2 * 60 * 1000 }; // OTP berlaku selama 2 menit
  
      // Kirim OTP melalui bot WhatsApp
      const success = await sendOtpViaBot(phone, otp);
      if (success) {
        otpRequestStore[phone].count += 1; // Tambahkan hitungan permintaan
        otpRequestStore[phone].lastRequestTime = now; // Perbarui waktu permintaan terakhir
        res.json({ status: 'success', message: 'Kode OTP telah dikirim.' });
      } else {
        res.status(500).json({ error: 'Gagal mengirim kode OTP.' });
      }
    });
  });

  app.post('/forgot-password/verify-otp', otpLimiter, [
    body('phone')
      .isMobilePhone('any', { strictMode: false }) // Memastikan nomor telepon valid
      .withMessage('Nomor telepon tidak valid').notEmpty().withMessage('Nomor telepon tidak boleh kosong')
      .isLength({ max: 15 }).withMessage('Nomor telepon tidak boleh lebih dari 15 karakter'),
    body('otp')
      .isNumeric().withMessage('Kode OTP harus berupa angka')
      .isLength({ min: 6, max: 6 }).withMessage('Kode OTP harus terdiri dari 6 digit'),
  ], (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { phone, otp } = req.body;

        // Validasi nomor telepon dan OTP
        if (!req.body.phone || typeof req.body.phone !== 'string') {
          return res.status(400).json({ error: 'Nomor telepon tidak valid' });
        }
      
        if (!req.body.otp || typeof req.body.otp !== 'string' || isNaN(req.body.otp)) {
          return res.status(400).json({ error: 'Kode OTP tidak valid' });
        }
  
    const storedOtp = otpStore[phone];
    if (!storedOtp) {
      return res.status(400).json({ error: 'Kode OTP tidak ditemukan atau telah kedaluwarsa.' });
    }
  
    if (storedOtp.otp !== parseInt(otp)) {
      return res.status(400).json({ error: 'Kode OTP tidak valid.' });
    }
  
    if (Date.now() > storedOtp.expiresAt) {
      delete otpStore[phone];
      return res.status(400).json({ error: 'Kode OTP telah kedaluwarsa.' });
    }
  
    // OTP valid, hapus dari store
    delete otpStore[phone];
    res.json({ status: 'success', message: 'Kode OTP valid. Anda dapat mengubah password.' });
  });
  
  app.post('/forgot-password/change-password', [
    body('phone')
      .isMobilePhone('any', { strictMode: false }) // Memastikan nomor telepon valid
      .withMessage('Nomor telepon tidak valid').notEmpty().withMessage('Nomor telepon tidak boleh kosong')
      .isLength({ max: 15 }).withMessage('Nomor telepon tidak boleh lebih dari 15 karakter'),
    body('newPassword')
      .isLength({ min: 8 }).withMessage('Password harus memiliki minimal 8 karakter')
      .not().matches(/\s/).withMessage('Password tidak boleh mengandung spasi'),
    body('newPassword')
      .isLength({ max: 30 }).withMessage('Password tidak boleh lebih dari 30 karakter'),
    body('newPassword')
      .notEmpty().withMessage('Password baru tidak boleh kosong'),
  ], (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { phone, newPassword } = req.body;

        // Validasi nomor telepon dan password baru
        if (!req.body.phone || typeof req.body.phone !== 'string') {
          return res.status(400).json({ error: 'Nomor telepon tidak valid' });
        }
        if (!req.body.newPassword || typeof req.body.newPassword !== 'string') {
          return res.status(400).json({ error: 'Password baru tidak valid' });
        }
        if (/\s/.test(req.body.newPassword)) {
          return res.status(400).json({ error: 'Password baru tidak boleh mengandung spasi' });
        }
        if (req.body.newPassword.length < 8) {
          return res.status(400).json({ error: 'Password baru harus memiliki minimal 8 karakter' });
        }
        if (req.body.newPassword.length > 30) {
          return res.status(400).json({ error: 'Password baru tidak boleh lebih dari 30 karakter' });
        }
        if (!req.body.newPassword) {
          return res.status(400).json({ error: 'Password baru tidak boleh kosong' });
        }
  
    // Perbarui password di database
    db.run(`UPDATE users SET password = ? WHERE username = ?`, [newPassword, phone], (err) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Gagal mengubah password.' });
      }
  
      res.json({ status: 'success', message: 'Password berhasil diubah.' });
    });
  });

initWhatsAppBot(db);

app.listen(3000, () => {
  const networkInterfaces = os.networkInterfaces();
  const lanIps = [];

  // Ambil semua alamat IP dari network interfaces
  for (const interfaceName in networkInterfaces) {
    const interfaces = networkInterfaces[interfaceName];
    for (const iface of interfaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        lanIps.push(iface.address); // Simpan LAN IP
      }
    }
  }

  console.log(chalk.green(`Server berjalan di:`));
  console.log(chalk.green(`- Localhost: ${process.env.NODE_ENV === 'production' ? 'https' : 'http'}://localhost:3000`));
  lanIps.forEach((ip) => {
    console.log(chalk.green(`- LAN IP: ${process.env.NODE_ENV === 'production' ? 'https' : 'http'}://${ip}:3000`));
  });

  console.log(chalk.yellow('Jika ingin mengganti sesi, silahkan hapus folder auth dan jika ingin menghapus semua data, silahkan hapus db.sqlite'));
  const authDir = path.join(__dirname, 'auth');
  
  if (fs.existsSync(authDir)) {
    const files = fs.readdirSync(authDir);
    
    // Jika folder auth kosong, atau hanya berisi file creds.json
    if (files.length === 0 || (files.length === 1 && files[0] === 'creds.json')) {
      fs.rm(authDir, { recursive: true, force: true }, (err) => {
        if (err) {
          console.error(chalk.red('Gagal menghapus folder "auth":', err));
          return;
        }
      });
      console.log(chalk.red('Folder "auth" telah dihapus. Silakan login ulang.'));
    } else if (files.length > 1) {
      // Jika folder auth berisi banyak file, jangan hapus folder
      console.log(chalk.green('Folder "auth" berisi banyak file. Folder tidak dihapus.'));
    } else {
      console.log(chalk.green('Folder "auth" kosong. Silakan login ulang.'));
    }
  }
});