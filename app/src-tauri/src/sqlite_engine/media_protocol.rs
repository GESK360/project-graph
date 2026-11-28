use crate::sqlite_engine::document_actor::{DocumentActorPool, V3AttachmentMeta};
use crate::sqlite_engine::workspace_engine::WorkspaceEngine;
use image::GenericImageView;
use std::io::Cursor;
use std::sync::Arc;
use tauri::http::{Method, Request, Response, StatusCode};

pub const THUMBNAIL_MAX_DIM: u32 = 256;

/// 对光栅图片解码宽高并生成最大边 256px 的 WebP 缩略图；非光栅图（如 SVG/音视频）安全返回 `(None, None, None)`。
pub fn inspect_and_make_thumbnail(
    mime: &str,
    data: &[u8],
) -> (Option<i64>, Option<i64>, Option<Vec<u8>>) {
    let lower = mime.to_ascii_lowercase();
    if !matches!(
        lower.as_str(),
        "image/png" | "image/jpeg" | "image/jpg" | "image/webp" | "image/gif" | "image/bmp"
    ) {
        return (None, None, None);
    }

    let Ok(img) = image::load_from_memory(data) else {
        return (None, None, None);
    };
    let (w, h) = img.dimensions();
    let thumb = if w > THUMBNAIL_MAX_DIM || h > THUMBNAIL_MAX_DIM {
        img.thumbnail(THUMBNAIL_MAX_DIM, THUMBNAIL_MAX_DIM)
    } else {
        img
    };

    let mut out = Cursor::new(Vec::new());
    let thumb_bytes = match thumb.write_to(&mut out, image::ImageFormat::WebP) {
        Ok(()) => Some(out.into_inner()),
        Err(_) => None,
    };

    (Some(w as i64), Some(h as i64), thumb_bytes)
}

#[derive(Debug, PartialEq, Eq)]
pub struct ParsedMediaRequest {
    pub doc_id: String,
    pub attachment_id: String,
    pub thumb: bool,
}

/// 解析自定义协议 URI，兼容：
/// - Windows WebView2: `http://flux-media.localhost/doc/<docId>/<attId>?thumb=1`
/// - macOS / Linux:    `flux-media://localhost/doc/<docId>/<attId>?thumb=1`
/// - 直写形式:         `flux-media://doc/<docId>/<attId>?thumb=1`
pub fn parse_media_uri(uri: &tauri::http::Uri) -> Option<ParsedMediaRequest> {
    let host = uri.host().unwrap_or("");
    let raw_path = uri.path().trim_start_matches('/');
    let segments: Vec<&str> = raw_path.split('/').filter(|s| !s.is_empty()).collect();

    let (raw_doc, raw_att) = if host.eq_ignore_ascii_case("doc") {
        if segments.len() < 2 {
            return None;
        }
        (segments[0], segments[1])
    } else {
        if segments.len() < 3 || !segments[0].eq_ignore_ascii_case("doc") {
            return None;
        }
        (segments[1], segments[2])
    };

    let doc_id = percent_decode(raw_doc);
    let attachment_id = percent_decode(raw_att);
    if doc_id.is_empty() || attachment_id.is_empty() {
        return None;
    }

    let thumb = uri
        .query()
        .map(|q| {
            q.split('&').any(|pair| {
                let mut kv = pair.splitn(2, '=');
                matches!(
                    (kv.next(), kv.next()),
                    (Some("thumb"), Some("1") | Some("true"))
                )
            })
        })
        .unwrap_or(false);

    Some(ParsedMediaRequest {
        doc_id,
        attachment_id,
        thumb,
    })
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn parse_single_byte_range(header_val: &str, total_len: usize) -> Option<(usize, usize)> {
    let spec = header_val.strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (start_s, end_s) = first.split_once('-')?;
    if total_len == 0 {
        return None;
    }
    if start_s.is_empty() {
        let suffix: usize = end_s.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        let start = total_len.saturating_sub(suffix);
        return Some((start, total_len - 1));
    }
    let start: usize = start_s.parse().ok()?;
    if start >= total_len {
        return None;
    }
    let end = if end_s.is_empty() {
        total_len - 1
    } else {
        end_s.parse::<usize>().ok()?.min(total_len - 1)
    };
    if start > end {
        return None;
    }
    Some((start, end))
}

fn build_empty_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("Access-Control-Allow-Headers", "Range, Content-Type")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .body(Vec::new())
        .unwrap()
}

/// 处理 `flux-media://` 自定义 URI 协议请求，零 Base64 直出缩略图或原图/媒体流。
pub fn handle_flux_media_request(
    pool: &Arc<DocumentActorPool>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    handle_flux_media_request_with_workspace(pool, None, request)
}

