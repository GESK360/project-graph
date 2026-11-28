use serde::{Deserialize, Serialize};
use std::io::Read;

use base64::engine::general_purpose;
use base64::Engine;

#[derive(Debug, Serialize, Deserialize)]
pub struct FolderEntry {
    name: String,
    is_file: bool,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<FolderEntry>>,
}

/// 递归读取文件夹结构，返回嵌套的文件夹结构
#[tauri::command]
pub fn read_folder_structure(path: String) -> FolderEntry {
    let path_buf = std::path::PathBuf::from(&path);
    let name = path_buf
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let mut children = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&path) {
        for entry in entries {
            if let Ok(entry) = entry {
                let path = entry.path();
                let child_name = entry.file_name().to_string_lossy().to_string();
                let path_str = path.to_string_lossy().to_string();

                if path.is_file() {
                    children.push(FolderEntry {
                        name: child_name,
                        is_file: true,
                        path: path_str,
                        children: None,
                    });
                } else if path.is_dir() {
                    children.push(read_folder_structure(path_str));
                }
            }
        }
    }

    FolderEntry {
        name,
        is_file: false,
        path,
        children: Some(children),
    }
}

/// 判断文件是否存在
#[tauri::command]
pub fn exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// 读取文件夹中的文件列表
/// 如果文件夹不存在，返回空列表
#[tauri::command]
pub fn read_folder(path: String) -> Vec<String> {
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries {
            if let Ok(entry) = entry {
                if entry.path().is_file() {
                    if let Some(file_name) = entry.file_name().to_str() {
                        files.push(file_name.to_string());
                    }
                }
            }
        }
    }
    files
}

/// 读取一个文件夹中的全部文件，递归的读取
/// 如果文件夹不存在，返回空列表
/// fileExts: 要读取的文件扩展名列表，例如：[".txt", ".md"]
#[tauri::command]
pub fn read_folder_recursive(path: String, file_exts: Vec<String>) -> Vec<String> {
    let exts: Vec<String> = file_exts.iter().map(|ext| ext.to_lowercase()).collect();
    let mut files = Vec::new();
    collect_files_recursive(&path, &exts, &mut files);
    files
}

fn collect_files_recursive(dir: &str, exts: &[String], out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        // file_type() 直接取目录项类型，避免 is_file()/is_dir() 各做一次 stat
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            if let Some(sub) = path.to_str() {
                collect_files_recursive(sub, exts, out);
            }
        } else if file_type.is_file() {
            let Some(name) = path.to_str() else { continue };
            let lower = name.to_lowercase();
            if exts.iter().any(|ext| lower.ends_with(ext)) {
                out.push(name.to_string());
            }
        }
    }
}

/// 在一批目录里找文件名匹配的 .prg，命中即停。
///
/// 深度链接按文件名提示反查时需要这个：完整递归可能扫到几万个无关文件，
/// 而只要找到一个同名 .prg 就够。命中后立刻返回，剩下的目录树不再进入。
#[tauri::command]
pub fn find_prg_by_name(roots: Vec<String>, name: String) -> Option<String> {
    let wanted = format!("{}.prg", name.to_lowercase());
    for root in roots {
        if let Some(found) = find_file_named(&root, &wanted, 0) {
            return Some(found);
        }
    }
    None
}

/// 深度上限用于避免误入极深的目录，正常工作空间远达不到
const FIND_MAX_DEPTH: usize = 16;

fn find_file_named(dir: &str, lower_file_name: &str, depth: usize) -> Option<String> {
    if depth > FIND_MAX_DEPTH {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    let mut sub_dirs: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        let Some(path_str) = path.to_str() else {
            continue;
        };
        if file_type.is_dir() {
            sub_dirs.push(path_str.to_string());
        } else if file_type.is_file() && path_str.to_lowercase().ends_with(lower_file_name) {
            return Some(path_str.to_string());
        }
    }
    // 同层先看完再进子目录，浅层命中优先
    for sub in sub_dirs {
        if let Some(found) = find_file_named(&sub, lower_file_name, depth + 1) {
            return Some(found);
        }
    }
    None
}

