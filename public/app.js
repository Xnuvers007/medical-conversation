document.getElementById('authForm').addEventListener('submit', function(e) {
  e.preventDefault();

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();

  if (!username || !password) {
      Swal.fire({
          icon: 'error',
          title: 'Oops...',
          text: 'Username dan password harus diisi!',
      });
      return;
  }

if (username.startsWith('0')) {
    username = username.replace('0', '62');
} else if (username.startsWith('+62')) {
    username = username.replace('+62', '62');
}

  // Cegah XSS dengan meng-encode karakter berbahaya
  const sanitizedUsername = username.replace(/[<>'"]/g, ''); 
  const sanitizedPassword = password.replace(/[<>'"]/g, '');

  console.log('Submitting login:', { sanitizedUsername, sanitizedPassword });

  fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: sanitizedUsername, password: sanitizedPassword })
  })
  .then(response => response.json())
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
          text: 'Gagal menghubungi server, coba lagi nanti.',
      });
  });
});
