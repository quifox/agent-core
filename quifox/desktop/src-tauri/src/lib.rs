mod framing;
mod startup;

use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{ipc::Channel, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_dialog::DialogExt;
use std::{collections::HashSet, path::PathBuf};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

#[derive(Clone, Default)]
struct EngineState {
    child: Arc<Mutex<Option<CommandChild>>>,
    channel: Arc<Mutex<Option<Channel<Value>>>>,
    closing: Arc<AtomicBool>,
    resources: Arc<Mutex<HashSet<String>>>,
}

impl EngineState {
    fn send(&self, value: Value) {
        // Resolve media from files selected through the host, independently of the project root.
        if value["kind"] == "response" && value["ok"] == true {
            let file = &value["value"];
            if let (Some(path), Some(kind)) = (file["path"].as_str(), file["kind"].as_str()) {
                if ["text", "binary", "image", "video"].contains(&kind) {
                    if let Ok(mut resources) = self.resources.lock() { resources.insert(path.into()); }
                }
            }
        }
        if let Ok(channel) = self.channel.lock() {
            if let Some(channel) = channel.as_ref() {
                let _ = channel.send(value);
            }
        }
    }

    fn write(&self, envelope: &Value) -> Result<(), String> {
        let mut data = serde_json::to_vec(envelope).map_err(|_| "Invalid command envelope.")?;
        data.push(b'\n');
        let mut guard = self
            .child
            .lock()
            .map_err(|_| "Engine state is unavailable.")?;
        guard
            .as_mut()
            .ok_or("Engine is not running.")?
            .write(&data)
            .map_err(|_| "Engine input is unavailable.".into())
    }
}

#[tauri::command]
fn engine_start(
    app: tauri::AppHandle,
    state: State<EngineState>,
    on_frame: Channel<Value>,
) -> Result<(), String> {
    *state
        .channel
        .lock()
        .map_err(|_| "Engine channel is unavailable.")? = Some(on_frame);
    let mut guard = state
        .child
        .lock()
        .map_err(|_| "Engine state is unavailable.")?;
    if guard.is_some() {
        state.send(json!({"kind":"ready", "protocol":1}));
        return Ok(());
    }
    let command = app
        .shell()
        .sidecar("quifox-engine")
        .map_err(|_| "Bundled engine is unavailable.")?
        .args(startup::engine_arguments(std::env::args_os().skip(1)))
        .current_dir(std::env::current_dir().map_err(|_| "Launch directory is unavailable.")?)
        .set_raw_out(true)
        .set_process_group(true);
    let (mut receiver, child) = command
        .spawn()
        .map_err(|_| "Cannot start the bundled engine.")?;
    *guard = Some(child);
    let state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut frames = framing::Frames::default();
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => match frames.push(&bytes) {
                    Ok(values) => {
                        for value in values {
                            state.send(value);
                        }
                    }
                    Err(error) => {
                        state.send(json!({"kind":"fatal", "error":error}));
                        break;
                    }
                },
                CommandEvent::Terminated(_) => {
                    state.send(json!({"kind":"fatal", "error":"Engine process exited."}));
                    if let Ok(mut child) = state.child.lock() {
                        *child = None;
                    }
                    if state.closing.load(Ordering::Acquire) {
                        app.exit(0);
                    }
                    return;
                }
                CommandEvent::Error(_) => {
                    state.send(json!({"kind":"fatal", "error":"Engine process stream failed."}));
                    break;
                }
                _ => {}
            }
        }
        if let Ok(mut child) = state.child.lock() {
            if let Some(child) = child.take() {
                let _ = child.kill();
            }
        }
        if state.closing.load(Ordering::Acquire) {
            app.exit(0);
        }
    });
    Ok(())
}

#[tauri::command]
fn engine_command(state: State<EngineState>, envelope: Value) -> Result<(), String> {
    if state.closing.load(Ordering::Acquire) {
        return Err("Engine is closing.".into());
    }
    state.write(&envelope)
}

#[tauri::command]
async fn workspace_pick(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    directory: Option<String>,
    title: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_title(title).set_parent(&window);
        if let Some(directory) = directory {
            dialog = dialog.set_directory(directory);
        }
        dialog.blocking_pick_folder().map(|folder| {
            let path = folder.into_path().map_err(|_| "所选目录不可用。")?;
            path.to_str().map(str::to_owned).ok_or_else(|| "目录名称无法读取。".to_owned())
        }).transpose()
    }).await.map_err(|_| "目录选择未完成。".to_owned())?
}

fn selected_file(state: &EngineState, target: &str) -> Result<PathBuf, String> {
    if !state.resources.lock().map_err(|_| "Resource state unavailable.")?.contains(target) { return Err("File has not been selected by the host.".into()); }
    let path = std::fs::canonicalize(target).map_err(|_| "File unavailable.")?;
    if !path.is_file() { return Err("Please select a file.".into()); }
    Ok(path)
}

#[tauri::command]
fn view_asset(app: tauri::AppHandle, state: State<EngineState>, path: String) -> Result<String, String> {
    let path = selected_file(&state, &path)?;
    let extension = path.extension().and_then(|v| v.to_str()).unwrap_or("").to_lowercase();
    if !["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "mp4", "webm", "mov", "m4v", "ogv"].contains(&extension.as_str()) {
        return Err("This file is not a supported media resource.".into());
    }
    app.asset_protocol_scope().allow_file(&path).map_err(|_| "Media authorization failed.")?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn view_external(app: tauri::AppHandle, state: State<EngineState>, target: String, mode: String) -> Result<(), String> {
    if let Ok(url) = tauri::Url::parse(&target) {
        if ["http", "https"].contains(&url.scheme()) {
            return app.opener().open_url(url.as_str(), None::<&str>).map_err(|_| "External browser could not be opened.".into());
        }
    }
    let path = selected_file(&state, &target)?;
    match mode.as_str() {
        "reveal" => app.opener().reveal_item_in_dir(path).map_err(|_| "File explorer could not be opened.".into()),
        "editor" => {
            let mut url = tauri::Url::parse("vscode://file/").map_err(|_| "Editor URL is invalid.")?;
            url.set_path(&path.to_string_lossy().replace('\\', "/"));
            app.opener().open_url(url.as_str(), None::<&str>).map_err(|_| "External editor could not be opened.".into())
        },
        "default" => app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|_| "External application could not be opened.".into()),
        _ => Err("Unsupported external destination.".into())
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(EngineState::default())
        .invoke_handler(tauri::generate_handler![engine_start, engine_command, workspace_pick, view_asset, view_external])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<EngineState>().inner().clone();
                let running = state
                    .child
                    .lock()
                    .map(|child| child.is_some())
                    .unwrap_or(false);
                if !running {
                    return;
                }
                api.prevent_close();
                if state.closing.swap(true, Ordering::AcqRel) {
                    return;
                }
                let _ = state.write(&json!({"id":"window-close", "command":{"type":"close"}}));
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(10));
                    if let Ok(mut child) = state.child.lock() {
                        if let Some(child) = child.take() {
                            let _ = child.kill();
                        }
                    }
                    app.exit(0);
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("Cannot run quifox desktop");
}
