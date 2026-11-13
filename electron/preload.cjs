const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopStudio', {
  isDesktop: true,
  chooseVideo: () => ipcRenderer.invoke('studio:choose-video'),
  probeVideo: sourcePath => ipcRenderer.invoke('studio:probe-video', { sourcePath }),
  exportBroadcast: payload => ipcRenderer.invoke('studio:export-broadcast', payload),
  cancelExport: jobId => ipcRenderer.invoke('studio:cancel-export', { jobId }),
  onExportProgress: callback => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on('studio:export-progress', listener);
    return () => ipcRenderer.removeListener('studio:export-progress', listener);
  }
});