/// 处理 `flux-media://` 请求，支持未打开工作空间文档经 `WorkspaceEngine` 按需懒加载入 LRU 连接池。
pub fn handle_flux_media_request_with_workspace(
    pool: &Arc<DocumentActorPool>,
    ws_engine: Option<&Arc<WorkspaceEngine>>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    if request.method() == Method::OPTIONS {
        return build_empty_response(StatusCode::NO_CONTENT);
    }

    let Some(parsed) = parse_media_uri(request.uri()) else {
        return build_empty_response(StatusCode::BAD_REQUEST);
    };

    let actor = match pool.get_by_doc_id(&parsed.doc_id) {
        Ok(Some(a)) => a,
        Ok(None) => {
            if let Some(ws) = ws_engine {
                match ws.resolve_doc_path(&parsed.doc_id) {
                    Ok(Some(path)) if path.exists() => match pool.open_for_background(&path) {
                        Ok(a) => a,
                        Err(_) => return build_empty_response(StatusCode::INTERNAL_SERVER_ERROR),
                    },
                    Ok(_) => return build_empty_response(StatusCode::NOT_FOUND),
                    Err(_) => return build_empty_response(StatusCode::INTERNAL_SERVER_ERROR),
                }
            } else {
                return build_empty_response(StatusCode::NOT_FOUND);
            }
        }
        Err(_) => return build_empty_response(StatusCode::INTERNAL_SERVER_ERROR),
    };

    let (content_type, body) = if parsed.thumb {
        let thumb_hit = {
            let guard = match actor.lock() {
                Ok(g) => g,
                Err(_) => return build_empty_response(StatusCode::INTERNAL_SERVER_ERROR),
            };
            match guard.get_attachment_thumb_only(&parsed.attachment_id) {
                Ok(Some((mime, Some(thumb)))) if !thumb.is_empty() => {
                    Some(("image/webp".to_string(), thumb, mime))
                }
                Ok(Some((_mime, _))) => None,
                Ok(None) => return build_empty_response(StatusCode::NOT_FOUND),
                Err(_) => return build_empty_response(StatusCode::INTERNAL_SERVER_ERROR),
            }
        };

        if let Some((ct, bytes, _)) = thumb_hit {
            (ct, bytes)
        } else {
            // 缩略图为空：读取原图并按需生成缩略图后回写（非光栅图回退原图）
            let stored = {
                let guard = match actor.lock() {
                    Ok(g) => g,
                    Err(_) => return build_empty_response(StatusCode::INTERNAL_SERVER_ERROR),
                };
                match guard.get_attachment(&parsed.attachment_id) {
                    Ok(Some(s)) => s,
                    Ok(None) => return build_empty_response(StatusCode::NOT_FOUND),
                    Err(_) => return build_empty_response(StatusCode::INTERNAL_SERVER_ERROR),
                }
            };
            let (_, _, maybe_thumb) = inspect_and_make_thumbnail(&stored.mime, &stored.data_blob);
            if let Some(thumb_bytes) = maybe_thumb {
                if let Ok(guard) = actor.lock() {
                    let _ = guard.update_attachment_thumb(&parsed.attachment_id, &thumb_bytes);
                }
                ("image/webp".to_string(), thumb_bytes)
            } else {
                (stored.mime, stored.data_blob)
            }
        }
    } else {
        let stored = {
            let guard = match actor.lock() {
                Ok(g) => g,
                Err(_) => return build_empty_response(StatusCode::INTERNAL_SERVER_ERROR),
            };
            match guard.get_attachment(&parsed.attachment_id) {
                Ok(Some(s)) => s,
                Ok(None) => return build_empty_response(StatusCode::NOT_FOUND),
                Err(_) => return build_empty_response(StatusCode::INTERNAL_SERVER_ERROR),
            }
        };
        (stored.mime, stored.data_blob)
    };

    let is_head = request.method() == Method::HEAD;
    let total_len = body.len();

    if let Some(range_header) = request
        .headers()
        .get("range")
        .and_then(|v| v.to_str().ok())
    {
        if let Some((start, end)) = parse_single_byte_range(range_header, total_len) {
            let slice = if is_head {
                Vec::new()
            } else {
                body[start..=end].to_vec()
            };
            let chunk_len = end - start + 1;
            return Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header("Content-Type", content_type)
                .header("Content-Length", chunk_len.to_string())
                .header(
                    "Content-Range",
                    format!("bytes {start}-{end}/{total_len}"),
                )
                .header("Accept-Ranges", "bytes")
                .header("Cache-Control", "public, max-age=31536000, immutable")
                .header("Access-Control-Allow-Origin", "*")
                .header("Cross-Origin-Resource-Policy", "cross-origin")
                .body(slice)
                .unwrap();
        } else {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header("Content-Range", format!("bytes */{total_len}"))
                .header("Access-Control-Allow-Origin", "*")
                .header("Cross-Origin-Resource-Policy", "cross-origin")
                .body(Vec::new())
                .unwrap();
        }
    }

    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", content_type)
        .header("Content-Length", total_len.to_string())
        .header("Accept-Ranges", "bytes")
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .header("Access-Control-Allow-Origin", "*")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .body(if is_head { Vec::new() } else { body })
        .unwrap()
}

