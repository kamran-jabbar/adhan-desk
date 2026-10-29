'use strict';
const { BrowserWindow, Menu, Tray, nativeImage, powerSaveBlocker, Notification, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startServer } = require('./server.cjs');

function secureWindow(window, expectedUrl) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== expectedUrl) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
}

// Operating-system integration lives here; it does not decide prayer times.
class DesktopService {
  constructor(app, paths) {
    this.app = app; this.paths = paths;
    this.window = null; this.tray = null; this.server = null; this.base = null;
    this.quitting = false; this.sleepBlock = null;
  }
  async start(getAudioPath, actions) {
    ({ server: this.server, base: this.base } = await startServer(this.paths.rendererDir, getAudioPath));
    actions.onServerReady?.(this.base);
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    this.actions = actions;
    this.window = new BrowserWindow({
      width: 1200, height: 900, minWidth: 900, minHeight: 700,
      title: 'Adhan Desk', autoHideMenuBar: true, backgroundColor: '#f5f3ec',
      icon: this.paths.iconPath, show: false,
      webPreferences: { preload: this.paths.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    secureWindow(this.window, this.base + 'index.html');
    this.window.on('close', event => { if (!this.quitting) { event.preventDefault(); this.window.hide(); } });
    this.tray = new Tray(nativeImage.createFromPath(this.paths.trayPath));
    this.tray.on('click', () => this.show());
    await this.window.loadURL(this.base + 'index.html');
    if (!process.argv.includes('--hidden')) this.show();
  }
  show() { if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); } }
  isMainSender(event) { return this.window && event.sender === this.window.webContents && event.senderFrame?.url === this.base + 'index.html'; }
  update(snapshot) {
    if (this.quitting) return;
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send('adhan:state', snapshot);
    const { settings, nextEvent, status } = snapshot;
    if (this.tray) {
      this.tray.setToolTip(`Adhan Desk · ${settings.enabled ? nextEvent ? `${nextEvent.prayer} ${nextEvent.time}` : 'Waiting for timetable' : 'Paused'}`);
      this.tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open Adhan Desk', click: () => this.show() },
        { label: settings.enabled ? 'Pause automatic adhan' : 'Enable automatic adhan', click: () => this.actions.toggle() },
        { label: 'Stop adhan', enabled: !!status.playback, click: () => this.actions.stop() },
        { type: 'separator' }, { label: 'Quit Adhan Desk', click: () => this.quit() }
      ]));
    }
    const needAwake = (settings.preventSleep && settings.enabled) || (!!status.playback && status.playback.state !== 'error');
    if (needAwake && this.sleepBlock === null) this.sleepBlock = powerSaveBlocker.start('prevent-app-suspension');
    if (!needAwake && this.sleepBlock !== null) { powerSaveBlocker.stop(this.sleepBlock); this.sleepBlock = null; }
  }
  setAutoStart(enabled) {
    if (enabled && !this.app.isPackaged) throw new Error('Start at login is available in the packaged app.');
    if (process.platform === 'linux') {
      const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
      const file = path.join(configDir, 'autostart', 'adhan-desk.desktop');
      if (enabled) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const executable = (process.env.APPIMAGE || process.execPath).replace(/["`$\\]/g, '\\$&').replace(/%/g, '%%');
        fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Adhan Desk\nExec="${executable}" --hidden\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`);
      } else if (fs.existsSync(file)) fs.unlinkSync(file);
    } else this.app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ['--hidden'] });
  }
  notifyError(message) { if (Notification.isSupported()) new Notification({ title: 'Adhan Desk · audio needs attention', body: message, silent: true }).show(); }
  quit() { this.quitting = true; this.app.quit(); }
  dispose() {
    this.quitting = true;
    if (this.sleepBlock !== null) powerSaveBlocker.stop(this.sleepBlock);
    this.sleepBlock = null; this.server?.close();
  }
}
module.exports = { DesktopService, secureWindow };
