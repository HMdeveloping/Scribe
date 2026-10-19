// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(feature = "p0-harness")]
    scribe_app_lib::run_p0_transcription_harness();

    #[cfg(not(feature = "p0-harness"))]
    scribe_app_lib::run()
}
