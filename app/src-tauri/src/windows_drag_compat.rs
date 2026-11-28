use std::{
    cell::Cell,
    collections::HashSet,
    sync::{Mutex, OnceLock},
    time::Instant,
};

use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    UI::{
        Input::KeyboardAndMouse::ReleaseCapture,
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            GetCursorPos, GetWindowRect, IsIconic, IsZoomed, KillTimer, PostMessageW, SetTimer,
            HTCAPTION, SET_WINDOW_POS_FLAGS, SWP_DRAWFRAME, SWP_FRAMECHANGED, SWP_HIDEWINDOW,
            SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, WINDOWPOS,
            WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_LBUTTONUP, WM_MOVE, WM_MOVING, WM_NCDESTROY,
            WM_NCLBUTTONDOWN, WM_SIZE, WM_TIMER, WM_WINDOWPOSCHANGED,
        },
    },
};

const DRAG_COMPAT_SUBCLASS_ID: usize = 0x4647_4452; // "FGDR"
const SETTLE_TIMER_ID: usize = 0x4647_5431; // "FGT1"
const SETTLE_DELAY_MS: u32 = 80;
const MOVE_BURST_WINDOW_MS: u128 = 160;

static CUSTOM_DRAG_HWNDS: OnceLock<Mutex<HashSet<isize>>> = OnceLock::new();

fn custom_drag_hwnds() -> &'static Mutex<HashSet<isize>> {
    CUSTOM_DRAG_HWNDS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn mark_custom_drag_started(hwnd: HWND) {
    if let Ok(mut guard) = custom_drag_hwnds().lock() {
        guard.insert(hwnd.0 as isize);
    }
}

fn take_custom_drag_started(hwnd: HWND) -> bool {
    custom_drag_hwnds()
        .lock()
        .ok()
        .map(|mut guard| guard.remove(&(hwnd.0 as isize)))
        .unwrap_or(false)
}

#[inline]
pub(crate) fn pack_points_lparam(x: i32, y: i32) -> LPARAM {
    let lx = (x as i16) as u16 as usize;
    let ly = (y as i16) as u16 as usize;
    LPARAM(((ly << 16) | lx) as isize)
}

/// 纯位置移动判定结果（供单元测试与 Win32 子类共用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowPosDecision {
    /// 非纯位置变动（含尺寸变动、显示/隐藏、边框变化等），必须立即透传给 DefSubclassProc。
    PassThrough,
    /// 位置与尺寸均未改变（例如外部工具仅刷新 Z-Order），可直接返回 0 避免无意义事件风暴。
    NoOpSwallow,
    /// 纯位置移动：合并延迟至拖动结束或 80ms 稳定计时器后一次性同步，避免阻塞 TidyTabs/SetWindowPos 与 WebView2 COM IPC。
    CoalesceMove,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct WindowPosCheckInput {
    pub x: i32,
    pub y: i32,
    pub cx: i32,
    pub cy: i32,
    pub flags: u32,
    pub last_pos: Option<(i32, i32)>,
    pub last_outer_size: Option<(i32, i32)>,
    pub is_minimized: bool,
    pub is_maximized: bool,
}

pub(crate) fn classify_windowpos_changed(input: WindowPosCheckInput) -> WindowPosDecision {
    if input.is_minimized || input.is_maximized {
        return WindowPosDecision::PassThrough;
    }
    let has_state_flags = (input.flags
        & (SWP_SHOWWINDOW.0 | SWP_HIDEWINDOW.0 | SWP_FRAMECHANGED.0 | SWP_DRAWFRAME.0))
        != 0;
    if has_state_flags {
        return WindowPosDecision::PassThrough;
    }

    let is_no_move = (input.flags & SWP_NOMOVE.0) != 0;
    let is_no_size = (input.flags & SWP_NOSIZE.0) != 0;
    let size_unchanged = is_no_size
        || (input.cx > 0
            && input.cy > 0
            && input.last_outer_size == Some((input.cx, input.cy)));

    if !size_unchanged {
        return WindowPosDecision::PassThrough;
    }

    if is_no_move {
        return WindowPosDecision::PassThrough;
    }

    if input.last_pos == Some((input.x, input.y)) {
        return WindowPosDecision::NoOpSwallow;
    }

    WindowPosDecision::CoalesceMove
}

/// 全部可变字段均采用 `Cell`（仅在 Win32 UI 主线程访问），确保 Win32 消息重入（如 `DefSubclassProc` 触发 `WM_MOVE`）时零可变别名 UB。
struct SubclassState {
    app: AppHandle,
    window_label: String,
    in_size_move: Cell<bool>,
    bypass_throttle: Cell<bool>,
    pending_move: Cell<bool>,
    frontend_moving_notified: Cell<bool>,
    consecutive_moves: Cell<u32>,
    last_move_instant: Cell<Option<Instant>>,
    last_pos: Cell<Option<(i32, i32)>>,
    last_outer_size: Cell<Option<(i32, i32)>>,
}

