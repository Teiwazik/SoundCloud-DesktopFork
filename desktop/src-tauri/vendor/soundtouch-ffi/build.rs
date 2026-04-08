use std::{fs, path::PathBuf};
const SOUNDTOUCH_DIR: &str = "soundtouch-2_3_2";

#[allow(dead_code)] // Used conditionally based on target platform
fn link_system() {
    // Re-run if user changes this env var
    println!("cargo:rerun-if-env-changed=SOUNDTOUCH_LIB_DIR");
    // if the user set SOUND_TOUCH_LIB_DIR, add it
    if let Ok(dir) = std::env::var("SOUNDTOUCH_LIB_DIR") {
        println!("cargo:rustc-link-search=native={}", dir);
    }
    // dynamic link against system SoundTouch
    println!("cargo:rustc-link-lib=dylib=SoundTouch");
    println!("cargo:rustc-link-lib=dylib=stdc++");
}

fn build() {
    let soundtouch_dir = std::path::Path::new(SOUNDTOUCH_DIR);
    let source_dir = soundtouch_dir.join("source").join("SoundTouch");

    let mut cc = cc::Build::new();
    cc.warnings(true)
        .cpp(true)
        .extra_warnings(true)
        .file(source_dir.join("AAFilter.cpp"))
        .file(source_dir.join("BPMDetect.cpp"))
        .file(source_dir.join("FIFOSampleBuffer.cpp"))
        .file(source_dir.join("FIRFilter.cpp"))
        .file(source_dir.join("InterpolateCubic.cpp"))
        .file(source_dir.join("InterpolateLinear.cpp"))
        .file(source_dir.join("InterpolateShannon.cpp"))
        .file(source_dir.join("PeakFinder.cpp"))
        .file(source_dir.join("RateTransposer.cpp"))
        .file(source_dir.join("SoundTouch.cpp"))
        .file(source_dir.join("TDStretch.cpp"))
        .file(source_dir.join("cpu_detect_x86.cpp"))
        .file(source_dir.join("mmx_optimized.cpp"))
        .file(source_dir.join("sse_optimized.cpp"))
        .file("wrapper.cpp")
        .include(soundtouch_dir.join("include"))
        .include(soundtouch_dir.join("source/SoundTouch"))
        .pic(false)
        .warnings(false);

    if let Ok(compiler) = std::env::var("CC") {
        let compiler = std::path::Path::new(&compiler);
        let compiler = compiler
            .file_stem()
            .expect("To have file name in CC")
            .to_str()
            .unwrap();
        if compiler == "clang-cl" {
            cc.flag("/W0");
        }
    }

    cc.compile("SoundTouch")
}

fn main() {
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let out = out_dir.join("bindings.rs");
    let pregenerated = PathBuf::from("src").join("bindings_pregenerated.rs");
    fs::copy(&pregenerated, &out).expect("Couldn't write pregenerated bindings!");

    // Skip C++ compilation on docs.rs (bindings are enough for documentation)
    if std::env::var("DOCS_RS").map(|v| v == "1").unwrap_or(false) {
        return;
    }

    // Platform default logic when no feature is explicitly set:
    // - musl => static
    // - linux/bsd, non-musl => dynamic
    // - macos => static
    // - windows => static

    #[cfg(all(feature = "bundled", feature = "dynamic"))]
    compile_error!("Choose exactly one of 'bundled' or 'dynamic'.");

    // If user explicitly opted into dynamic (feature = "dynamic"), override below.
    #[cfg(all(not(feature = "bundled"), any(
        // dynamic by default: linux & bsd non-musl
        all(unix, not(target_env = "musl"), not(target_os = "macos"))
    , feature = "dynamic")))]
    link_system();

    #[cfg(any(
        feature = "bundled",
        // static by default: musl, macos, windows
        all(unix, target_env = "musl", not(feature = "dynamic")),
        target_os = "macos",
        windows
    ))]
    build();
}
