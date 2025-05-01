document.getElementById('authForm').addEventListener('submit', function(e) {
    e.preventDefault();
  
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    console.log('Submitting login:', { username, password });
  
    fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
    .then(response => response.json())
    .then(data => {
      if (data.status === 'success') {
        window.location.href = '/dashboard';
      } else {
        alert('Login failed');
      }
    });
  });
  