'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const { autoUpdater } = require('electron-updater');
const log  = require('electron-log');
const Store = require('electron-store');

process.on('uncaughtException', (err) => {
  log.error('uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection:', reason);
});

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('no-sandbox');

log.transports.file.level = 'info';
log.transports.console.level = 'warn';
autoUpdater.logger = log;

const store = new Store({
  defaults: {
    username:      '',
    ram:           2048,
    javaPath:      '',
    gameDir:       path.join(app.getPath('appData'), '.ycraft'),
    windowWidth:   1280,
    windowHeight:  720,
    fullscreen:    false,
    closeOnLaunch: false,
    serverIP:      'play.y-craft.net',
    autoConnect:   false,
    lastVersion:   ''
  }
});

const LAUNCHER_VERSION     = app.getVersion();
const UPDATE_FEED_URL      = 'https://updates.y-craft.net/launcher';
const MODPACK_MANIFEST_URL = 'https://updates.y-craft.net/modpack/manifest.json';
const FORGE_VERSION        = '47.4.10';
const MC_VERSION           = '1.20.1';

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width:           1060,
    height:          640,
    minWidth:        880,
    minHeight:       560,
    frame:           false,
    transparent:     false,
    backgroundColor: '#0d0f14',
    resizable:       true,
    icon:            (() => { const p = path.join(__dirname, '../../assets/icon.png'); return fs.existsSync(p) ? p : undefined; })(),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false
    }
  });

  const indexPath = path.join(__dirname, '../renderer/index.html');
  mainWindow.loadFile(indexPath).catch(e => log.error('loadFile failed:', e));
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('render-process-gone', (_, details) => {
    log.error('Render process gone:', details.reason, details.exitCode);
  });
  mainWindow.webContents.on('unresponsive', () => {
    log.warn('Window became unresponsive');
  });
}

app.whenReady().then(() => {
  // Migration: force closeOnLaunch=false for users who had old default=true
  // This overrides whatever is saved in the store
  store.set('closeOnLaunch', false);

  createWindow();
  setupAutoUpdater();
  setupIPC();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function setupAutoUpdater() {
  if (process.env.NODE_ENV === 'development') return;
  try {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner:    'Dovakich',
      repo:     'ycraft-github',
    });
    autoUpdater.on('checking-for-update',  () => send('updater:status', { status: 'checking' }));
    autoUpdater.on('update-available',  i  => send('updater:status', { status: 'available', version: i.version }));
    autoUpdater.on('update-not-available', () => send('updater:status', { status: 'latest' }));
    autoUpdater.on('update-downloaded',    () => send('updater:status', { status: 'ready' }));
    autoUpdater.on('error', err => {
      log.warn('AutoUpdater:', err.message);
      send('updater:status', { status: 'error', message: err.message });
    });
    autoUpdater.on('download-progress', p => send('updater:progress', {
      percent:  Math.round(p.percent),
      speed:    fmt(p.bytesPerSecond) + '/s',
      total:    fmt(p.total),
      received: fmt(p.transferred)
    }));
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 30 * 60 * 1000);
  } catch (e) {
    log.warn('AutoUpdater init failed:', e.message);
  }
}

