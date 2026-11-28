import { net } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { emitIpcEvent } from './windows';
import { mainWindow } from './windows/main';

interface DownloadState {
  downloadId: string;
  filePath: string;
  totalBytes: number;
  downloadedBytes: number;
  cancelled: boolean;
}

let currentDownload: DownloadState | null = null;
let cancelCurrentDownload: (() => void) | null = null;

/**
 * Get the platform-specific Ollama download URL
 */
function getOllamaDownloadUrl(): { url: string; filename: string } {
  const platform = process.platform;
  const arch = process.arch;
  
  if (platform === 'darwin') {
    // universal image: Intel and Apple silicon
    return {
      url: 'https://ollama.com/download/Ollama.dmg',
      filename: 'Ollama.dmg'
    };
  } else if (platform === 'win32') {
    // one installer for x64 and arm64
    return {
      url: 'https://ollama.com/download/OllamaSetup.exe',
      filename: 'OllamaSetup.exe'
    };
  } else if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
    // Ollama publishes no single installable file for Linux, only per-architecture
    // archives (ollama-linux-amd64.tar.zst, ollama-linux-arm64.tar.zst). Its installer
    // is this script, which picks the archive matching the machine it runs on.
    return {
      url: 'https://ollama.com/install.sh',
      filename: 'ollama-install.sh'
    };
  } else {
    throw new Error(`Ollama does not provide an installer for ${platform} ${arch}`);
  }
}

/**
 * Start downloading Ollama
 */
export function startDownload(targetDirectory: string): string {
  if (currentDownload) {
    throw new Error('Download already in progress');
  }

  const { url, filename } = getOllamaDownloadUrl();
  const downloadId = Date.now().toString();
  const filePath = path.join(targetDirectory, filename);

  // the handlers below only use this object: once this download is over,
  // the module state may already belong to the next one
  const download: DownloadState = {
    downloadId,
    filePath,
    totalBytes: 0,
    downloadedBytes: 0,
    cancelled: false
  };
  currentDownload = download;

  // Start the download
  const request = net.request(url);
  let writeStream: fs.WriteStream | null = null;
  let finished = false;

  const finish = () => {
    finished = true;
    if (currentDownload === download) {
      currentDownload = null;
      cancelCurrentDownload = null;
    }
  };

  // stops the transfer and deletes the partial file
  const discard = () => {
    finish();
    request.abort();
    if (!writeStream) return;

    // only once the stream has released the file: Windows cannot delete an open file
    writeStream.once('close', () => {
      // the next download may already be writing to the same path
      if (currentDownload?.filePath === filePath) return;
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error('Error cleaning up partial download:', error);
        }
      }
    });
    writeStream.destroy();
  };

  const fail = (error: string) => {
    if (finished) return;
    discard();
    if (mainWindow) {
      emitIpcEvent(mainWindow, 'ollama-download-error', {
        downloadId: downloadId,
        error: error
      });
    }
  };

  cancelCurrentDownload = () => {
    download.cancelled = true;
    discard();
  };
  
  request.on('response', (response) => {

    if (finished) return;

    // an error page is not an installer
    if (!(response.statusCode >= 200 && response.statusCode < 300)) {
      fail(`HTTP ${response.statusCode}`);
      return;
    }

    const contentLength = response.headers['content-length'];
    if (contentLength && typeof contentLength === 'string') {
      download.totalBytes = parseInt(contentLength, 10);
    }

    const stream = writeStream = fs.createWriteStream(filePath);
    
    response.on('data', (chunk) => {

      if (finished) return;

      stream.write(chunk);
      download.downloadedBytes += chunk.length;
      
      // Send progress update
      const progress = download.totalBytes > 0 
        ? (download.downloadedBytes / download.totalBytes) * 100 
        : 0;
      
      if (mainWindow) {
        emitIpcEvent(mainWindow, 'ollama-download-progress', {
          downloadId: download.downloadId,
          progress: Math.round(progress),
          downloadedBytes: download.downloadedBytes,
          totalBytes: download.totalBytes
        });
      }
    });

    response.on('end', () => {

      if (finished) return;

      finish();
      stream.close();

      // Download completed successfully
      if (mainWindow) {
        emitIpcEvent(mainWindow, 'ollama-download-complete', {
          downloadId: download.downloadId,
          filePath: download.filePath
        });
      }
    });

    response.on('error', (error) => {
      fail(error.message);
    });
  });

  request.on('error', (error) => {
    fail(error.message);
  });

  request.end();
  
  return downloadId;
}

/**
 * Cancel the current download
 */
export function cancelDownload(): boolean {
  if (!currentDownload) {
    return false;
  }

  cancelCurrentDownload?.();
  return true;
}

/**
 * Open the downloaded file in the file explorer
 */
export function openInFileExplorer(filePath: string): void {
  const platform = process.platform;
  const directory = path.dirname(filePath);

  if (platform === 'darwin') {
    // On macOS, open Finder and select the file
    spawn('open', ['-R', filePath]);
  } else if (platform === 'win32') {
    // On Windows, open Explorer and select the file
    spawn('explorer', ['/select,', filePath]);
  } else {
    // On Linux, open the directory
    spawn('xdg-open', [directory]);
  }
}

/**
 * Get current download status
 */
export function getDownloadStatus(): DownloadState | null {
  return currentDownload;
}