/// 删除文件
#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    std::fs::remove_file(path).map_err(|e| e.to_string())?;
    Ok(())
}

/// 读取文件，返回字符串
#[tauri::command]
pub fn read_text_file(path: String) -> String {
    let mut file = std::fs::File::open(path).unwrap();
    let mut contents = String::new();
    file.read_to_string(&mut contents).unwrap();
    contents
}

/// 读取文件，返回base64
#[tauri::command]
pub fn read_file_base64(path: String) -> Result<String, String> {
    Ok(general_purpose::STANDARD
        .encode(&std::fs::read(path).map_err(|e| format!("无法读取文件: {}", e))?))
}

/// 只读取 .prg 里的 metadata（兼容旧版 ZIP `metadata.msgpack` 与新版 SQLite v3.0.0 `metadata` 表），返回 base64。
///
/// 深度链接靠 docId 在文件改名后重新找回文档，需要扫描一批 .prg 的 metadata。
/// 先检测文件头魔数：SQLite v3.0.0 直接只读 `metadata` 表并组装兼容 MessagePack；
/// 旧版 ZIP 走中央目录仅读取 `metadata.msgpack` 数据区，均不触碰附件字节。
#[tauri::command]
pub fn read_prg_metadata(path: String) -> Result<String, String> {
    let path_ref = std::path::Path::new(&path);
    match crate::sqlite_engine::schema::detect_prg_format(path_ref)? {
        crate::sqlite_engine::schema::PrgFormat::V3Sqlite => {
            let data = crate::sqlite_engine::schema::read_v3_metadata_msgpack(path_ref)?;
            Ok(general_purpose::STANDARD.encode(&data))
        }
        _ => {
            let data = extract_zip_entry_stored(&path, "metadata.msgpack")?;
            Ok(general_purpose::STANDARD.encode(&data))
        }
    }
}

