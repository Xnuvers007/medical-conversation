const { spawn } = require('child_process');

function startBot() {
  const bot = spawn('node', ['index.js'], { stdio: 'inherit' });

  bot.on('close', (code) => {
    console.log(`Bot berhenti dengan kode: ${code}`);
    if (code !== 0) {
      console.log('Restarting bot...');
      startBot(); // Restart bot jika terjadi error
    }
  });

  bot.on('error', (err) => {
    console.error('Error saat menjalankan bot:', err);
    console.log('Restarting bot...');
    startBot(); // Restart bot jika terjadi error
  });
}

startBot();