/// 将二进制附件写入指定文档并自动生成缩略图。
pub fn put_attachment_into_pool(
    pool: &Arc<DocumentActorPool>,
    doc_id: &str,
    attachment_id: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<V3AttachmentMeta, String> {
    let actor = pool
        .get_by_doc_id(doc_id)?
        .ok_or_else(|| format!("未找到已打开的文档 docId={doc_id}"))?;
    let (width, height, thumb) = inspect_and_make_thumbnail(mime, bytes);
    let mut guard = actor
        .lock()
        .map_err(|_| "DocumentActor 锁中毒".to_string())?;
    guard.put_attachment(attachment_id, mime, width, height, thumb.as_deref(), bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(1);

    fn make_png_bytes(w: u32, h: u32) -> Vec<u8> {
        let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::from_fn(w, h, |x, y| Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255]));
        let mut cursor = Cursor::new(Vec::new());
        img.write_to(&mut cursor, image::ImageFormat::Png).unwrap();
        cursor.into_inner()
    }

    #[test]
    fn parses_windows_and_unix_flux_media_uris() {
        let win: tauri::http::Uri = "http://flux-media.localhost/doc/doc-1/att-2?thumb=1"
            .parse()
            .unwrap();
        assert_eq!(
            parse_media_uri(&win),
            Some(ParsedMediaRequest {
                doc_id: "doc-1".to_string(),
                attachment_id: "att-2".to_string(),
                thumb: true,
            })
        );

        let mac: tauri::http::Uri = "flux-media://localhost/doc/doc-1/att-2".parse().unwrap();
        assert_eq!(
            parse_media_uri(&mac),
            Some(ParsedMediaRequest {
                doc_id: "doc-1".to_string(),
                attachment_id: "att-2".to_string(),
                thumb: false,
            })
        );

        let direct: tauri::http::Uri = "flux-media://doc/doc-1/att-2?thumb=true"
            .parse()
            .unwrap();
        assert_eq!(
            parse_media_uri(&direct),
            Some(ParsedMediaRequest {
                doc_id: "doc-1".to_string(),
                attachment_id: "att-2".to_string(),
                thumb: true,
            })
        );
    }

    #[test]
    fn generates_webp_thumbnail_and_serves_full_thumb_and_range() {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "flux-media-proto-test-{}-{}.prg",
            std::process::id(),
            n
        ));
        let _ = std::fs::remove_file(&path);

        let pool = Arc::new(DocumentActorPool::default());
        let actor = pool.open_document(&path).unwrap();
        let doc_id = actor.lock().unwrap().doc_id.clone();

        let png = make_png_bytes(512, 256);
        let meta = put_attachment_into_pool(&pool, &doc_id, "img-1", "image/png", &png).unwrap();
        assert_eq!(meta.width, Some(512));
        assert_eq!(meta.height, Some(256));
        assert!(meta.has_thumb);

        // 缩略图请求返回 WebP
        let thumb_req = Request::builder()
            .uri(format!("http://flux-media.localhost/doc/{doc_id}/img-1?thumb=1"))
            .body(Vec::new())
            .unwrap();
        let thumb_resp = handle_flux_media_request(&pool, thumb_req);
        assert_eq!(thumb_resp.status(), StatusCode::OK);
        assert_eq!(
            thumb_resp.headers().get("Content-Type").unwrap(),
            "image/webp"
        );
        assert_eq!(
            thumb_resp.headers().get("Access-Control-Allow-Origin").unwrap(),
            "*"
        );
        assert!(thumb_resp.body().starts_with(b"RIFF"));
        assert_eq!(&thumb_resp.body()[8..12], b"WEBP");

        // 原图 Range 请求返回 206 Partial Content
        let range_req = Request::builder()
            .uri(format!("http://flux-media.localhost/doc/{doc_id}/img-1"))
            .header("Range", "bytes=0-15")
            .body(Vec::new())
            .unwrap();
        let range_resp = handle_flux_media_request(&pool, range_req);
        assert_eq!(range_resp.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(range_resp.body().len(), 16);
        assert_eq!(range_resp.body().as_slice(), &png[..16]);

        pool.release_path(&path).unwrap();
        let _ = std::fs::remove_file(&path);
    }
}
