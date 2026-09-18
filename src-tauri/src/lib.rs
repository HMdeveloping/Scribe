mod commands;
mod transcription_runtime;

mod transcription_chunking;

#[tauri::command]
async fn perform_native_titlebar_double_click(window: tauri::Window) -> Result<(), String> {
    if window.is_fullscreen().map_err(|error| error.to_string())? {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let preference = std::process::Command::new("defaults")
            .args(["read", "-g", "AppleActionOnDoubleClick"])
            .output()
            .map(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .to_lowercase()
            })
            .unwrap_or_default();

        if preference.contains("minimize") {
            window.minimize().map_err(|error| error.to_string())?;
        } else if !preference.contains("none") && !preference.contains("do nothing") {
            if window.is_maximized().map_err(|error| error.to_string())? {
                window.unmaximize().map_err(|error| error.to_string())?;
            } else {
                window.maximize().map_err(|error| error.to_string())?;
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    if window.is_maximized().map_err(|error| error.to_string())? {
        window.unmaximize().map_err(|error| error.to_string())?;
    } else {
        window.maximize().map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[cfg(debug_assertions)]
#[tauri::command]
fn write_titlebar_geometry(snapshot: serde_json::Value) -> Result<(), String> {
    std::fs::write(
        "/private/tmp/scribe-titlebar-geometry.json",
        serde_json::to_vec_pretty(&snapshot).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[cfg(debug_assertions)]
use commands::recordings::transcribe_recording_chunked_dev;
use commands::recordings::{
    archive_recordings, assign_recording_to_project, assign_recordings_to_project,
    cancel_transcription, cancel_whisper_model_download, create_project, delete_project,
    delete_projects, delete_recordings, delete_whisper_model, download_whisper_model,
    get_recording, get_transcription_config, import_audio_recording, initialize_library,
    initialize_library_on_startup, list_archived_recordings, list_project_recordings,
    list_projects, list_recordings, load_recording_audio, load_scribe_settings, rename_project,
    rename_recording, restore_recordings, save_recording, save_scribe_settings,
    transcribe_recording,
};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            initialize_library_on_startup(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            perform_native_titlebar_double_click,
            initialize_library,
            create_project,
            list_projects,
            rename_project,
            delete_project,
            delete_projects,
            assign_recording_to_project,
            assign_recordings_to_project,
            archive_recordings,
            restore_recordings,
            delete_recordings,
            list_recordings,
            list_archived_recordings,
            list_project_recordings,
            get_recording,
            rename_recording,
            get_transcription_config,
            download_whisper_model,
            cancel_whisper_model_download,
            delete_whisper_model,
            import_audio_recording,
            load_scribe_settings,
            save_recording,
            save_scribe_settings,
            load_recording_audio,
            transcribe_recording,
            cancel_transcription,
            #[cfg(debug_assertions)]
            transcribe_recording_chunked_dev,
            #[cfg(debug_assertions)]
            write_titlebar_geometry
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
