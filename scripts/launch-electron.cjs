const { spawn } = require('child_process');
const path = require('path');
const electronBinary = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

if (process.argv.includes('--prod')) {
  env.NODE_ENV = 'production';
}

const child = spawn(electronBinary, [path.resolve(__dirname, '..')], {
  stdio: 'inherit',
  env,
});

child.on('close', (code) => {
  process.exit(code ?? 0);
});
