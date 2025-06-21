document.addEventListener('DOMContentLoaded', function () {
    fetch('/csrf-token')
      .then(res => res.json())
      .then(data => {
        document.getElementById('csrfToken').value = data.csrfToken;
      })
      .catch(err => {
        console.error('Gagal mengambil token CSRF:', err);
        // alert('Gagal memuat token CSRF. Silakan muat ulang halaman.');
        Swal.fire({
            icon: 'error',
            title: 'Gagal Memuat Token CSRF',
            text: 'Silakan muat ulang halaman.',
        });
      });
  });

document.getElementById('authForm').addEventListener('submit', function(e) {
    e.preventDefault();
  
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();
    const csrfToken = document.getElementById('csrfToken').value;

    if (/\s/.test(username) || /\s/.test(password)) {
        Swal.fire({
          icon: 'error',
          title: 'Invalid Input',
          text: 'Username dan password tidak boleh mengandung spasi.',
        });
        return; // Jangan lanjutkan jika ada spasi
      }
    
  
    if (!username || !password) {
        Swal.fire({
            icon: 'error',
            title: 'Oops...',
            text: 'Username dan password harus diisi!',
        });
        return;
    }
  
    if (username.startsWith('0')) {
      // username = username.replace('0', '62');
      username = DOMPurify.sanitize(username.replace('0', '62'));
    } else if (username.startsWith('+62')) {
      // username = username.replace('+62', '62');
      username = DOMPurify.sanitize(username.replace('+62', '62'));
    }
  
    // Cegah XSS dengan meng-encode karakter berbahaya
    let sanitizedUsername = username.replace(/[<>'"]/g, ''); 
    let sanitizedPassword = password.replace(/[<>'"]/g, '');
  
    sanitizedUsername = DOMPurify.sanitize(sanitizedUsername); 
    sanitizedPassword = DOMPurify.sanitize(sanitizedPassword);
  
    console.log('Submitting login:', { sanitizedUsername, sanitizedPassword });
  
    fetch('/login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
            'CSRF-Token': csrfToken
        },
        body: JSON.stringify({ username: sanitizedUsername, password: sanitizedPassword })
    })
    .then((response) => {
        if (response.status === 429) {
          Swal.fire({
            icon: 'error',
            title: 'Terlalu Banyak Permintaan',
            text: 'Anda telah mencapai batas maksimum percobaan login. Silakan coba lagi nanti.',
          });
          throw new Error('Too Many Requests');
        }
        if (!response.ok) {
          throw new Error('Login gagal');
        }
        return response.json();
      })
    .then(data => {
        if (data.status === 'success') {
            // Redirect ke halaman dashboard setelah login berhasil
            window.location.href = '/dashboard';
        } else {
            // Tampilkan SweetAlert jika login gagal
            Swal.fire({
                icon: 'error',
                title: 'Login gagal',
                text: 'Username atau password yang Anda masukkan salah.',
            });
        }
    })
    .catch(error => {
        // Tangani error saat jaringan atau server tidak merespon
        console.error('Login error:', error);
        Swal.fire({
            icon: 'error',
            title: 'Terjadi kesalahan',
            text: error,
        });
    });
  });
  