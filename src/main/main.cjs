'use strict';
const { app, dialog } = require('electron');
const path = require('node:path');
const { AppController } = require('./controllers/AppController.cjs');

// Bootstrap only. Business behavior belongs to the MVC controller and models.
if (process.env.ADHAN_DESK_USER_DATA) app.setPath('userData', path.resolve(process.env.ADHAN_DESK_USER_DATA));
app.setAppUserModelId('org.adhdesk.desktop');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  const controller = new AppController(app, {
    rendererDir: path.join(__dirname, '../renderer'),
    defaultAudioPath: path.join(__dirname, '../../assets/adhan.mp3'),
    iconPath: path.join(__dirname, '../../assets/icon.png'),
    trayPath: path.join(__dirname, '../../assets/tray.png'),
    preloadPath: path.join(__dirname, 'preload.cjs')
  }, { testMode: process.env.ADHAN_DESK_TEST_MODE === '1' });
  app.on('second-instance', () => controller.desktop.show());
  app.on('activate', () => controller.desktop.show());
  app.on('window-all-closed', () => {});
  let shutdownStarted = false;
  app.on('before-quit', event => {
    if (shutdownStarted) return;
    event.preventDefault(); shutdownStarted = true;
    controller.dispose().finally(() => app.quit());
  });
  app.whenReady().then(() => controller.start()).catch(error => {
    dialog.showErrorBox('Adhan Desk could not start', error.stack || error.message);
    controller.desktop.quit();
  });
}