/// 从 zip 中取出一个「未压缩存储」条目的原始字节。
///
/// prg 保存时所有条目都是 level 0（见 Project.getFileContent），所以不需要解压，
/// 只要按中央目录找到数据区位置再读那一段，就能避开整包读取。
fn extract_zip_entry_stored(path: &str, entry_name: &str) -> Result<Vec<u8>, String> {
    use std::io::{BufReader, Read, Seek, SeekFrom};

    const MAX_ENTRY_BYTES: u64 = 1024 * 1024;

    let file = std::fs::File::open(path).map_err(|e| format!("无法读取文件: {}", e))?;
    let file_len = file
        .metadata()
        .map_err(|e| format!("无法读取文件信息: {}", e))?
        .len();
    let mut reader = BufReader::new(file);

    // 1. 从尾部找 End Of Central Directory 签名 0x06054b50（最多回退 64KB，容纳注释）
    let tail_len = file_len.min(66_000) as usize;
    let tail_start = file_len - tail_len as u64;
    let mut tail = vec![0u8; tail_len];
    reader
        .seek(SeekFrom::Start(tail_start))
        .map_err(|e| e.to_string())?;
    reader.read_exact(&mut tail).map_err(|e| e.to_string())?;

    let eocd = tail
        .windows(4)
        .rposition(|w| w == [0x50, 0x4b, 0x05, 0x06])
        .ok_or_else(|| "不是有效的 prg 文件（缺少 zip 结束记录）".to_string())?;

    let read_u16 = |bytes: &[u8], at: usize| -> u16 {
        u16::from_le_bytes([bytes[at], bytes[at + 1]])
    };
    let read_u32 = |bytes: &[u8], at: usize| -> u32 {
        u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
    };

    let entry_count = read_u16(&tail, eocd + 10) as usize;
    let cd_size = read_u32(&tail, eocd + 12) as u64;
    let cd_offset = read_u32(&tail, eocd + 16) as u64;

    // 2. 读中央目录，按文件名找 metadata.msgpack 的本地头偏移
    if cd_size == 0 || cd_size > 64 * 1024 * 1024 {
        return Err("prg 文件中央目录异常".to_string());
    }
    let mut cd = vec![0u8; cd_size as usize];
    reader
        .seek(SeekFrom::Start(cd_offset))
        .map_err(|e| e.to_string())?;
    reader.read_exact(&mut cd).map_err(|e| e.to_string())?;

    let mut cursor = 0usize;
    let mut local_header_offset: Option<u64> = None;
    let mut compressed_size_out = 0u32;
    let mut compressed_method = 0u16;
    for _ in 0..entry_count {
        if cursor + 46 > cd.len() || read_u32(&cd, cursor) != 0x0201_4b50 {
            break;
        }
        compressed_method = read_u16(&cd, cursor + 10);
        let compressed_size = read_u32(&cd, cursor + 20);
        let name_len = read_u16(&cd, cursor + 28) as usize;
        let extra_len = read_u16(&cd, cursor + 30) as usize;
        let comment_len = read_u16(&cd, cursor + 32) as usize;
        let local_offset = read_u32(&cd, cursor + 42);
        let name_start = cursor + 46;
        if name_start + name_len > cd.len() {
            break;
        }
        let name = String::from_utf8_lossy(&cd[name_start..name_start + name_len]).to_string();
        if name == entry_name {
            local_header_offset = Some(local_offset as u64);
            compressed_size_out = compressed_size;
            break;
        }
        cursor = name_start + name_len + extra_len + comment_len;
    }

    let local_offset =
        local_header_offset.ok_or_else(|| format!("prg 文件缺少 {}", entry_name))?;

    // 3. 读本地头，跳过文件名与扩展区，只取数据区
    let mut header = vec![0u8; 30];
    reader
        .seek(SeekFrom::Start(local_offset))
        .map_err(|e| e.to_string())?;
    reader.read_exact(&mut header).map_err(|e| e.to_string())?;
    let local_name_len = read_u16(&header, 26) as usize;
    let local_extra_len = read_u16(&header, 28) as usize;
    let data_start = local_offset + 30 + local_name_len as u64 + local_extra_len as u64;

    let size = compressed_size_out as u64;
    if size == 0 || size > MAX_ENTRY_BYTES {
        return Err(format!("{} 尺寸异常", entry_name));
    }
    let mut data = vec![0u8; size as usize];
    reader
        .seek(SeekFrom::Start(data_start))
        .map_err(|e| e.to_string())?;
    reader.read_exact(&mut data).map_err(|e| e.to_string())?;

    // prg 里所有内容都以 level 0 存储（见 Project.getFileContent），即 STORED
    if compressed_method != 0 {
        return Err(format!("{} 不是未压缩存储，无法快速读取", entry_name));
    }

    Ok(data)
}

/// 写入文件
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| e.to_string())?;
    Ok(())
}

/// 写入文件，base64字符串
#[tauri::command]
pub fn write_file_base64(content: String, path: String) -> Result<(), String> {
    // 解码 Base64 内容
    let decoded_content = general_purpose::STANDARD
        .decode(content)
        .map_err(|e| format!("解码失败: {}", e))?;

    // 写入文件
    std::fs::write(&path, decoded_content).map_err(|e| {
        eprintln!("写入文件失败: {}", e);
        e.to_string()
    })?;

    Ok(())
}

/// 创建文件夹
/// 如果创建成功，则返回true，如果创建失败则返回false
#[tauri::command]
pub fn create_folder(path: String) -> bool {
    std::fs::create_dir_all(&path).is_ok()
}

#[cfg(test)]
mod tests {
    use super::extract_zip_entry_stored;

    /// 手写一个「全部 STORED」的最小 zip，用来验证只读中央目录那一段的逻辑。
    /// 不引第三方打 zip 依赖，保证这个单测只覆盖我们自己的解析代码。
    fn build_stored_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut directory = Vec::new();