impl SubclassState {
    fn emit_moving_state(&self, moving: bool) {
        if self.frontend_moving_notified.get() == moving {
            return;
        }
        self.frontend_moving_notified.set(moving);
        let _ = self
            .app
            .emit_to(&self.window_label, "pg-window-moving", moving);
    }

    fn sync_rect_from_hwnd(&self, hwnd: HWND) {
        let mut rect = RECT::default();
        if unsafe { GetWindowRect(hwnd, &mut rect) }.is_ok() {
            let w = rect.right - rect.left;
            let h = rect.bottom - rect.top;
            if w > 0 && h > 0 {
                self.last_pos.set(Some((rect.left, rect.top)));
                self.last_outer_size.set(Some((w, h)));
            }
        }
    }

    unsafe fn flush_pending_move(&self, hwnd: HWND) {
        if !self.pending_move.replace(false) {
            return;
        }
        self.consecutive_moves.set(0);

        let mut rect = RECT::default();
        let (x, y, cx, cy) = if GetWindowRect(hwnd, &mut rect).is_ok() {
            let w = rect.right - rect.left;
            let h = rect.bottom - rect.top;
            self.last_pos.set(Some((rect.left, rect.top)));
            if w > 0 && h > 0 {
                self.last_outer_size.set(Some((w, h)));
            }
            (rect.left, rect.top, w, h)
        } else if let Some((lx, ly)) = self.last_pos.get() {
            let (lw, lh) = self.last_outer_size.get().unwrap_or((0, 0));
            (lx, ly, lw, lh)
        } else {
            return;
        };

        let mut wp = WINDOWPOS {
            hwnd,
            hwndInsertAfter: HWND::default(),
            x,
            y,
            cx,
            cy,
            flags: SET_WINDOW_POS_FLAGS(SWP_NOSIZE.0 | SWP_NOZORDER.0 | SWP_NOACTIVATE.0),
        };

        self.bypass_throttle.set(true);
        let _ = DefSubclassProc(
            hwnd,
            WM_WINDOWPOSCHANGED,
            WPARAM(0),
            LPARAM(&mut wp as *mut WINDOWPOS as isize),
        );
        self.bypass_throttle.set(false);
    }
}

