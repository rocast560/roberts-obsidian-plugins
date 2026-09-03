'use strict';

/*
 * RobTerminal PTY host.
 *
 * Runs OUT OF PROCESS, under the system Node runtime rather than Obsidian's
 * Electron. That is the whole point: node-pty is a native module, and loading
 * it inside Obsidian would tie it to Obsidian's Electron ABI and break on
 * every Obsidian update. Here it only has to match the Node it was built for.
 *
 * It owns one ConPTY and bridges it to the plugin over a named pipe. The pipe
 * (rather than stdio) is also what makes an elevated terminal possible: an
 * elevated process cannot inherit a non-elevated parent's stdio, but it can
 * connect back to a pipe that parent created.
 *
 *   usage: node ptyhost.js <pipeName> <token>
 *
 * Wire format, both directions: [type:u8][length:u32be][payload]
 *   type 0 = raw PTY bytes
 *   type 1 = UTF-8 JSON control message
 */

const net = require('net');

const PIPE = process.argv[2];
const TOKEN = process.argv[3];

if (!PIPE || !TOKEN) {
  process.stderr.write('usage: ptyhost.js <pipeName> <token>\n');
  process.exit(2);
}

const T_DATA = 0;
const T_CTL = 1;

/* ------------------------------------------------------------------ *
 * Framing
 * ------------------------------------------------------------------ */

function frame(type, payload) {
  const head = Buffer.allocUnsafe(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

function decoder(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 5) return;
      const len = buf.readUInt32BE(1);
      if (buf.length < 5 + len) return;
      const type = buf.readUInt8(0);
      // Copy: the payload outlives this tick once it is queued into the pty.
      const payload = Buffer.from(buf.subarray(5, 5 + len));
      buf = buf.subarray(5 + len);
      onFrame(type, payload);
    }
  };
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

let term = null;
let socket = null;
let closing = false;

function send(type, payload) {
  if (!socket || socket.destroyed) return;
  const ok = socket.write(frame(type, payload));
  // Backpressure: without this, `cat bigfile` outruns the pipe and buffers
  // the whole thing in memory.
  if (!ok && term) {
    try {
      term.pause();
      socket.once('drain', () => {
        if (term) {
          try { term.resume(); } catch (_) { /* already gone */ }
        }
      });
    } catch (_) { /* pty without flow control */ }
  }
}

function sendCtl(obj) {
  send(T_CTL, Buffer.from(JSON.stringify(obj), 'utf8'));
}

function shutdown(code) {
  if (closing) return;
  closing = true;
  if (term) {
    const t = term;
    term = null;
    try { t.kill(); } catch (_) { /* already exited */ }
  }
  try { if (socket) socket.end(); } catch (_) { /* already closed */ }
  setTimeout(() => process.exit(code || 0), 120).unref();
}

/* ------------------------------------------------------------------ *
 * PTY
 * ------------------------------------------------------------------ */

let pty = null;

function loadPty() {
  if (pty) return true;
  try {
    pty = require('node-pty');
    return true;
  } catch (err) {
    sendCtl({ t: 'error', fatal: true, message: 'node-pty failed to load: ' + err.message });
    return false;
  }
}

function doSpawn(msg) {
  if (term) return;
  if (!loadPty()) return;

  const env = Object.assign({}, process.env, msg.env || {});
  // Anything inheriting this environment should believe it has a real
  // terminal, because it does.
  env.TERM = env.TERM || 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'RobTerminal';
  delete env.ELECTRON_RUN_AS_NODE;
  // A fresh pane is never nested inside psmux/tmux, but Obsidian itself may
  // have been launched from within a psmux session. The inherited markers
  // make `psmux` print "sessions should be nested with care" and exit
  // instead of starting - so the terminal looks like its keybinds are dead.
  delete env.PSMUX_SESSION;
  delete env.PSMUX_TARGET_SESSION;
  delete env.PSMUX_PANE;
  delete env.TMUX;
  delete env.TMUX_PANE;

  try {
    term = pty.spawn(msg.file, msg.args || [], {
      name: 'xterm-256color',
      cols: msg.cols > 0 ? msg.cols : 80,
      rows: msg.rows > 0 ? msg.rows : 24,
      cwd: msg.cwd,
      env,
      encoding: null, // hand us bytes; xterm.js does its own UTF-8 decoding
      useConpty: true,
    });
  } catch (err) {
    sendCtl({ t: 'error', fatal: true, message: 'could not start ' + msg.file + ': ' + err.message });
    return;
  }

  sendCtl({ t: 'spawned', pid: term.pid, file: msg.file });

  term.onData((d) => {
    send(T_DATA, Buffer.isBuffer(d) ? d : Buffer.from(d, 'utf8'));
  });

  term.onExit((e) => {
    sendCtl({ t: 'exit', code: e.exitCode, signal: e.signal });
    shutdown(0);
  });
}

/* ------------------------------------------------------------------ *
 * Connect back to the plugin
 * ------------------------------------------------------------------ */

const giveUp = setTimeout(() => {
  process.stderr.write('ptyhost: no connection, giving up\n');
  process.exit(3);
}, 15000);

socket = net.connect(PIPE, () => {
  clearTimeout(giveUp);
  sendCtl({ t: 'hello', token: TOKEN, pid: process.pid, node: process.version });
});

socket.on('data', decoder((type, payload) => {
  if (type === T_DATA) {
    if (term) {
      try { term.write(payload); } catch (_) { /* pty closing */ }
    }
    return;
  }
  let msg;
  try { msg = JSON.parse(payload.toString('utf8')); } catch (_) { return; }

  switch (msg.t) {
    case 'spawn':
      doSpawn(msg);
      break;
    case 'resize':
      if (term && msg.cols > 0 && msg.rows > 0) {
        try { term.resize(msg.cols, msg.rows); } catch (_) { /* raced with exit */ }
      }
      break;
    case 'clear':
      // Resets ConPTY's own screen model to match a front-end clear;
      // without this ConPTY keeps painting as if the old rows were still
      // there and the next keystroke scrambles the display.
      if (term) {
        try { term.clear(); } catch (_) { /* raced with exit */ }
      }
      break;
    case 'kill':
      shutdown(0);
      break;
    default:
      break;
  }
}));

// If Obsidian goes away, so does the shell and everything under it.
socket.on('close', () => shutdown(0));
socket.on('error', (err) => {
  process.stderr.write('ptyhost: socket error: ' + err.message + '\n');
  shutdown(1);
});

process.on('uncaughtException', (err) => {
  try { sendCtl({ t: 'error', fatal: true, message: 'host crashed: ' + err.message }); } catch (_) { /* pipe gone */ }
  shutdown(1);
});