        for (name, body) in entries {
            let local_offset = out.len() as u32;
            let name_bytes = name.as_bytes();
            let crc = crc32(body);

            // local file header
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&20u16.to_le_bytes()); // version needed
            out.extend_from_slice(&0u16.to_le_bytes()); // flags
            out.extend_from_slice(&0u16.to_le_bytes()); // method = STORED
            out.extend_from_slice(&0u16.to_le_bytes()); // mod time
            out.extend_from_slice(&0u16.to_le_bytes()); // mod date
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&(body.len() as u32).to_le_bytes()); // compressed
            out.extend_from_slice(&(body.len() as u32).to_le_bytes()); // uncompressed
            out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // extra len
            out.extend_from_slice(name_bytes);
            out.extend_from_slice(body);

            // central directory record
            directory.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            directory.extend_from_slice(&20u16.to_le_bytes()); // version made by
            directory.extend_from_slice(&20u16.to_le_bytes()); // version needed
            directory.extend_from_slice(&0u16.to_le_bytes()); // flags
            directory.extend_from_slice(&0u16.to_le_bytes()); // method = STORED
            directory.extend_from_slice(&0u16.to_le_bytes()); // mod time
            directory.extend_from_slice(&0u16.to_le_bytes()); // mod date
            directory.extend_from_slice(&crc.to_le_bytes());
            directory.extend_from_slice(&(body.len() as u32).to_le_bytes());
            directory.extend_from_slice(&(body.len() as u32).to_le_bytes());
            directory.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            directory.extend_from_slice(&0u16.to_le_bytes()); // extra len
            directory.extend_from_slice(&0u16.to_le_bytes()); // comment len
            directory.extend_from_slice(&0u16.to_le_bytes()); // disk number
            directory.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
            directory.extend_from_slice(&0u32.to_le_bytes()); // external attrs
            directory.extend_from_slice(&local_offset.to_le_bytes());
            directory.extend_from_slice(name_bytes);
        }

        let cd_offset = out.len() as u32;
        let cd_size = directory.len() as u32;
        out.extend_from_slice(&directory);

        // end of central directory
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // disk
        out.extend_from_slice(&0u16.to_le_bytes()); // cd disk
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&cd_size.to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // comment len

        out
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for byte in data {
            crc ^= *byte as u32;
            for _ in 0..8 {
                let mask = (crc & 1).wrapping_neg();
                crc = (crc >> 1) ^ (0xedb8_8320 & mask);
            }
        }
        !crc
    }

    fn temp_file(bytes: &[u8], tag: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "flux-graph-zip-test-{}-{}.prg",
            std::process::id(),
            tag
        ));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn reads_requested_entry_without_touching_others() {
        let zip = build_stored_zip(&[
            ("stage.msgpack", &[1u8, 2, 3, 4, 5]),
            ("metadata.msgpack", b"hello-metadata"),
            ("thumbnail.png", &[9u8; 4096]),
        ]);
        let path = temp_file(&zip, "one");
        let data = extract_zip_entry_stored(path.to_str().unwrap(), "metadata.msgpack").unwrap();
        assert_eq!(data, b"hello-metadata");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn reads_entry_that_is_not_first() {
        let zip = build_stored_zip(&[
            ("a.png", &[7u8; 2048]),
            ("b.png", &[8u8; 2048]),
            ("metadata.msgpack", b"second-last"),
        ]);
        let path = temp_file(&zip, "two");
        let data = extract_zip_entry_stored(path.to_str().unwrap(), "metadata.msgpack").unwrap();
        assert_eq!(data, b"second-last");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn reports_missing_entry() {
        let zip = build_stored_zip(&[("stage.msgpack", &[1u8, 2, 3])]);
        let path = temp_file(&zip, "three");
        let error = extract_zip_entry_stored(path.to_str().unwrap(), "metadata.msgpack").unwrap_err();
        assert!(error.contains("metadata.msgpack"), "unexpected error: {error}");
        let _ = std::fs::remove_file(path);
    }

    fn make_tree(tag: &str, layout: &[(&str, &[u8])]) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "flux-graph-tree-{}-{}",
            std::process::id(),
            tag
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        for (relative, body) in layout {
            let path = root.join(relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(path, body).unwrap();
        }
        root
    }

    #[test]
    fn finds_page_by_name_in_nested_folder() {
        let root = make_tree(
            "find-nested",
            &[
                ("top.txt", b"x"),
                ("deep/nested/target.prg", b"hit"),
                ("deep/other.prg", b"miss"),
            ],
        );
        let found = super::find_prg_by_name(
            vec![root.to_string_lossy().to_string()],
            "target".to_string(),
        );
        let found = found.expect("should find target.prg").replace('\\', "/");
        assert!(found.ends_with("deep/nested/target.prg"), "unexpected path: {found}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn find_by_name_distinguishes_similar_names() {
        let root = make_tree(
            "find-similar",
            &[("a.prg", b"1"), ("ab.prg", b"2"), ("sub/abc.prg", b"3")],
        );
        let found = super::find_prg_by_name(vec![root.to_string_lossy().to_string()], "ab".to_string());
        let found = found.expect("should find ab.prg").replace('\\', "/");
        assert!(found.ends_with("/ab.prg"), "must not match a.prg or abc.prg: {found}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn find_by_name_prefers_shallow_match() {
        let root = make_tree(
            "find-shallow",
            &[
                ("target.prg", b"shallow"),
                ("a/b/c/d/e/target.prg", b"deep"),
            ],
        );
        let found = super::find_prg_by_name(vec![root.to_string_lossy().to_string()], "target".to_string());
        let found = found.expect("should find target.prg").replace('\\', "/");
        assert!(found.ends_with("/target.prg"), "unexpected path: {found}");
        assert!(!found.contains("/a/b/c/d/e/"), "should stop at the shallow match: {found}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn find_by_name_returns_none_when_absent() {
        let root = make_tree("find-missing", &[("only.prg", b"1")]);
        assert!(super::find_prg_by_name(vec![root.to_string_lossy().to_string()], "nope".to_string()).is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recursive_list_filters_by_extension_case_insensitively() {
        let root = make_tree(
            "list-exts",
            &[("a.prg", b"1"), ("b.PRG", b"2"), ("c.txt", b"3"), ("sub/d.prg", b"4")],
        );
        let mut files = super::read_folder_recursive(root.to_string_lossy().to_string(), vec![".prg".to_string()]);
        files.sort();
        assert_eq!(files.len(), 3, "should pick a.prg, b.PRG, sub/d.prg");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_non_zip_file() {
        let path = temp_file(b"this is definitely not a zip file", "four");
        let error = extract_zip_entry_stored(path.to_str().unwrap(), "metadata.msgpack").unwrap_err();
        assert!(!error.is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_prg_metadata_supports_both_v2_zip_and_v3_sqlite() {
        use base64::Engine;

        // 1. V2 ZIP
        let zip = build_stored_zip(&[("metadata.msgpack", b"zip-meta")]);
        let zip_path = temp_file(&zip, "dual-zip");
        let b64 = super::read_prg_metadata(zip_path.to_string_lossy().to_string()).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD.decode(&b64).unwrap();
        assert_eq!(decoded, b"zip-meta");
        let _ = std::fs::remove_file(&zip_path);

        // 2. V3 SQLite
        let sql_path = std::env::temp_dir().join(format!(
            "flux-graph-dual-v3-{}.prg",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&sql_path);
        {
            let conn = rusqlite::Connection::open(&sql_path).unwrap();
            crate::sqlite_engine::schema::initialize_v3_schema(&conn).unwrap();
            conn.execute(
                "INSERT INTO metadata (key, value) VALUES ('format_version', '3.0.0'), ('docId', 'dual-v3-doc')",
                [],
            )
            .unwrap();
            crate::sqlite_engine::schema::wal_checkpoint_truncate(&conn).unwrap();
        }
        let b64_v3 = super::read_prg_metadata(sql_path.to_string_lossy().to_string()).unwrap();
        let decoded_v3 = base64::engine::general_purpose::STANDARD
            .decode(&b64_v3)
            .unwrap();
        let as_str = String::from_utf8_lossy(&decoded_v3);
        assert!(as_str.contains("3.0.0"));
        assert!(as_str.contains("dual-v3-doc"));
        let _ = std::fs::remove_file(&sql_path);
    }
}

