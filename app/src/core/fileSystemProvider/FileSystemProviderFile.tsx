import { FileStatInfo, FileSystemProvider } from "@/core/interfaces/Service";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { exists, mkdir, readDir, readFile, remove, rename, stat, writeFile } from "@tauri-apps/plugin-fs";
import { URI } from "vscode-uri";

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export class FileSystemProviderFile implements FileSystemProvider {
  async read(uri: URI) {
    return await readFile(uri.fsPath);
  }
  async readDir(uri: URI) {
    return await readDir(uri.fsPath);
  }
  async write(uri: URI, content: Uint8Array) {
    if (isTauri()) {
      await invoke("write_project_file_atomic", content, {
        headers: {
          "x-file-path-b64": utf8ToBase64(uri.fsPath),
        },
      });
      return;
    }
    return await writeFile(uri.fsPath, content);
  }
  async remove(uri: URI) {
    return await remove(uri.fsPath, {
      recursive: true,
    });
  }
  async exists(uri: URI) {
    return await exists(uri.fsPath);
  }
  async mkdir(uri: URI) {
    return await mkdir(uri.fsPath);
  }
  async rename(oldUri: URI, newUri: URI) {
    return await rename(oldUri.fsPath, newUri.fsPath);
  }
  async stat(uri: URI): Promise<FileStatInfo | undefined> {
    try {
      const info = await stat(uri.fsPath);
      return {
        createdAt: info.birthtime ? info.birthtime.getTime() : undefined,
        modifiedAt: info.mtime ? info.mtime.getTime() : undefined,
      };
    } catch {
      return undefined;
    }
  }
}