unsafe extern "system" fn drag_compat_subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _uid_subclass: usize,
    dw_ref_data: usize,
) -> LRESULT {
    if dw_ref_data == 0 {
        return DefSubclassProc(hwnd, msg, wparam, lparam);
    }
    let state = &*(dw_ref_data as *const SubclassState);

    match msg {
        WM_ENTERSIZEMOVE => {
            state.in_size_move.set(true);
            state.sync_rect_from_hwnd(hwnd);
            state.emit_moving_state(true);
            return DefSubclassProc(hwnd, msg, wparam, lparam);
        }

        WM_EXITSIZEMOVE => {
            state.in_size_move.set(false);
            let _ = KillTimer(Some(hwnd), SETTLE_TIMER_ID);
            if take_custom_drag_started(hwnd) {
                let _ = PostMessageW(Some(hwnd), WM_LBUTTONUP, WPARAM(0), lparam);
            }
            state.flush_pending_move(hwnd);
            state.emit_moving_state(false);
            return DefSubclassProc(hwnd, msg, wparam, lparam);
        }

        WM_MOVING => {
            // 阻止 wry 在每次 WM_MOVING 中同步调用 WebView2 COM NotifyParentWindowPositionChanged()
            state.pending_move.set(true);
            state.last_move_instant.set(Some(Instant::now()));
            state.emit_moving_state(true);
            let _ = SetTimer(Some(hwnd), SETTLE_TIMER_ID, SETTLE_DELAY_MS, None);
            return LRESULT(1);
        }

        WM_WINDOWPOSCHANGED => {
            if state.bypass_throttle.get() || lparam.0 == 0 {
                return DefSubclassProc(hwnd, msg, wparam, lparam);
            }
            let wp = &*(lparam.0 as *const WINDOWPOS);
            let decision = classify_windowpos_changed(WindowPosCheckInput {
                x: wp.x,
                y: wp.y,
                cx: wp.cx,
                cy: wp.cy,
                flags: wp.flags.0,
                last_pos: state.last_pos.get(),
                last_outer_size: state.last_outer_size.get(),
                is_minimized: IsIconic(hwnd).as_bool(),
                is_maximized: IsZoomed(hwnd).as_bool(),
            });

            match decision {
                WindowPosDecision::CoalesceMove => {
                    let now = Instant::now();
                    let in_burst = state
                        .last_move_instant
                        .get()
                        .map(|prev| now.duration_since(prev).as_millis() <= MOVE_BURST_WINDOW_MS)
                        .unwrap_or(false);
                    let next_count = if in_burst {
                        state.consecutive_moves.get().saturating_add(1)
                    } else {
                        1
                    };
                    state.consecutive_moves.set(next_count);
                    state.last_move_instant.set(Some(now));
                    state.last_pos.set(Some((wp.x, wp.y)));
                    state.pending_move.set(true);

                    // 连续移动（或原生拖动模式）时暂停前端 120FPS 透明画布重绘，释放 DWM/GPU 给窗口合成与 TidyTabs 标签栏
                    if state.in_size_move.get() || next_count >= 2 {
                        state.emit_moving_state(true);
                    }

                    let _ = SetTimer(Some(hwnd), SETTLE_TIMER_ID, SETTLE_DELAY_MS, None);
                    return LRESULT(0);
                }
                WindowPosDecision::NoOpSwallow => {
                    return LRESULT(0);
                }
                WindowPosDecision::PassThrough => {
                    let flags = wp.flags.0;
                    if (flags & SWP_NOSIZE.0) == 0 && wp.cx > 0 && wp.cy > 0 {
                        state.last_outer_size.set(Some((wp.cx, wp.cy)));
                    }
                    if (flags & SWP_NOMOVE.0) == 0 {
                        state.last_pos.set(Some((wp.x, wp.y)));
                        state.pending_move.set(false);
                    }
                    // 若是缩放/最大化/恢复，立即恢复前端画布渲染
                    if (flags & SWP_NOSIZE.0) == 0 {
                        state.emit_moving_state(false);
                    }
                    return DefSubclassProc(hwnd, msg, wparam, lparam);
                }
            }
        }

        WM_MOVE => {
            if !state.bypass_throttle.get() && (state.in_size_move.get() || state.pending_move.get())
            {
                state.pending_move.set(true);
                let _ = SetTimer(Some(hwnd), SETTLE_TIMER_ID, SETTLE_DELAY_MS, None);
                return LRESULT(0);
            }
            return DefSubclassProc(hwnd, msg, wparam, lparam);
        }

        WM_SIZE => {
            state.sync_rect_from_hwnd(hwnd);
            return DefSubclassProc(hwnd, msg, wparam, lparam);
        }

        WM_TIMER if wparam.0 == SETTLE_TIMER_ID => {
            let _ = KillTimer(Some(hwnd), SETTLE_TIMER_ID);
            if !state.in_size_move.get() {
                state.flush_pending_move(hwnd);
                state.emit_moving_state(false);
            }
            return LRESULT(0);
        }

        WM_NCDESTROY => {
            let _ = KillTimer(Some(hwnd), SETTLE_TIMER_ID);
            let _ = take_custom_drag_started(hwnd);
            let _ = RemoveWindowSubclass(
                hwnd,
                Some(drag_compat_subclass_proc),
                DRAG_COMPAT_SUBCLASS_ID,
            );
            let res = DefSubclassProc(hwnd, msg, wparam, lparam);
            drop(Box::from_raw(dw_ref_data as *mut SubclassState));
            return res;
        }

        _ => {}
    }

    DefSubclassProc(hwnd, msg, wparam, lparam)
}

/// 为指定 Tauri 窗口挂载 Windows 拖动性能优化与 TidyTabs 兼容子类。
/// 必须在主线程、WebView 创建完成后调用，确保位于 wry 的 `parent_subclass_proc` 之前拦截高频位置同步消息。
pub fn install_for_window(app: AppHandle, window: &WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    let state = Box::new(SubclassState {
        app,
        window_label: window.label().to_owned(),
        in_size_move: Cell::new(false),
        bypass_throttle: Cell::new(false),
        pending_move: Cell::new(false),
        frontend_moving_notified: Cell::new(false),
        consecutive_moves: Cell::new(0),
        last_move_instant: Cell::new(None),
        last_pos: Cell::new(None),
        last_outer_size: Cell::new(None),
    });
    state.sync_rect_from_hwnd(hwnd);
    let state_ptr = Box::into_raw(state) as usize;

    unsafe {
        if !SetWindowSubclass(
            hwnd,
            Some(drag_compat_subclass_proc),
            DRAG_COMPAT_SUBCLASS_ID,
            state_ptr,
        )
        .as_bool()
        {
            drop(Box::from_raw(state_ptr as *mut SubclassState));
        }
    }
}

