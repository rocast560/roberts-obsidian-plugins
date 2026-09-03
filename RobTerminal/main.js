'use strict';

/*
 * RobTerminal v2 - a real terminal inside Obsidian.
 *
 * Rendering is xterm.js (vendored UMD, no CDN). The shell runs on a genuine
 * Windows ConPTY via node-pty, so PSReadLine, psmux, Claude Code, vim and
 * anything else that expects a terminal simply work.
 *
 * Architecture
 * ------------
 * node-pty is a native module. Loading it inside Obsidian would bind it to
 * Obsidian's Electron ABI and break on Obsidian updates, so it lives in a
 * separate host process (ptyhost.js) running under the system Node, talking
 * to us over a named pipe with a per-session token.
 *
 * That pipe is also why an elevated terminal can live in a pane: an elevated
 * process cannot inherit our stdio, but it can connect back to a pipe we
 * created. One UAC prompt, then a real admin shell in the workspace.
 */

const {
  Plugin,
  ItemView,
  Notice,
  PluginSettingTab,
  Setting,
  FileSystemAdapter,
  TFolder,
  Platform,
  setIcon,
  Menu,
  Scope,
} = require('obsidian');

const { spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const nodePath = require('path');
const fs = require('fs');

const VIEW_TYPE_ROBTERM = 'rob-terminal-view';

const T_DATA = 0;
const T_CTL = 1;

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  defaultProfile: '',
  nodePath: '',
  splitDirection: 'horizontal',
  reuseExistingPane: false,
  fontSize: 13,
  fontFamily: '',
  scrollback: 5000,
  cursorStyle: 'block',
  cursorBlink: true,
  useWebgl: true,
  showRibbonIcon: true,
  confirmCloseWhileRunning: false,
  psmuxPrefix: 'ctrl+b',
};

/** How long a pressed psmux prefix keeps the next key routed to the shell. */
const PREFIX_WINDOW_MS = 2000;

/**
 * Default chords for this plugin's commands. Shared by registerCommands and
 * by the focus scope, which re-registers them while a terminal owns the
 * keyboard (see claimKeyboard).
 */
