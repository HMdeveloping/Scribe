mod commands;
mod transcription_runtime;

mod transcription_chunking;

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
            transcribe_recording_chunked_dev
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
