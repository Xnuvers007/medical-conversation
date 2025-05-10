const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const { initWhatsAppBot } = require('./bot');
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

require('dotenv').config();

const randomHex = crypto.randomBytes(16).toString('hex');

const app = express();
const db = new sqlite3.Database('./db.sqlite');

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
    styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
    imgSrc: ["'self'", "*"],
    scriptSrcAttr: ["'none'"],
    styleSrcAttr: ["'none'"],
  }
}));

const csrfProtection = csrf({ cookie: true });
app.use(csrfProtection);

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 menit
    max: 35, // Maksimum 13 percakapan
    message: "Terlalu banyak permintaan, coba lagi nanti. tunggu 15 menit.",
    standardHeaders: true,
    legacyHeaders: false,
  });
  
  app.use(limiter);
  

function isAuthenticated(req, res, next) {
    if (req.session.user) {
        return next();
    }
    res.status(403).json({ error: 'Unauthorized' });
}

function isAdmin(req, res, next) {
    if (req.session.user && req.session.user.role === 'admin') {
        return next();
    }
    res.status(403).json({ error: 'Unauthorized - Admins only' });
}

function isUser(req, res, next) {
    if (req.session.user && req.session.user.role === 'patient') {
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
app.post('/register', [
  body('username').isAlphanumeric().withMessage('Username must be alphanumeric'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('email').isEmail().withMessage('Please provide a valid email address'),
], (req, res) => {
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
  app.post('/login', (req, res) => {
    const { username, password } = req.body;
  
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
        req.session.user = { id: user.id, username: user.username, role: user.role };
        logUserActivity(user.id, 'login');
        res.json({ status: 'success', role: user.role });
      } else {
        res.status(401).json({ error: 'Invalid credentials' });
      }
    });
  });

// Get current logged in user
app.get('/get-user', isAuthenticated || isUser, (req, res) => {
    if (!req.session.user) return res.status(403).json({ error: 'Unauthorized' });
    res.json(req.session.user);
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
  app.post('/doctors', isAuthenticated && isAdmin, (req, res) => {
    if (!req.session.user) return res.status(403).json({ error: 'Unauthorized' });
    const { name, specialization, phone, photo_url } = req.body;
    
    if (!photo_url.startsWith('http://') && !photo_url.startsWith('https://')) {
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


initWhatsAppBot(db);

app.listen(3000, () => {
  console.log(`Server started on http://localhost:3000`);
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