const DEFAULT_COMMAND_HOTKEYS = {
  'terminal-here': [{ modifiers: ['Mod', 'Alt'], key: '`' }],
  'terminal-vault-root': [{ modifiers: ['Mod', 'Alt', 'Shift'], key: '`' }],
  'terminal-admin': [{ modifiers: ['Mod', 'Alt'], key: 'A' }],
  'terminal-focus': [{ modifiers: ['Mod', 'Alt'], key: 'T' }],
  'external-here': [{ modifiers: ['Mod', 'Alt'], key: 'E' }],
  'restart-session': [{ modifiers: ['Mod', 'Alt'], key: 'R' }],
};

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function encodePs(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Finds an executable on PATH, plus any extra directories given. */
function which(exe, extraDirs) {
  const dirs = String(process.env.PATH || '').split(nodePath.delimiter);
  if (extraDirs) dirs.unshift.apply(dirs, extraDirs);
  for (const dir of dirs) {
    if (!dir) continue;
    const full = nodePath.join(dir, exe);
    try {
      if (fs.existsSync(full)) return full;
    } catch (_) { /* unreadable entry */ }
  }
  return null;
}

function exists(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch (_) {
    return false;
  }
}

/** "ctrl+b" / "ctrl+space" / "ctrl+shift+a" -> {ctrl, alt, shift, key}. */
function parseKeyChord(spec) {
  if (!spec) return null;
  const chord = { ctrl: false, alt: false, shift: false, key: '' };
  for (const part of String(spec).toLowerCase().split('+')) {
    const p = part.trim();
    if (p === 'ctrl' || p === 'control') chord.ctrl = true;
    else if (p === 'alt') chord.alt = true;
    else if (p === 'shift') chord.shift = true;
    else if (p === 'space') chord.key = ' ';
    else if (p) chord.key = p;
  }
  return chord.key ? chord : null;
}

function matchesChord(evt, chord) {
  return evt.key.toLowerCase() === chord.key &&
    evt.ctrlKey === chord.ctrl &&
    evt.altKey === chord.alt &&
    evt.shiftKey === chord.shift &&
    !evt.metaKey;
}

/* ------------------------------------------------------------------ *
 * Runtime + shell discovery
 * ------------------------------------------------------------------ */

let cachedNode = null;

/**
 * The host needs a Node runtime. System Node is preferred because node-pty's
 * prebuilt binary was compiled for it. Obsidian's own Electron is the
 * fallback via ELECTRON_RUN_AS_NODE, which works only because node-pty is an
 * N-API module and therefore ABI-stable across runtimes.
 */
function discoverNode(override) {
  if (override && exists(override)) return { path: override, electron: false };
  if (cachedNode) return cachedNode;

  const extra = [];
  if (process.env.ProgramFiles) extra.push(nodePath.join(process.env.ProgramFiles, 'nodejs'));
  if (process.env.APPDATA) extra.push(nodePath.join(process.env.APPDATA, 'npm'));
  if (process.env.NVM_SYMLINK) extra.push(process.env.NVM_SYMLINK);

  const found = which('node.exe', extra);
  cachedNode = found
    ? { path: found, electron: false }
    : { path: process.execPath, electron: true };
  return cachedNode;
}

function windowsPowerShell() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return nodePath.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Shell profiles, detected once per session. */
function detectProfiles() {
  const out = [];
  const pf = process.env.ProgramFiles;
  const local = process.env.LOCALAPPDATA;

  const pwsh = which('pwsh.exe', [
    pf ? nodePath.join(pf, 'PowerShell', '7') : null,
    local ? nodePath.join(local, 'Microsoft', 'WindowsApps') : null,
  ].filter(Boolean));
  if (pwsh) out.push({ id: 'pwsh', name: 'PowerShell 7', file: pwsh, args: ['-NoLogo'], icon: 'terminal' });

  const ps5 = windowsPowerShell();
  if (exists(ps5)) {
    out.push({ id: 'powershell', name: 'Windows PowerShell', file: ps5, args: ['-NoLogo'], icon: 'terminal' });
  }

  const psmux = which('psmux.exe');
  if (psmux) out.push({ id: 'psmux', name: 'psmux', file: psmux, args: [], icon: 'layout-grid' });

  const cmd = nodePath.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  if (exists(cmd)) out.push({ id: 'cmd', name: 'Command Prompt', file: cmd, args: [], icon: 'square-terminal' });

  const gitBash = [
    pf ? nodePath.join(pf, 'Git', 'bin', 'bash.exe') : null,
    local ? nodePath.join(local, 'Programs', 'Git', 'bin', 'bash.exe') : null,
  ].find(exists);
  if (gitBash) out.push({ id: 'gitbash', name: 'Git Bash', file: gitBash, args: ['--login', '-i'], icon: 'git-branch' });

  const wsl = which('wsl.exe');
  if (wsl) out.push({ id: 'wsl', name: 'WSL', file: wsl, args: [], icon: 'square-terminal' });

  return out;
}

/* ------------------------------------------------------------------ *
 * Vendored xterm.js
 * ------------------------------------------------------------------ */

let XTERM = null;

function loadXterm(pluginDir) {
  if (XTERM) return XTERM;

  const read = (file) => fs.readFileSync(nodePath.join(pluginDir, 'vendor', file), 'utf8');

  // The vendored bundles are UMD. Handing them a module/exports pair makes
  // them take the CommonJS branch and hand the export straight back.
  const umd = (code, name) => {
    const mod = { exports: {} };
    const fn = new Function(
      'module', 'exports', 'define', 'require',
      code + '\n//# sourceURL=robterm-vendor/' + name,
    );
    fn.call(window, mod, mod.exports, undefined, undefined);
    return mod.exports;
  };

  XTERM = {
    Terminal: umd(read('xterm.js'), 'xterm.js').Terminal,
    FitAddon: umd(read('addon-fit.js'), 'addon-fit.js').FitAddon,
    WebglAddon: umd(read('addon-webgl.js'), 'addon-webgl.js').WebglAddon,
    Unicode11Addon: umd(read('addon-unicode11.js'), 'addon-unicode11.js').Unicode11Addon,
    SearchAddon: umd(read('addon-search.js'), 'addon-search.js').SearchAddon,
    css: read('xterm.css'),
  };
  return XTERM;
}

function injectXtermCss(css) {
  if (document.getElementById('robterm-xterm-css')) return;
  const style = document.createElement('style');
  style.id = 'robterm-xterm-css';
  style.textContent = css;
  document.head.appendChild(style);
}

/** Reads the current Obsidian theme so the terminal matches the app. */
function obsidianTheme() {
  const cs = getComputedStyle(document.body);
  const v = (name, fallback) => {
    const raw = cs.getPropertyValue(name).trim();
    return raw || fallback;
  };
  return {
    background: v('--background-primary', '#1e1e1e'),
    foreground: v('--text-normal', '#dcdcdc'),
    cursor: v('--text-normal', '#dcdcdc'),
    cursorAccent: v('--background-primary', '#1e1e1e'),
    selectionBackground: v('--text-selection', 'rgba(80,130,200,.35)'),
    black: '#1e1e1e',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#cccccc',
    brightBlack: '#767676',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#f2f2f2',
  };
}

/* ------------------------------------------------------------------ *
 * PTY bridge
 * ------------------------------------------------------------------ */

function frame(type, payload) {
  const head = Buffer.allocUnsafe(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

/**
 * Owns one PTY host process and the named pipe to it.
 *
 * @param {object} opts
 * @param {string}  opts.pluginDir
 * @param {object}  opts.node        {path, electron}
 * @param {boolean} opts.elevated    launch the host through UAC
 * @param {(buf:Buffer)=>void}  opts.onData
 * @param {(msg:object)=>void}  opts.onControl
 * @param {(msg:string)=>void}  opts.onFailure
 */
class PtyBridge {
  constructor(opts) {
    this.opts = opts;
    this.server = null;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.pending = [];
    this.connected = false;
    this.disposed = false;
    this.hostProcess = null;
    this.timer = 0;
  }

  start(spec) {
    this.spec = spec;
    const id = crypto.randomBytes(16).toString('hex');
    this.pipeName = '\\\\.\\pipe\\robterm-' + id;
    this.token = crypto.randomBytes(24).toString('hex');

    this.server = net.createServer((socket) => this.onConnection(socket));
    this.server.on('error', (err) => this.fail('pipe error: ' + err.message));
    this.server.listen(this.pipeName, () => this.launchHost());

    // UAC needs time for a human; a plain launch should be near-instant.
    const budget = this.opts.elevated ? 60000 : 15000;
    this.timer = window.setTimeout(() => {
      if (!this.connected) {
        this.fail(this.opts.elevated
          ? 'the elevated helper never connected (UAC declined?)'
          : 'the terminal host never connected');
      }
    }, budget);
  }

  hostScript() {
    return nodePath.join(this.opts.pluginDir, 'ptyhost.js');
  }

  launchHost() {
    const node = this.opts.node;
    const args = [this.hostScript(), this.pipeName, this.token];

    if (this.opts.elevated) {
      // Start-Process joins an -ArgumentList array with plain spaces, so pass
      // one pre-quoted string instead or any path with a space breaks.
      const argLine = args.map((a) => '"' + a + '"').join(' ');
      let launcher =
        `Start-Process -FilePath ${psQuote(node.path)} -Verb RunAs -WindowStyle Hidden ` +
        `-ArgumentList ${psQuote(argLine)}`;
      if (node.electron) {
        launcher = "$env:ELECTRON_RUN_AS_NODE='1'; " + launcher;
      }
      try {
        const child = spawn(
          windowsPowerShell(),
          ['-NoLogo', '-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encodePs(launcher)],
          { detached: true, stdio: 'ignore', windowsHide: true },
        );
        child.unref();
      } catch (err) {
        this.fail('could not request elevation: ' + err.message);
      }
      return;
    }

    const env = Object.assign({}, process.env);
    if (node.electron) env.ELECTRON_RUN_AS_NODE = '1';
    else delete env.ELECTRON_RUN_AS_NODE;

    try {
      this.hostProcess = spawn(node.path, args, {
        env,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      this.hostProcess.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      this.hostProcess.on('error', (err) => this.fail('could not start host: ' + err.message));
      this.hostProcess.on('exit', (code) => {
        if (!this.connected && !this.disposed) {
          this.fail('host exited (' + code + ') ' + stderr.trim());
        }
      });
    } catch (err) {
      this.fail('could not start host: ' + err.message);
    }
  }

  onConnection(socket) {
    if (this.connected) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.on('data', (chunk) => this.onChunk(chunk));
    socket.on('error', () => { /* surfaced through close */ });
    socket.on('close', () => {
      if (!this.disposed) this.opts.onControl({ t: 'disconnected' });
    });
    // One client only; stop listening so nothing else can attach.
    try { this.server.close(); } catch (_) { /* already closing */ }
  }

  onChunk(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 5) return;
      const len = this.buf.readUInt32BE(1);
      if (this.buf.length < 5 + len) return;
      const type = this.buf.readUInt8(0);
      const payload = this.buf.subarray(5, 5 + len);
      this.buf = this.buf.subarray(5 + len);

      if (type === T_DATA) {
        this.opts.onData(payload);
        continue;
      }
      let msg;
      try { msg = JSON.parse(payload.toString('utf8')); } catch (_) { continue; }
      this.handleControl(msg);
    }
  }

  handleControl(msg) {
    if (msg.t === 'hello') {
      if (msg.token !== this.token) {
        this.fail('rejected a host with a bad token');
        return;
      }
      this.connected = true;
      window.clearTimeout(this.timer);
      this.sendControl(Object.assign({ t: 'spawn' }, this.spec));
      for (const buf of this.pending) this.sendData(buf);
      this.pending.length = 0;
    }
    this.opts.onControl(msg);
  }

  sendControl(obj) {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(frame(T_CTL, Buffer.from(JSON.stringify(obj), 'utf8')));
  }

  sendData(buf) {
    if (!this.connected || !this.socket || this.socket.destroyed) {
      if (this.pending.length < 256) this.pending.push(buf);
      return;
    }
    this.socket.write(frame(T_DATA, buf));
  }

  write(text) {
    this.sendData(Buffer.from(text, 'utf8'));
  }

  /** xterm emits raw bytes as a latin1 string for mouse and paste sequences. */
  writeBinary(text) {
    const buf = Buffer.allocUnsafe(text.length);
    for (let i = 0; i < text.length; i++) buf[i] = text.charCodeAt(i) & 0xff;
    this.sendData(buf);
  }

  resize(cols, rows) {
    if (this.connected) this.sendControl({ t: 'resize', cols, rows });
  }

  clearPty() {
    if (this.connected) this.sendControl({ t: 'clear' });
  }

  fail(message) {
    if (this.disposed) return;
    this.opts.onFailure(message);
    this.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.timer);
    try { this.sendControl({ t: 'kill' }); } catch (_) { /* gone */ }
    try { if (this.socket) this.socket.end(); } catch (_) { /* gone */ }
    try { if (this.server) this.server.close(); } catch (_) { /* gone */ }
    // The host kills its own PTY when the pipe closes; this is only a
    // backstop for a host that never got that far.
    const proc = this.hostProcess;
    if (proc) {
      window.setTimeout(() => {
        try { proc.kill(); } catch (_) { /* already exited */ }
      }, 800);
    }
  }
}

/* ------------------------------------------------------------------ *
 * External windows
 * ------------------------------------------------------------------ */

function launchExternal(cwd, profile) {
  const local = process.env.LOCALAPPDATA;
  const wt = local ? nodePath.join(local, 'Microsoft', 'WindowsApps', 'wt.exe') : null;
  const fallback = () => {
    const child = spawn(profile.file, profile.args, {
      cwd, detached: true, stdio: 'ignore', windowsHide: false,
    });
    child.on('error', (err) => new Notice('RobTerminal: ' + err.message));
    child.unref();
  };
  try {
    if (!exists(wt)) {
      fallback();
      return;
    }
    const child = spawn(wt, ['-d', cwd, profile.file].concat(profile.args), {
      detached: true, stdio: 'ignore', windowsHide: false,
    });
    child.on('error', fallback);
    child.unref();
  } catch (err) {
    new Notice('RobTerminal: could not open external terminal - ' + err.message);
  }
}

function revealInExplorer(target) {
  try {
    const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
  } catch (err) {
    new Notice('RobTerminal: could not open Explorer - ' + err.message);
  }
}

/* ------------------------------------------------------------------ *
 * Terminal view
 * ------------------------------------------------------------------ */

class RobTerminalView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.cwd = plugin.vaultBase() || process.cwd();
    this.profileId = '';
    this.elevated = false;
    this.term = null;
    this.bridge = null;
    this.fitAddon = null;
    this.searchAddon = null;
    this.resizeObserver = null;
    this.exited = false;
    this.shellPid = 0;
    this.prefixArmed = false;
    this.prefixTimer = 0;
  }

  getViewType() { return VIEW_TYPE_ROBTERM; }

  getDisplayText() {
    const dir = nodePath.basename(this.cwd) || this.cwd;
    return (this.elevated ? 'Admin: ' : '') + dir;
  }

  getIcon() { return this.elevated ? 'shield' : 'terminal'; }

  getState() {
    return { cwd: this.cwd, profileId: this.profileId, elevated: this.elevated };
  }

  async setState(state, result) {
    if (state) {
      if (state.cwd) this.cwd = state.cwd;
      if (state.profileId) this.profileId = state.profileId;
      // Never silently re-elevate on workspace restore; that would fire a UAC
      // prompt the user did not ask for.
      this.elevated = false;
    }
    await super.setState(state, result);
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('robterm-root');

    this.buildToolbar(root);
    this.termEl = root.createDiv({ cls: 'robterm-term' });

    // setState arrives right after onOpen, so let it land before we spawn.
    window.setTimeout(() => this.boot(), 0);
  }

  buildToolbar(root) {
    const bar = root.createDiv({ cls: 'robterm-toolbar' });
    this.statusEl = bar.createSpan({ cls: 'robterm-status' });
    this.prefixEl = bar.createSpan({ cls: 'robterm-prefix hidden', text: 'prefix' });
    this.titleEl = bar.createSpan({ cls: 'robterm-cwd' });
    bar.createDiv({ cls: 'robterm-spacer' });

    this.searchWrap = bar.createDiv({ cls: 'robterm-search hidden' });
    this.searchInput = this.searchWrap.createEl('input', {
      cls: 'robterm-search-input',
      attr: { type: 'text', placeholder: 'Find\u2026', spellcheck: 'false' },
    });
    this.searchInput.addEventListener('keydown', (evt) => {
      evt.stopPropagation();
      if (evt.key === 'Enter') {
        if (this.searchAddon) {
          if (evt.shiftKey) this.searchAddon.findPrevious(this.searchInput.value);
          else this.searchAddon.findNext(this.searchInput.value);
        }
      } else if (evt.key === 'Escape') {
        this.toggleSearch(false);
      }
    });

    const button = (icon, tip, fn) => {
      const el = bar.createEl('button', { cls: 'robterm-btn' });
      setIcon(el, icon);
      el.setAttribute('aria-label', tip);
      el.addEventListener('click', (evt) => {
        evt.preventDefault();
        fn();
        this.focusTerm();
      });
    };

    button('search', 'Find (Ctrl+Shift+F)', () => this.toggleSearch());
    button('external-link', 'Open this directory in a real console window', () =>
      launchExternal(this.cwd, this.plugin.profileById(this.profileId)));
    button('folder-open', 'Reveal in File Explorer', () => revealInExplorer(this.cwd));
    button('rotate-ccw', 'Restart session (Ctrl+Shift+R)', () => this.restart());
  }

  /* ---------------- lifecycle ---------------- */

  boot() {
    let xterm;
    try {
      xterm = loadXterm(this.plugin.pluginDir());
    } catch (err) {
      this.fatal('could not load the bundled xterm.js: ' + err.message);
      return;
    }
    injectXtermCss(xterm.css);

    const s = this.plugin.settings;
    this.term = new xterm.Terminal({
      allowProposedApi: true,
      fontSize: s.fontSize,
      fontFamily: s.fontFamily || 'Cascadia Mono, Consolas, "Courier New", monospace',
      scrollback: s.scrollback,
      cursorStyle: s.cursorStyle,
      cursorBlink: s.cursorBlink,
      theme: obsidianTheme(),
      windowsPty: { backend: 'conpty' },
      macOptionIsMeta: false,
      convertEol: false,
    });

    this.fitAddon = new xterm.FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.searchAddon = new xterm.SearchAddon();
    this.term.loadAddon(this.searchAddon);

    try {
      const uni = new xterm.Unicode11Addon();
      this.term.loadAddon(uni);
      this.term.unicode.activeVersion = '11';
    } catch (_) { /* wide-char widths fall back to v6 tables */ }

    this.term.open(this.termEl);

    if (s.useWebgl) {
      try {
        const webgl = new xterm.WebglAddon();
        webgl.onContextLoss(() => { try { webgl.dispose(); } catch (_) { /* gone */ } });
        this.term.loadAddon(webgl);
      } catch (_) { /* DOM renderer is the fallback */ }
    }

    this.term.attachCustomKeyEventHandler((evt) => this.onTermKey(evt));
    // Keep Obsidian's global hotkeys out of the terminal: Ctrl+B belongs to
    // psmux, Ctrl+P to the shell, not to bold and the command palette.
    this.termEl.addEventListener('keydown', (evt) => {
      // Plugin launch bindings still work - unless a psmux prefix chord is
      // mid-flight, in which case even Ctrl+Alt belongs to the shell.
      if (evt.ctrlKey && evt.altKey && !this.prefixArmed) return;
      evt.stopPropagation();
    });
    this.termEl.addEventListener('mousedown', () => this.focusTerm());

    // Obsidian's hotkey manager wins the capture phase on window, so while
    // the terminal owns the keyboard we suppress global hotkeys via a Scope
    // (see claimKeyboard). Tracked by focus, not by active-leaf, so it also
    // covers popout windows.
    this.registerDomEvent(this.contentEl, 'focusin', () => this.plugin.claimKeyboard(this));
    this.registerDomEvent(this.contentEl, 'focusout', (evt) => {
      const next = evt.relatedTarget;
      if (!next || !this.contentEl.contains(next)) this.plugin.releaseKeyboard(this);
    });

    this.term.onData((d) => { if (this.bridge) this.bridge.write(d); });
    this.term.onBinary((d) => { if (this.bridge) this.bridge.writeBinary(d); });
    this.term.onResize(({ cols, rows }) => { if (this.bridge) this.bridge.resize(cols, rows); });
    this.term.onTitleChange((title) => {
      this.shellTitle = title;
      this.updateTitle();
    });

    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(this.termEl);
    this.scheduleFit();

    this.connect();
  }

  connect() {
    const plugin = this.plugin;
    const profile = plugin.profileById(this.profileId);
    this.profileId = profile.id;

    const node = discoverNode(plugin.settings.nodePath);
    this.setStatus('starting', this.elevated ? 'elevating' : 'starting');
    this.updateTitle();

    this.bridge = new PtyBridge({
      pluginDir: plugin.pluginDir(),
      node,
      elevated: this.elevated,
      onData: (buf) => { if (this.term) this.term.write(buf); },
      onControl: (msg) => this.onControl(msg),
      onFailure: (message) => this.fatal(message),
    });

    const dims = this.term ? { cols: this.term.cols, rows: this.term.rows } : { cols: 80, rows: 24 };
    this.bridge.start({
      file: profile.file,
      args: profile.args,
      cwd: this.cwd,
      cols: dims.cols,
      rows: dims.rows,
      env: {},
    });

    if (this.elevated) {
      new Notice('RobTerminal: approve the UAC prompt to attach the admin shell.');
    }
  }

  onControl(msg) {
    switch (msg.t) {
      case 'spawned':
        this.shellPid = msg.pid;
        this.exited = false;
        this.setStatus('live', this.elevated ? 'admin' : 'live');
        this.scheduleFit();
        this.focusTerm();
        break;
      case 'exit':
        this.exited = true;
        this.setStatus('dead', 'exited ' + msg.code);
        this.writeNotice('\r\n\x1b[90m[process exited with code ' + msg.code +
          ' \u2014 Ctrl+Shift+R to restart]\x1b[0m\r\n');
        break;
      case 'disconnected':
        if (!this.exited) {
          this.exited = true;
          this.setStatus('dead', 'disconnected');
          this.writeNotice('\r\n\x1b[90m[terminal host disconnected \u2014 Ctrl+Shift+R to restart]\x1b[0m\r\n');
        }
        break;
      case 'error':
        this.fatal(msg.message);
        break;
      default:
        break;
    }
  }

  writeNotice(text) {
    if (this.term) this.term.write(text);
  }

  fatal(message) {
    this.setStatus('dead', 'failed');
    this.writeNotice('\r\n\x1b[91mRobTerminal: ' + message + '\x1b[0m\r\n');
    new Notice('RobTerminal: ' + message, 8000);
  }

  restart() {
    if (this.bridge) {
      this.bridge.dispose();
      this.bridge = null;
    }
    if (this.term) this.term.reset();
    this.exited = false;
    this.connect();
  }

  /** Re-points this pane at another directory by restarting the shell there. */
  changeDirectory(dir) {
    this.cwd = dir;
    this.updateTitle();
    this.restart();
  }

  /* ---------------- keys ---------------- */

  onTermKey(evt) {
    if (evt.type !== 'keydown') return true;

    // A psmux prefix chord is in flight: whatever comes next belongs to the
    // shell, bypassing every plugin shortcut and Obsidian binding below.
    if (this.prefixArmed) {
      evt.stopPropagation();
      if (!MODIFIER_KEYS.has(evt.key)) this.disarmPrefix();
      return true;
    }

    const prefix = this.plugin.prefixChord();
    if (prefix && matchesChord(evt, prefix)) {
      evt.stopPropagation();
      this.armPrefix();
      return true; // psmux still needs to see the prefix itself
    }

    // Ctrl+Alt+* are the plugin's launch bindings; let them reach Obsidian
    // instead of the shell.
    if (evt.ctrlKey && evt.altKey) return false;

    if (evt.ctrlKey && evt.shiftKey) {
      const key = evt.key.toLowerCase();
      if (key === 'c') {
        const sel = this.term.getSelection();
        if (sel) {
          navigator.clipboard.writeText(sel);
          this.term.clearSelection();
        }
        return false;
      }
      if (key === 'v') {
        navigator.clipboard.readText().then((text) => {
          if (text && this.bridge) this.term.paste(text);
        });
        return false;
      }
      if (key === 'f') { this.toggleSearch(); return false; }
      if (key === 'r') { this.restart(); return false; }
      if (key === 'n') {
        this.plugin.openTerminal({ dir: this.cwd, mode: 'split', profileId: this.profileId });
        return false;
      }
    }

    // Ctrl+L clears the pane. Full-screen apps (psmux, vim) live on the
    // alternate buffer and keep it as their redraw key.
    if (evt.ctrlKey && !evt.shiftKey && evt.key.toLowerCase() === 'l') {
      if (this.onAltBuffer()) return true;
      this.clearOutput();
      return false;
    }

    // Anything else is the shell's: Ctrl+C interrupts for real, Ctrl+B is
    // psmux's prefix, Ctrl+R is history search.
    return true;
  }

  armPrefix() {
    this.prefixArmed = true;
    if (this.prefixEl) this.prefixEl.removeClass('hidden');
    window.clearTimeout(this.prefixTimer);
    this.prefixTimer = window.setTimeout(() => this.disarmPrefix(), PREFIX_WINDOW_MS);
  }

  disarmPrefix() {
    this.prefixArmed = false;
    window.clearTimeout(this.prefixTimer);
    if (this.prefixEl) this.prefixEl.addClass('hidden');
  }

  onAltBuffer() {
    return !!(this.term && this.term.buffer &&
      this.term.buffer.active && this.term.buffer.active.type === 'alternate');
  }

  /** Wipes screen and scrollback; the prompt line becomes the first line. */
  clearOutput() {
    if (!this.term) return;
    if (this.onAltBuffer()) {
      // A full-screen app owns the buffer; ask it to redraw instead.
      if (this.bridge) this.bridge.write('\x0c');
      return;
    }
    this.term.clear();
    // ConPTY keeps its own screen model; reset it too or it will keep
    // painting at the old cursor row as if nothing was cleared.
    if (this.bridge) this.bridge.clearPty();
  }

  toggleSearch(force) {
    const show = force === undefined ? this.searchWrap.hasClass('hidden') : force;
    this.searchWrap.toggleClass('hidden', !show);
    if (show) {
      this.searchInput.focus();
      this.searchInput.select();
    } else {
      if (this.searchAddon) this.searchAddon.clearDecorations();
      this.focusTerm();
    }
  }

  /* ---------------- layout ---------------- */

  scheduleFit() {
    if (this.fitPending) return;
    this.fitPending = true;
    window.requestAnimationFrame(() => {
      this.fitPending = false;
      this.fit();
    });
  }

  fit() {
    if (!this.fitAddon || !this.termEl) return;
    if (!this.termEl.clientWidth || !this.termEl.clientHeight) return; // hidden tab
    try { this.fitAddon.fit(); } catch (_) { /* mid-teardown */ }
  }

  onResize() { this.scheduleFit(); }

  focusTerm() {
    if (this.term) this.term.focus();
  }

  setStatus(cls, label) {
    if (!this.statusEl) return;
    this.statusEl.className = 'robterm-status robterm-status-' + cls;
    this.statusEl.setText(label);
  }

  updateTitle() {
    if (this.titleEl) {
      const profile = this.plugin.profileById(this.profileId);
      const parts = this.cwd.split(/[\\/]/).filter(Boolean);
      const short = parts.length > 2 ? '\u2026\\' + parts.slice(-2).join('\\') : this.cwd;
      this.titleEl.setText(profile.name + '  \u00b7  ' + short);
      this.titleEl.setAttribute('aria-label', this.cwd);
    }
    if (this.leaf && typeof this.leaf.updateHeader === 'function') this.leaf.updateHeader();
  }

  applySettings() {
    const s = this.plugin.settings;
    if (!this.term) return;
    this.term.options.fontSize = s.fontSize;
    this.term.options.fontFamily = s.fontFamily || 'Cascadia Mono, Consolas, "Courier New", monospace';
    this.term.options.scrollback = s.scrollback;
    this.term.options.cursorStyle = s.cursorStyle;
    this.term.options.cursorBlink = s.cursorBlink;
    this.scheduleFit();
  }

  applyTheme() {
    if (this.term) this.term.options.theme = obsidianTheme();
  }

  async onClose() {
    this.plugin.releaseKeyboard(this);
    window.clearTimeout(this.prefixTimer);
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.bridge) {
      this.bridge.dispose();
      this.bridge = null;
    }
    if (this.term) {
      this.term.dispose();
      this.term = null;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

class RobTerminalPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    if (!Platform.isDesktopApp) {
      new Notice('RobTerminal only works on desktop Obsidian.');
      return;
    }

    this.profiles = detectProfiles();
    if (!this.profiles.length) {
      new Notice('RobTerminal: no usable shell found on this machine.');
      return;
    }

    this.registerView(VIEW_TYPE_ROBTERM, (leaf) => new RobTerminalView(leaf, this));

    if (this.settings.showRibbonIcon) {
      this.addRibbonIcon('terminal', 'RobTerminal: open terminal here', () =>
        this.openTerminal({ mode: 'split' }));
    }

    this.registerCommands();
    this.registerMenus();

    this.registerEvent(this.app.workspace.on('css-change', () => {
      for (const view of this.terminalViews()) view.applyTheme();
    }));

    this.addSettingTab(new RobTerminalSettingTab(this.app, this));
  }

  onunload() {
    if (this.termScope) {
      this.app.keymap.popScope(this.termScope);
      this.termScope = null;
    }
  }

  /* ---------------- settings ---------------- */

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /* ---------------- paths and profiles ---------------- */

  vaultBase() {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    if (typeof adapter.getBasePath === 'function') return adapter.getBasePath();
    return null;
  }

  pluginDir() {
    const adapter = this.app.vault.adapter;
    if (this.manifest.dir && typeof adapter.getFullPath === 'function') {
      return adapter.getFullPath(this.manifest.dir);
    }
    return nodePath.join(this.vaultBase(), this.app.vault.configDir, 'plugins', this.manifest.id);
  }

  profileById(id) {
    const wanted = id || this.settings.defaultProfile;
    return this.profiles.find((p) => p.id === wanted) || this.profiles[0];
  }

  /* ---------------- keyboard ownership ----------------
   *
   * Obsidian's hotkey manager listens for keydown on WINDOW in the CAPTURE
   * phase, so it beats every element handler: Ctrl+B became "toggle bold"
   * and Ctrl+L "toggle checkbox" before xterm.js ever saw the event, and no
   * stopPropagation further down can prevent that. While a terminal has
   * focus we push a Scope, which suppresses global hotkeys wholesale; the
   * plugin's own launch bindings are re-registered inside it so they keep
   * working (respecting any custom hotkeys from Settings > Hotkeys).
   */

  scopeCommandIds() {
    const ids = Object.keys(DEFAULT_COMMAND_HOTKEYS)
      .concat(['terminal-new-tab', 'terminal-popout-window', 'reveal-in-explorer', 'clear-terminal']);
    for (const profile of this.profiles || []) ids.push('open-profile-' + profile.id);
    return ids;
  }

  hotkeysFor(fullId, shortId) {
    const hm = this.app.hotkeyManager;
    try {
      if (hm && typeof hm.getHotkeys === 'function') {
        const custom = hm.getHotkeys(fullId);
        if (custom && custom.length) return custom;
      }
      if (hm && typeof hm.getDefaultHotkeys === 'function') {
        const def = hm.getDefaultHotkeys(fullId);
        if (def && def.length) return def;
      }
    } catch (_) { /* internal API drift; fall back to our own table */ }
    return DEFAULT_COMMAND_HOTKEYS[shortId] || [];
  }

  buildTerminalScope() {
    const scope = new Scope(); // no parent: global hotkeys stay suppressed
    for (const id of this.scopeCommandIds()) {
      const fullId = this.manifest.id + ':' + id;
      for (const hk of this.hotkeysFor(fullId, id)) {
        if (!hk || !hk.key) continue;
        scope.register(hk.modifiers || [], hk.key, () => {
          const view = this.activeTerminal();
          if (view && view.prefixArmed) return true; // psmux chord in flight
          this.app.commands.executeCommandById(fullId);
          return false;
        });
      }
    }
    return scope;
  }

  claimKeyboard(view) {
    if (!this.focusedTerms) this.focusedTerms = new Set();
    const wasEmpty = this.focusedTerms.size === 0;
    this.focusedTerms.add(view);
    if (wasEmpty && !this.termScope) {
      this.termScope = this.buildTerminalScope();
      this.app.keymap.pushScope(this.termScope);
    }
  }

  releaseKeyboard(view) {
    if (!this.focusedTerms || !this.focusedTerms.delete(view)) return;
    if (this.focusedTerms.size === 0 && this.termScope) {
      this.app.keymap.popScope(this.termScope);
      this.termScope = null;
    }
  }

  /** Parsed psmux prefix chord, re-parsed only when the setting changes. */
  prefixChord() {
    if (this.prefixSpec !== this.settings.psmuxPrefix) {
      this.prefixSpec = this.settings.psmuxPrefix;
      this.parsedPrefix = parseKeyChord(this.prefixSpec);
    }
    return this.parsedPrefix;
  }

  /** Absolute directory for a TFile/TFolder; folders map to themselves. */
  dirForAbstractFile(file) {
    const base = this.vaultBase();
    if (!base) return process.cwd();
    if (!file) return base;
    const isFolder = file instanceof TFolder || file.children !== undefined;
    const rel = isFolder ? file.path : (file.parent ? file.parent.path : '');
    if (!rel || rel === '/' || rel === '.') return base;
    return nodePath.join(base, rel);
  }

  dirForActiveFile() {
    return this.dirForAbstractFile(this.app.workspace.getActiveFile());
  }

  terminalViews() {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE_ROBTERM)
      .map((leaf) => leaf.view)
      .filter((view) => view instanceof RobTerminalView);
  }

  activeTerminal() {
    return this.app.workspace.getActiveViewOfType(RobTerminalView);
  }

  /** Active terminal's directory wins over the active note's folder. */
  contextDir() {
    const view = this.activeTerminal();
    return view ? view.cwd : this.dirForActiveFile();
  }

  /* ---------------- opening ---------------- */

  /**
   * @param {object} o
   * @param {string}  [o.dir]
   * @param {'split'|'tab'|'window'} [o.mode]
   * @param {string}  [o.profileId]
   * @param {boolean} [o.elevated]
   */
  async openTerminal(o) {
    const opts = o || {};
    const dir = opts.dir || this.dirForActiveFile();
    const mode = opts.mode || 'split';
    const { workspace } = this.app;

    if (this.settings.reuseExistingPane && mode === 'split' && !opts.elevated) {
      const existing = this.terminalViews().find((v) => !v.elevated);
      if (existing) {
        workspace.revealLeaf(existing.leaf);
        existing.changeDirectory(dir);
        existing.focusTerm();
        return;
      }
    }

    let leaf;
    if (mode === 'window') leaf = workspace.getLeaf('window');
    else if (mode === 'tab') leaf = workspace.getLeaf('tab');
    else leaf = workspace.getLeaf('split', this.settings.splitDirection);

    await leaf.setViewState({
      type: VIEW_TYPE_ROBTERM,
      active: true,
      state: { cwd: dir, profileId: opts.profileId || this.settings.defaultProfile },
    });
    workspace.revealLeaf(leaf);

    // Elevation is deliberately set after setState, which always clears it, so
    // that a restored workspace never triggers an unexpected UAC prompt.
    if (opts.elevated && leaf.view instanceof RobTerminalView) {
      leaf.view.elevated = true;
    }
  }

  /* ---------------- commands ---------------- */

  registerCommands() {
    this.addCommand({
      id: 'terminal-here',
      name: 'Open terminal below current note',
      hotkeys: DEFAULT_COMMAND_HOTKEYS['terminal-here'],
      callback: () => this.openTerminal({ mode: 'split' }),
    });

    this.addCommand({
      id: 'terminal-vault-root',
      name: 'Open terminal at vault root',
      hotkeys: DEFAULT_COMMAND_HOTKEYS['terminal-vault-root'],
      callback: () => this.openTerminal({ dir: this.vaultBase(), mode: 'split' }),
    });

    this.addCommand({
      id: 'terminal-admin',
      name: 'Open Administrator terminal here (UAC)',
      hotkeys: DEFAULT_COMMAND_HOTKEYS['terminal-admin'],
      callback: () => this.openTerminal({ dir: this.contextDir(), mode: 'split', elevated: true }),
    });

    this.addCommand({
      id: 'terminal-new-tab',
      name: 'Open terminal in a new tab',
      callback: () => this.openTerminal({ mode: 'tab' }),
    });

    this.addCommand({
      id: 'terminal-popout-window',
      name: 'Open terminal in a popout window',
      callback: () => this.openTerminal({ mode: 'window' }),
    });

    this.addCommand({
      id: 'terminal-focus',
      name: 'Focus terminal (open one if none)',
      hotkeys: DEFAULT_COMMAND_HOTKEYS['terminal-focus'],
      callback: () => {
        const views = this.terminalViews();
        if (!views.length) {
          this.openTerminal({ mode: 'split' });
          return;
        }
        this.app.workspace.revealLeaf(views[0].leaf);
        views[0].focusTerm();
      },
    });

    this.addCommand({
      id: 'external-here',
      name: 'Open external console window here',
      hotkeys: DEFAULT_COMMAND_HOTKEYS['external-here'],
      callback: () => launchExternal(this.contextDir(), this.profileById('')),
    });

    this.addCommand({
      id: 'restart-session',
      name: 'Restart active terminal',
      hotkeys: DEFAULT_COMMAND_HOTKEYS['restart-session'],
      checkCallback: (checking) => {
        const view = this.activeTerminal();
        if (!view) return false;
        if (!checking) view.restart();
        return true;
      },
    });

    this.addCommand({
      id: 'clear-terminal',
      name: 'Clear active terminal output',
      checkCallback: (checking) => {
        const view = this.activeTerminal();
        if (!view) return false;
        if (!checking) view.clearOutput();
        return true;
      },
    });

    this.addCommand({
      id: 'reveal-in-explorer',
      name: 'Reveal current folder in File Explorer',
      callback: () => revealInExplorer(this.contextDir()),
    });

    // One command per detected shell so any of them can get its own hotkey.
    for (const profile of this.profiles) {
      this.addCommand({
        id: 'open-profile-' + profile.id,
        name: 'Open terminal: ' + profile.name,
        callback: () => this.openTerminal({ mode: 'split', profileId: profile.id }),
      });
    }
  }

  /* ---------------- context menus ---------------- */

  registerMenus() {
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      this.addMenuEntries(menu, this.dirForAbstractFile(file));
    }));

    this.registerEvent(this.app.workspace.on('editor-menu', (menu, _editor, view) => {
      if (view && view.file) this.addMenuEntries(menu, this.dirForAbstractFile(view.file));
    }));
  }

  addMenuEntries(menu, dir) {
    menu.addItem((item) => {
      item.setTitle('Launch terminal').setIcon('terminal');

      if (typeof item.setSubmenu !== 'function') {
        item.onClick(() => this.openTerminal({ dir, mode: 'split' }));
        return;
      }

      const sub = item.setSubmenu();
      sub.addItem((s) => s
        .setTitle('Split below')
        .setIcon('terminal')
        .onClick(() => this.openTerminal({ dir, mode: 'split' })));
      sub.addItem((s) => s
        .setTitle('New tab')
        .setIcon('layout')
        .onClick(() => this.openTerminal({ dir, mode: 'tab' })));
      sub.addItem((s) => s
        .setTitle('As Administrator (UAC)')
        .setIcon('shield')
        .onClick(() => this.openTerminal({ dir, mode: 'split', elevated: true })));
      sub.addSeparator();
      for (const profile of this.profiles) {
        sub.addItem((s) => s
          .setTitle(profile.name)
          .setIcon(profile.icon)
          .onClick(() => this.openTerminal({ dir, mode: 'split', profileId: profile.id })));
      }
      sub.addSeparator();
      sub.addItem((s) => s
        .setTitle('External console window')
        .setIcon('external-link')
        .onClick(() => launchExternal(dir, this.profileById(''))));
      sub.addItem((s) => s
        .setTitle('Reveal in File Explorer')
        .setIcon('folder-open')
        .onClick(() => revealInExplorer(dir)));
    });
  }
}

