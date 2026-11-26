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
mod window_manager;

pub mod ownership_helper {
    pub use crate::project_ownership::{
        acquire_project_ownership, try_acquire_project_ownership, CanonicalProjectPath,
        ProjectOwner, ProjectOwnership, ProjectOwnershipError,
    };
}

use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Manager, State, WindowEvent};

#[cfg(target_os = "linux")]
use std::path::Path;

pub static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
#[derive(Default)]
struct PendingOpenFiles(Mutex<Vec<String>>);

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
    // 转发后的深链接与文件打开事件不再全窗口广播，而是定向投递到最后获得焦点的窗口。
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        window_manager::route_single_instance_args(app, &args);
    }));

    let ownership_manager = Arc::new(project_ownership::DesktopProjectOwnershipManager::default());
    let window_manager_state = Arc::new(window_manager::WindowManagerState::default());

    let app = builder
        .manage(PendingOpenFiles::default())
        .manage(Arc::clone(&ownership_manager))
        .manage(Arc::clone(&window_manager_state))
        .manage(cmd::mcp::McpStdioManager::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_window_event(|window, event| {
            let app = window.app_handle();
            let wm = app.state::<Arc<window_manager::WindowManagerState>>();
            match event {
                WindowEvent::Focused(true) => {
                    wm.record_focus(window.label());
                }
                WindowEvent::Destroyed => {
                    let ownership =
                        app.state::<Arc<project_ownership::DesktopProjectOwnershipManager>>();
                    wm.on_window_destroyed(app, ownership.inner(), window.label());
                }
                _ => {}
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                macos_resize_cursor::install(&window)?;
            }
            let ownership =
                Arc::clone(app.state::<Arc<project_ownership::DesktopProjectOwnershipManager>>().inner());
            app.manage(project_runtime_bridge::ProjectRuntimeBridgeManager::start(
                app.handle().clone(),
                ownership,
            )?);
            #[cfg(debug_assertions)]
            {
                if let Some(window) = app.handle().get_webview_window("main") {
                    let _ = window.show();
                }
            }
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_cli::init())?;
                app.handle().plugin(tauri_plugin_process::init())?;
                app.handle().plugin(tauri_plugin_system_info::init())?;
                app.handle().plugin(
                    tauri_plugin_window_state::Builder::new()
                        .with_filter(|label| label == "main")
                        .build(),
                )?;
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
            project_ownership::get_desktop_project_holder_count,
            window_manager::create_new_window,
            window_manager::take_window_init_payload,
            window_manager::activate_window_routing,
            window_manager::get_window_role,
            window_manager::focus_last_active_window,
            window_manager::focus_window_by_label,
            window_manager::list_open_windows,
            window_manager::broadcast_document_patch,
            window_manager::broadcast_document_saved,
            window_manager::request_peer_document_snapshot,
            window_manager::respond_peer_document_snapshot,
            window_manager::coordinate_workspace_action,
            window_manager::respond_workspace_action,
            window_manager::broadcast_workspace_event,
            window_manager::write_project_file_atomic,
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
            cmd::fs::find_prg_by_name,
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, _event| {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = _event {
            let url_strings: Vec<String> = urls.into_iter().map(|u| u.to_string()).collect();
            window_manager::route_opened_urls(_app_handle, url_strings);
        }
    });
}
