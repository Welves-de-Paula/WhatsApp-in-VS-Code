import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export function getStoragePath(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA!, 'whatsapp-vscode');
  }

  try {
    const release = execSync('uname -r').toString().toLowerCase();
    const isWSL = release.includes('microsoft') || release.includes('wsl');

    if (isWSL) {
      const winAppData = execSync('cmd.exe /c "<nul set /p=%APPDATA%"').toString().trim();
      const wslPath = execSync(`wslpath '${winAppData}'`).toString().trim();
      return path.join(wslPath, 'whatsapp-vscode');
    }
  } catch { }

  return path.join(process.env.HOME || '/home', '.config', 'whatsapp-vscode');
}

export function getAccountsFilePath(): string {
  return path.join(getStoragePath(), 'accounts.json');
}

export function ensureStorageExists(): void {
  const storagePath = getStoragePath();
  if (!fs.existsSync(storagePath)) {
    fs.mkdirSync(storagePath, { recursive: true });
  }
}

export function isWsl(): boolean {
  if (process.platform !== 'win32') {
    try {
      const release = execSync('uname -r').toString().toLowerCase();
      return release.includes('microsoft') || release.includes('wsl');
    } catch {
      return false;
    }
  }
  return false;
}

export function isWindowsPathAccessible(): boolean {
  if (!isWsl()) return false;
  try {
    const winPath = execSync('cmd.exe /c "<nul set /p=%APPDATA%"').toString().trim();
    const wslPath = execSync(`wslpath '${winPath}'`).toString().trim();
    return fs.existsSync(wslPath);
  } catch {
    return false;
  }
}

export function getTempSessionPath(nickname: string): string {
  return path.join('/tmp', 'whatsapp-vscode', nickname);
}

export async function copySessionFromWindowsToTemp(nickname: string): Promise<boolean> {
  if (!isWsl() || !isWindowsPathAccessible()) return false;

  try {
    const winStorage = path.join(
      execSync('cmd.exe /c "<nul set /p=%APPDATA%"').toString().trim(),
      'whatsapp-vscode',
    );
    const wslWinStorage = execSync(`wslpath '${winStorage}'`).toString().trim();
    const sessionDir = path.join(wslWinStorage, '.wwebjs_auth', `session-${nickname}`);
    const tempDir = getTempSessionPath(nickname);

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    if (fs.existsSync(sessionDir)) {
      await copyDirectory(sessionDir, tempDir);
    }
    return true;
  } catch {
    return false;
  }
}

export async function copySessionFromTempToWindows(nickname: string): Promise<boolean> {
  if (!isWsl() || !isWindowsPathAccessible()) return false;

  try {
    const winStorage = execSync('cmd.exe /c "<nul set /p=%APPDATA%"').toString().trim();
    const wslWinStorage = execSync(`wslpath '${winStorage}'`).toString().trim();
    const destDir = path.join(wslWinStorage, '.wwebjs_auth', `session-${nickname}`);
    const tempDir = getTempSessionPath(nickname);

    if (fs.existsSync(tempDir)) {
      await copyDirectory(tempDir, destDir);
    }
    return true;
  } catch {
    return false;
  }
}

async function copyDirectory(src: string, dest: string): Promise<void> {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}