#[cfg(debug_assertions)]
mod cli_desktop_acceptance;
mod cmd;
#[cfg(target_os = "macos")]
mod macos_resize_cursor;
mod project_ownership;
pub mod project_reference_store;
#[cfg(target_os = "windows")]
mod custom_drag_drop;
mod project_runtime_bridge;

pub mod ownership_helper {
    pub use crate::project_ownership::{
        acquire_project_ownership, try_acquire_project_ownership, CanonicalProjectPath,
        ProjectOwner, ProjectOwnership, ProjectOwnershipError,
    };
}

use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Emitter, Manager, State};

#[cfg(target_os = "linux")]
use std::path::Path;

pub static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
#[derive(Default)]
struct PendingOpenFiles(Mutex<Vec<String>>);

/// 第二个实例把命令行参数转发过来后，把主窗口拉到前台。
/// Windows 上前台权限已由 single-instance 插件通过 AllowSetForegroundWindow 让渡，
/// 因此这里直接 set_focus 即可；最小化或被隐藏的窗口需要先 show/unminimize。
#[cfg(desktop)]
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 双击 .prg 文件时系统会把文件路径作为参数交给新进程。
/// 新进程已被 single-instance 插件拦下并转发参数，这里把路径还原成前端已有的
/// open-file-from-os 事件，交由前端在已运行的实例里打开标签页。
#[cfg(desktop)]
fn forward_open_files(app: &tauri::AppHandle, args: &[String]) {
    for arg in args.iter().skip(1) {
        if !arg.to_lowercase().ends_with(".prg") {
            continue;
        }
        if !std::path::Path::new(arg).exists() {
            continue;
        }
        let _ = app.emit("open-file-from-os", arg.clone());
    }
}

#[tauri::command]
fn take_pending_open_files(state: State<PendingOpenFiles>) -> Vec<String> {
    let mut guard = state.0.lock().unwrap();
    std::mem::take(&mut *guard)
}

#[tauri::command]
fn write_stdout(content: String) {
    println!("{}", content);
}

#[tauri::command]
fn write_stderr(content: String) {
    eprintln!("{}", content);
}

#[tauri::command]
fn exit(code: i32) {
    std::process::exit(code);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 在 Linux 上禁用 DMA-BUF 渲染器
    // 否则无法在 Linux 上运行
    // 相同的bug: https://github.com/tauri-apps/tauri/issues/10702
    #[cfg(target_os = "linux")]
    {
        if Path::new("/proc/driver/nvidia/gpus").exists() {
            std::env::set_var("__GL_THREADED_OPTIMIZATIONS", "0");
            std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
        }
    }

    let builder = tauri::Builder::default();

    // 单实例插件必须第一个注册：它在 setup 阶段创建具名互斥体。
    // 第二个实例（例如点击外部 prg:// 链接、双击 .prg 文件）不会再启动进程，
    // 而是把命令行参数转发给已运行实例后立即退出。
    // 开启 deep-link 特性后，转发过来的 URL 会先交给 deep-link 插件，
    // 由它触发 deep-link://new-url 事件，前端 onOpenUrl 即可跳转到对应节点。
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        focus_main_window(app);
        forward_open_files(app, &args);
    }));

    builder
        .manage(PendingOpenFiles::default())
        .manage(Arc::new(
            project_ownership::DesktopProjectOwnershipManager::default(),
        ))
        .manage(cmd::mcp::McpStdioManager::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                macos_resize_cursor::install(&window)?;
            }
            app.manage(project_runtime_bridge::ProjectRuntimeBridgeManager::start(
                app.handle().clone(),
            )?);
            #[cfg(debug_assertions)]
            {
                app.handle().plugin(tauri_plugin_devtools::init())?;
                if let Some(window) = app.handle().get_webview_window("main") {
                    let _ = window.show();
                }
            }
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_cli::init())?;
                app.handle().plugin(tauri_plugin_process::init())?;
                app.handle().plugin(tauri_plugin_system_info::init())?;
                app.handle()
                    .plugin(tauri_plugin_window_state::Builder::new().build())?;
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle()
                    .plugin(tauri_plugin_global_shortcut::Builder::new().build())?;
            }
            #[cfg(target_os = "windows")]
            custom_drag_drop::install(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            #[cfg(target_os = "macos")]
            cmd::macos_menu::style_macos_menu_icons,
            cmd::device::get_device_id,
            #[cfg(debug_assertions)]
            cli_desktop_acceptance::load_cli_desktop_acceptance_manifest,
            #[cfg(debug_assertions)]
            cli_desktop_acceptance::write_cli_desktop_acceptance_state,
            #[cfg(debug_assertions)]
            cli_desktop_acceptance::wait_for_cli_desktop_acceptance_completion,
            write_stdout,
            write_stderr,
            exit,
            take_pending_open_files,
            project_ownership::acquire_desktop_project_ownership,
            project_ownership::acquire_desktop_project_ownership_for_save,
            project_ownership::make_desktop_project_ownership_connectable,
            project_ownership::release_desktop_project_ownership,
            project_reference_store::load_project_reference_snapshot,
            project_reference_store::save_project_reference_snapshot,
            project_runtime_bridge::respond_project_runtime_bridge,
            cmd::fs::read_folder_structure,
            cmd::fs::exists,
            cmd::fs::read_folder,
            cmd::fs::read_folder_recursive,
            cmd::fs::delete_file,
            cmd::fs::read_text_file,
            cmd::fs::read_file_base64,
            cmd::fs::read_prg_metadata,
            cmd::fs::write_text_file,
            cmd::fs::write_file_base64,
            cmd::fs::create_folder,
            cmd::shell::run_command,
            cmd::device::get_distribution,
            #[cfg(desktop)]
            cmd::mcp::mcp_stdio_start,
            #[cfg(desktop)]
            cmd::mcp::mcp_stdio_list_tools,
            #[cfg(desktop)]
            cmd::mcp::mcp_stdio_call_tool,
            #[cfg(desktop)]
            cmd::mcp::mcp_stdio_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