pub fn install_main(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        install_for_window(app, &window);
    }
}

/// Windows 专用无卡顿窗口拖动入口：
/// 修复 tao `drag_window()` 传入栈指针 `&points` 作为 `WM_NCLBUTTONDOWN` `lParam` 的缺陷，
/// 改为传递标准 Win32 `MAKELPARAM(pt.x, pt.y)` 屏幕坐标，确保 TidyTabs 等窗口钩子精确追踪拖动起点。
#[tauri::command]
pub fn start_window_drag(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let label = window.label().to_owned();
    let app_clone = app.clone();
    app.run_on_main_thread(move || {
        let Some(win) = app_clone.get_webview_window(&label) else {
            return;
        };
        let Ok(hwnd) = win.hwnd() else {
            return;
        };
        unsafe {
            let mut pt = POINT::default();
            let _ = GetCursorPos(&mut pt);
            let _ = ReleaseCapture();
            mark_custom_drag_started(hwnd);
            let lparam = pack_points_lparam(pt.x, pt.y);
            let _ = PostMessageW(
                Some(hwnd),
                WM_NCLBUTTONDOWN,
                WPARAM(HTCAPTION as usize),
                lparam,
            );
        }
    })
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_positive_and_negative_multi_monitor_coordinates() {
        let pos = pack_points_lparam(1234, 567);
        let x = (pos.0 & 0xFFFF) as u16 as i16;
        let y = ((pos.0 >> 16) & 0xFFFF) as u16 as i16;
        assert_eq!((x, y), (1234, 567));

        // 左侧副屏常见负坐标
        let neg = pack_points_lparam(-850, -120);
        let nx = (neg.0 & 0xFFFF) as u16 as i16;
        let ny = ((neg.0 >> 16) & 0xFFFF) as u16 as i16;
        assert_eq!((nx, ny), (-850, -120));
    }

    #[test]
    fn coalesces_pure_moves_including_tidytabs_setwindowpos_without_swp_nosize() {
        assert_eq!(
            classify_windowpos_changed(WindowPosCheckInput {
                x: 200,
                y: 120,
                cx: 0,
                cy: 0,
                flags: SWP_NOSIZE.0 | SWP_NOZORDER.0,
                last_pos: Some((190, 120)),
                last_outer_size: Some((1200, 800)),
                is_minimized: false,
                is_maximized: false,
            }),
            WindowPosDecision::CoalesceMove
        );

        assert_eq!(
            classify_windowpos_changed(WindowPosCheckInput {
                x: 210,
                y: 125,
                cx: 1200,
                cy: 800,
                flags: SWP_NOACTIVATE.0,
                last_pos: Some((200, 120)),
                last_outer_size: Some((1200, 800)),
                is_minimized: false,
                is_maximized: false,
            }),
            WindowPosDecision::CoalesceMove
        );

        assert_eq!(
            classify_windowpos_changed(WindowPosCheckInput {
                x: 210,
                y: 125,
                cx: 1200,
                cy: 800,
                flags: SWP_NOACTIVATE.0,
                last_pos: Some((210, 125)),
                last_outer_size: Some((1200, 800)),
                is_minimized: false,
                is_maximized: false,
            }),
            WindowPosDecision::NoOpSwallow
        );
    }

    #[test]
    fn passes_through_resize_show_hide_maximize_and_dpi_changes() {
        assert_eq!(
            classify_windowpos_changed(WindowPosCheckInput {
                x: 210,
                y: 125,
                cx: 1280,
                cy: 820,
                flags: 0,
                last_pos: Some((210, 125)),
                last_outer_size: Some((1200, 800)),
                is_minimized: false,
                is_maximized: false,
            }),
            WindowPosDecision::PassThrough
        );

        assert_eq!(
            classify_windowpos_changed(WindowPosCheckInput {
                x: 210,
                y: 125,
                cx: 1200,
                cy: 800,
                flags: SWP_SHOWWINDOW.0 | SWP_NOSIZE.0,
                last_pos: Some((200, 120)),
                last_outer_size: Some((1200, 800)),
                is_minimized: false,
                is_maximized: false,
            }),
            WindowPosDecision::PassThrough
        );

        assert_eq!(
            classify_windowpos_changed(WindowPosCheckInput {
                x: 0,
                y: 0,
                cx: 1920,
                cy: 1040,
                flags: SWP_NOSIZE.0,
                last_pos: Some((200, 120)),
                last_outer_size: Some((1200, 800)),
                is_minimized: false,
                is_maximized: true,
            }),
            WindowPosDecision::PassThrough
        );
    }
}