function setupIPC() {
  const { GameLauncher }   = require('./game-launcher');
  const { ModpackManager } = require('./modpack-manager');
  const { ForgeInstaller } = require('./forge-installer');

  const gameDir   = store.get('gameDir');
  const launcher  = new GameLauncher(store, log);
  const modpack   = new ModpackManager(gameDir, MODPACK_MANIFEST_URL, log);
  const forgeInst = new ForgeInstaller(gameDir, MC_VERSION, FORGE_VERSION, log);

  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize());
  ipcMain.on('window:close',    () => mainWindow?.close());

  ipcMain.handle('settings:get',    ()         => store.store);
  ipcMain.handle('settings:set',    (_, k, v)  => { store.set(k, v); return true; });
  ipcMain.handle('settings:setAll', (_, obj)   => { Object.entries(obj).forEach(([k,v]) => store.set(k,v)); return true; });

  ipcMain.handle('dialog:browseJava', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Оберіть виконуваний файл Java',
      properties: ['openFile'],
      filters: [{ name: 'Java', extensions: ['exe', ''] }]
    });
    return r.filePaths[0] || null;
  });

  ipcMain.handle('dialog:browseGameDir', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Оберіть теку гри',
      properties: ['openDirectory', 'createDirectory']
    });
    return r.filePaths[0] || null;
  });

  ipcMain.handle('launcher:version',    () => LAUNCHER_VERSION);
  ipcMain.handle('launcher:openGameDir',  () => shell.openPath(store.get('gameDir')));
  ipcMain.handle('launcher:openModsDir',  () => {
    const modsDir = path.join(store.get('gameDir'), 'mods');
    if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
    return shell.openPath(modsDir);
  });
  ipcMain.handle('launcher:openUrl', (_, url) => shell.openExternal(url));
  ipcMain.handle('launcher:uninstall', async () => {
    const gameDir = store.get('gameDir');
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Повне видалення',
      message: 'Видалити лаунчер та всі файли гри?',
      detail: `Буде видалено:\n• Файли гри: ${gameDir}\n• Лаунчер (Y-Craft Launcher)\n\nЦю дію неможливо скасувати.`,
      buttons: ['Видалити все', 'Скасувати'],
      defaultId: 1,
      cancelId: 1
    });

    if (response !== 0) return { cancelled: true };

    try {
      // 1. Видаляємо файли гри
      if (fs.existsSync(gameDir)) {
        fs.rmSync(gameDir, { recursive: true, force: true });
      }
      store.clear();

      // 2. Запускаємо видалення лаунчера залежно від ОС
      const { exec } = require('child_process');
      const exePath = process.execPath; // шлях до .exe лаунчера

      if (process.platform === 'win32') {
        // Шукаємо uninstaller поруч з exe або в стандартних місцях
        const exeDir       = path.dirname(exePath);
        const appDir       = path.dirname(exeDir);
        const uninstallers = [
          path.join(appDir, 'Uninstall Y-Craft Launcher.exe'),
          path.join(appDir, 'uninstall.exe'),
          path.join(exeDir, 'Uninstall Y-Craft Launcher.exe'),
          path.join(exeDir, 'uninstall.exe'),
        ];
        const uninstaller = uninstallers.find(p => fs.existsSync(p));

        if (uninstaller) {
          // Запускаємо NSIS uninstaller і закриваємо лаунчер
          exec(`"${uninstaller}" /S`, (err) => {
            if (err) log.warn('Uninstaller error:', err.message);
          });
          setTimeout(() => app.quit(), 1000);
        } else {
          // Якщо uninstaller не знайдено — видаляємо файли лаунчера вручну через bat
          const appDataDir = path.join(app.getPath('appData'), 'ycraft-launcher');
          const localApp   = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'y-craft-launcher');
          const batPath    = path.join(app.getPath('temp'), 'ycraft_uninstall.bat');
          const batContent = [
            '@echo off',
            'timeout /t 2 /nobreak >nul',
            `if exist "${exeDir}" rmdir /s /q "${exeDir}"`,
            `if exist "${appDataDir}" rmdir /s /q "${appDataDir}"`,
            `if exist "${localApp}"  rmdir /s /q "${localApp}"`,
            'del "%~f0"'
          ].join('\r\n');
          fs.writeFileSync(batPath, batContent, 'utf8');
          exec(`start "" /b cmd /c "${batPath}"`);
          setTimeout(() => app.quit(), 500);
        }

      } else if (process.platform === 'darwin') {
        // macOS: переміщуємо .app у корзину
        const appBundle = path.join(path.dirname(path.dirname(path.dirname(exePath))));
        exec(`osascript -e 'tell application "Finder" to move POSIX file "${appBundle}" to trash'`);
        setTimeout(() => app.quit(), 1000);

      } else {
        // Linux: видаляємо AppImage або папку
        const appImage = process.env.APPIMAGE || exePath;
        exec(`rm -rf "${appImage}" "${path.join(app.getPath('home'), '.config', 'ycraft-launcher')}"`);
        setTimeout(() => app.quit(), 500);
      }

      return { success: true };

    } catch (e) {
      log.error('Uninstall error:', e);
      return { error: e.message };
    }
  });

  ipcMain.handle('mods:list', () => {
    const modsDir = path.join(store.get('gameDir'), 'mods');
    if (!fs.existsSync(modsDir)) return [];
    try {
      return fs.readdirSync(modsDir)
        .filter(f => f.endsWith('.jar') && !f.endsWith('.disabled'))
        .map(f => {
          const stat = fs.statSync(path.join(modsDir, f));
          return {
            filename: f,
            name:     f.replace(/[-_](\d[\d.]*)([-_]mc[\d.]*)?\.jar$/i, '').replace(/[-_]/g, ' ').trim() || f,
            size:     fmt(stat.size),
            mtime:    stat.mtime.toLocaleDateString('uk-UA')
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'uk'));
    } catch (e) {
      log.warn('mods:list error:', e.message);
      return [];
    }
  });

  ipcMain.handle('modpack:check', async () => {
    try { return await modpack.checkForUpdates(); }
    catch (e) { return { error: e.message, upToDate: true, offline: true }; }
  });

  ipcMain.handle('modpack:update', async () => {
    modpack.removeAllListeners('progress');
    modpack.removeAllListeners('status');
    modpack.on('progress', d => send('modpack:progress', d));
    modpack.on('status',   d => send('modpack:status',   d));
    try { await modpack.update(); return { success: true }; }
    catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('forge:check', () => forgeInst.isInstalled());

  ipcMain.handle('forge:install', async () => {
    forgeInst.removeAllListeners('progress');
    forgeInst.removeAllListeners('status');
    forgeInst.on('progress', d => send('forge:progress', d));
    forgeInst.on('status',   d => send('forge:status',   d));
    forgeInst.setJavaPath(store.get('javaPath') || '');
    try { await forgeInst.install(); return { success: true }; }
    catch (e) { log.error('forge:install:', e.message); return { error: e.message }; }
  });

  ipcMain.handle('game:launch', async (_, opts) => {
    launcher.removeAllListeners();

    launcher.on('stdout',  line => send('game:stdout', line));
    launcher.on('stderr',  line => send('game:stderr', line));
    launcher.on('started', ()   => send('game:started', {}));
    launcher.on('closed',  code => send('game:closed', { code }));
    launcher.on('error',   msg  => {
      log.error('[GL] game error:', msg);
      send('game:error', { message: msg });
    });

    try {
      await launcher.launch(opts);
      return { success: true };
    } catch (e) {
      log.error('game:launch threw:', e.message);
      send('game:error', { message: e.message });
      return { error: e.message };
    }
  });

  ipcMain.handle('game:kill', () => launcher.kill());

  ipcMain.on('updater:install', () => autoUpdater.quitAndInstall(false, true));
  ipcMain.handle('updater:check', () => autoUpdater.checkForUpdates().catch(e => ({ error: e.message })));
}

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function fmt(b = 0) {
  if (b < 1024)          return b + ' B';
  if (b < 1_048_576)     return (b / 1024).toFixed(1)       + ' KB';
  if (b < 1_073_741_824) return (b / 1_048_576).toFixed(1)  + ' MB';
  return (b / 1_073_741_824).toFixed(2) + ' GB';
}
