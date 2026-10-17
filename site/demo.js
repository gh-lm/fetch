// Drives the demo terminal: a scripted, looping session. Not connected to
// anything. It can't reach a real machine from a browser tab, and
// wouldn't want to even if it could (this page loads nothing from
// anywhere else). Everything here is canned output, timed to feel like
// someone actually typing.

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const term = new Terminal({
  fontFamily: "'Geist Mono', 'Roboto Mono', monospace",
  fontSize: 13,
  lineHeight: 1.2,
  cursorBlink: true,
  disableStdin: true,
  scrollback: 0,
  theme: {
    background: '#0b0b10',
    foreground: '#ecebf5',
    cursor: '#b7a9ff',
    cursorAccent: '#0b0b10',
    selectionBackground: 'rgba(183, 169, 255, 0.28)',
  },
});
term.open(document.getElementById('demo-terminal'));

const PROMPT = '\x1b[38;2;183;169;255mcharlie\x1b[38;2;145;144;152m@\x1b[38;2;183;169;255mfetch-terminal\x1b[38;2;145;144;152m:~$\x1b[0m ';
const DIM = (s) => `\x1b[38;2;145;144;152m${s}\x1b[0m`;
const CORAL = (s) => `\x1b[38;2;255;181;157m${s}\x1b[0m`;

function sleep(ms) {
  // prefers-reduced-motion: reduce means the session should still play
  // (it's the only way to see what the demo shows), just without the
  // continuous typing/pacing motion: every wait collapses to instant.
  return new Promise((resolve) => setTimeout(resolve, REDUCED_MOTION ? 0 : ms));
}

// Types text into the terminal one character at a time, with a bit of
// randomness so it doesn't read as a uniform, obviously-fake cadence.
async function type(text, { min = 28, max = 70 } = {}) {
  if (REDUCED_MOTION) {
    term.write(text);
    return;
  }
  for (const ch of text) {
    term.write(ch);
    await sleep(min + Math.random() * (max - min));
  }
}

function setActive(id, active) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('is-active', active);
}

async function runDemoOnce() {
  term.reset();
  term.write(PROMPT);

  // 1. A plain command.
  await type('ls');
  await sleep(220);
  term.write('\r\n' + DIM('Desktop  Documents  Downloads  Projects  README.md') + '\r\n\r\n');
  await sleep(700);
  term.write(PROMPT);

  // 2. Inline autocomplete: type a prefix, show the ghost, accept it.
  await type('gi', { min: 40, max: 90 });
  term.write('\x1b[38;2;90;89;96m' + 't status' + '\x1b[0m');
  await sleep(950);
  term.write('\r' + PROMPT + 'git status' + ' '.repeat(2));
  await sleep(150);
  term.write('\r\n' + DIM('On branch main') + '\r\n' + DIM('nothing to commit, working tree clean') + '\r\n\r\n');
  await sleep(900);
  term.write(PROMPT);

  // 3. Click a saved snippet (SSH one-liner): sidebar item lights up.
  setActive('demo-snippet-deploy', true);
  await sleep(350);
  await type('ssh deploy@prod.example.com', { min: 12, max: 22 });
  term.write('\r\n');
  setActive('demo-snippet-deploy', false);
  await sleep(500);
  term.write(CORAL('Welcome to prod (Ubuntu 24.04 LTS)') + '\r\n' + DIM('Last login: Tue Aug  1 14:22:03 2026') + '\r\n');
  await sleep(300);
  term.write('\r\ndeploy@prod:~$ sudo systemctl restart app\r\n');
  await sleep(500);
  term.write(DIM('[sudo] password for deploy: '));

  // 4. Click a saved password: vault row lights up, password is typed
  // (never echoed, same as a real terminal wouldn't show it either).
  setActive('demo-vault-row', true);
  await sleep(600);
  setActive('demo-vault-row', false);
  term.write('\r\n');
  await sleep(250);
  term.write(DIM('Restarting app.service... done') + '\r\n\r\n');
  await sleep(2200);
}

async function runDemo() {
  // Reduced motion still gets to see the demo, it just plays once and
  // holds on the final frame instead of looping forever.
  do {
    await runDemoOnce();
  } while (!REDUCED_MOTION);
}

// Only run once the demo window has actually scrolled into view: no
// point animating a terminal nobody's looking at yet.
const observer = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) {
    observer.disconnect();
    runDemo();
  }
}, { threshold: 0.2 });
observer.observe(document.getElementById('demo-frame'));