/* ------------------------------------------------------------------ *
 * Settings tab
 * ------------------------------------------------------------------ */

class RobTerminalSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  refreshViews() {
    for (const view of this.plugin.terminalViews()) view.applySettings();
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const profiles = this.plugin.profiles || [];
    const node = discoverNode(this.plugin.settings.nodePath);

    new Setting(containerEl)
      .setName('Default shell')
      .setDesc('Detected: ' + profiles.map((p) => p.name).join(', '))
      .addDropdown((drop) => {
        for (const p of profiles) drop.addOption(p.id, p.name);
        drop.setValue(this.plugin.profileById('').id);
        drop.onChange(async (value) => {
          this.plugin.settings.defaultProfile = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Node runtime')
      .setDesc(
        node.electron
          ? 'No system Node found; falling back to Obsidian\u2019s runtime. Installing Node.js is more reliable.'
          : 'Runs the PTY host. Detected: ' + node.path,
      )
      .addText((text) => text
        .setPlaceholder(node.path)
        .setValue(this.plugin.settings.nodePath)
        .onChange(async (value) => {
          this.plugin.settings.nodePath = value.trim();
          cachedNode = null;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Split direction')
      .setDesc('Horizontal puts the terminal beneath the note.')
      .addDropdown((drop) => drop
        .addOption('horizontal', 'Horizontal (below)')
        .addOption('vertical', 'Vertical (right)')
        .setValue(this.plugin.settings.splitDirection)
        .onChange(async (value) => {
          this.plugin.settings.splitDirection = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Reuse one terminal pane')
      .setDesc('Restart the existing terminal in the new folder instead of opening another pane.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.reuseExistingPane)
        .onChange(async (value) => {
          this.plugin.settings.reuseExistingPane = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Appearance' });

    new Setting(containerEl)
      .setName('Font size')
      .addSlider((sl) => sl
        .setLimits(8, 24, 1)
        .setValue(this.plugin.settings.fontSize)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.fontSize = value;
          await this.plugin.saveSettings();
          this.refreshViews();
        }));

    new Setting(containerEl)
      .setName('Font family')
      .setDesc('Use a Nerd Font here if your prompt or psmux theme needs glyphs.')
      .addText((text) => text
        .setPlaceholder('Cascadia Mono, Consolas')
        .setValue(this.plugin.settings.fontFamily)
        .onChange(async (value) => {
          this.plugin.settings.fontFamily = value.trim();
          await this.plugin.saveSettings();
          this.refreshViews();
        }));

    new Setting(containerEl)
      .setName('Scrollback lines')
      .addSlider((sl) => sl
        .setLimits(1000, 50000, 1000)
        .setValue(this.plugin.settings.scrollback)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.scrollback = value;
          await this.plugin.saveSettings();
          this.refreshViews();
        }));

    new Setting(containerEl)
      .setName('Cursor style')
      .addDropdown((drop) => drop
        .addOption('block', 'Block')
        .addOption('bar', 'Bar')
        .addOption('underline', 'Underline')
        .setValue(this.plugin.settings.cursorStyle)
        .onChange(async (value) => {
          this.plugin.settings.cursorStyle = value;
          await this.plugin.saveSettings();
          this.refreshViews();
        }));

    new Setting(containerEl)
      .setName('Blinking cursor')
      .addToggle((t) => t
        .setValue(this.plugin.settings.cursorBlink)
        .onChange(async (value) => {
          this.plugin.settings.cursorBlink = value;
          await this.plugin.saveSettings();
          this.refreshViews();
        }));

    new Setting(containerEl)
      .setName('GPU rendering')
      .setDesc('WebGL renderer. Turn off if you see artefacts. Applies to new terminals.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.useWebgl)
        .onChange(async (value) => {
          this.plugin.settings.useWebgl = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Show ribbon icon')
      .setDesc('Applies after reloading the plugin.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.showRibbonIcon)
        .onChange(async (value) => {
          this.plugin.settings.showRibbonIcon = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Keyboard' });

    new Setting(containerEl)
      .setName('psmux prefix key')
      .setDesc('After this chord the next keystroke always goes to the shell, bypassing ' +
        'the plugin\u2019s Ctrl+Shift shortcuts and Obsidian\u2019s Ctrl+Alt bindings, so every ' +
        'psmux "prefix + key" combination works. Format: ctrl+b, ctrl+space, ctrl+shift+a. ' +
        'Leave empty to disable.')
      .addText((text) => text
        .setPlaceholder('ctrl+b')
        .setValue(this.plugin.settings.psmuxPrefix)
        .onChange(async (value) => {
          this.plugin.settings.psmuxPrefix = value.trim().toLowerCase();
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('p', {
      cls: 'robterm-hint',
      text: 'Inside a terminal every key goes to the shell \u2014 Ctrl+C interrupts, ' +
        'Ctrl+B is psmux\u2019s prefix, Ctrl+R searches history. Plugin actions use Ctrl+Shift. ' +
        'While a prefix chord is pending, a \u201cprefix\u201d badge shows in the toolbar.',
    });
    const list = containerEl.createEl('ul', { cls: 'robterm-keylist' });
    const rows = [
      ['Ctrl+Alt+`', 'Terminal below the current note'],
      ['Ctrl+Alt+Shift+`', 'Terminal at the vault root'],
      ['Ctrl+Alt+A', 'Administrator terminal in a pane (UAC)'],
      ['Ctrl+Alt+T', 'Focus the terminal'],
      ['Ctrl+Alt+E', 'External console window'],
      ['Ctrl+Alt+R', 'Restart the active terminal'],
      ['Ctrl+L', 'Clear output and scrollback (full-screen apps keep it as redraw)'],
      ['Ctrl+B, <key>', 'psmux chord \u2014 the second key bypasses all plugin shortcuts'],
      ['Ctrl+Shift+C / V', 'Copy / paste'],
      ['Ctrl+Shift+F', 'Find in scrollback'],
      ['Ctrl+Shift+R', 'Restart this terminal'],
      ['Ctrl+Shift+N', 'New terminal in the same directory'],
    ];
    for (const [key, desc] of rows) {
      const li = list.createEl('li');
      li.createEl('code', { text: key });
      li.appendText(' \u2014 ' + desc);
    }
    containerEl.createEl('p', {
      cls: 'robterm-hint',
      text: 'Every shell also gets its own command, so you can bind one directly to psmux. ' +
        'Rebind under Settings > Hotkeys, search "RobTerminal".',
    });
  }
}

module.exports = RobTerminalPlugin;
module.exports.default = RobTerminalPlugin;
