import { Uint8ArrayReader, ZipReader } from "@zip.js/zip.js";
import { URI } from "vscode-uri";
import { Project } from "./Project";
import { Extension } from "./extension/Extension";
import { FileSystemProvider } from "./interfaces/Service";
import { DocClient } from "./sqlite/DocClient";

export namespace TabFactory {
  export async function create(uri: URI, fs: FileSystemProvider): Promise<Project | Extension> {
    // SQLite v3.0.0 `.prg` 只需探测前 16 字节魔数即可直接实例化 Project，避免整包读盘与 ZipReader 报错
    if (uri.scheme === "file" && DocClient.isAvailable()) {
      try {
        const format = await DocClient.detectFormat(uri.fsPath);
        if (format === "v3_sqlite") {
          return new Project(uri);
        }
      } catch {
        // 文件尚不存在或无法探测时回退默认分支
      }
    }

    const content = await fs.read(uri);
    const reader = new ZipReader(new Uint8ArrayReader(content));
    const entries = await reader.getEntries();
    const filenames = entries.map((e) => e.filename);

    if (filenames.includes("stage.msgpack")) {
      return new Project(uri);
    } else if (filenames.includes("extension.js")) {
      return new Extension(uri);
    }

    // 默认为 Project 以保持兼容性，或者抛出错误
    return new Project(uri);
  }
}
