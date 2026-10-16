// Auto-update for the packaged app (electron-updater against the GitHub Releases of this
// repository). This module needs neither Electron nor electron-updater at load time:
// main.cjs passes the updater, the dialog and the timers in, so the logic can run against
// stand-ins. It has no IPC and never shows an error dialog unless the user asked for the
// check from the menu.
const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// `autoUpdater` is electron-updater's; `dialog` is Electron's. `getWindow` may return
// undefined (no window yet or already closed). `onReady(version)` is called when an update
// has been downloaded and waits for a restart. `appVersion` is the running version.
function createUpdater({
  autoUpdater,
  dialog,
  getWindow,
  appVersion,
  onReady,
  setTimeout,
  setInterval,
  log = console.error,
}) {
  let readyVersion = "";
  let manualCheck = null;
  const describe = (error) =>
    (error && error.message ? error.message : String(error)).split("\n")[0];
  const logError = (error) => log(`Update check failed: ${describe(error)}`);
  const notify = (options) => {
    const window = getWindow();
    const shown = window
      ? dialog.showMessageBox(window, options)
      : dialog.showMessageBox(options);
    return Promise.resolve(shown).catch(() => {});
  };

  async function checkInBackground() {
    if (readyVersion) return; // already waiting for a restart
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      logError(error);
    }
  }

  // The menu entry: the one place where a failure is shown, because the user asked.
  function checkNow() {
    manualCheck ??= (async () => {
      try {
        const result = await autoUpdater.checkForUpdates();
        if (readyVersion) {
          await notify({
            type: "info",
            message: `v${readyVersion} 업데이트를 이미 받았습니다.`,
            detail:
              "원격 메뉴의 '다시 시작해서 업데이트'로 지금 설치할 수 있습니다.",
          });
        } else if (result && result.isUpdateAvailable) {
          await notify({
            type: "info",
            message: `v${result.updateInfo.version}을(를) 내려받는 중입니다.`,
            detail:
              "다 받으면 원격 메뉴에 '다시 시작해서 업데이트'가 나타납니다. 앱을 닫을 때도 설치됩니다.",
          });
        } else if (result) {
          await notify({
            type: "info",
            message: `최신 버전입니다 (v${appVersion}).`,
          });
        } else {
          await notify({
            type: "warning",
            message: "업데이트를 확인할 수 없습니다.",
          });
        }
      } catch (error) {
        logError(error);
        await notify({
          type: "error",
          message: "업데이트를 확인하지 못했습니다.",
          detail: describe(error),
        });
      } finally {
        manualCheck = null;
      }
    })();
    return manualCheck;
  }

  // Never restarts by itself: the user may be in a remote session. Without this click the
  // update is installed when the app quits (autoInstallOnAppQuit).
  function restart() {
    if (readyVersion) autoUpdater.quitAndInstall();
  }

  function start() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // An EventEmitter throws on an 'error' event that nobody listens to.
    autoUpdater.on("error", logError);
    autoUpdater.on("update-downloaded", (info) => {
      readyVersion = String(info.version);
      onReady(readyVersion);
    });
    const first = setTimeout(checkInBackground, FIRST_CHECK_DELAY_MS);
    const every = setInterval(checkInBackground, CHECK_INTERVAL_MS);
    // A pending check must not keep a quitting process alive.
    first?.unref?.();
    every?.unref?.();
  }

  return { start, checkNow, restart };
}

module.exports = { createUpdater, FIRST_CHECK_DELAY_MS, CHECK_INTERVAL_MS };
