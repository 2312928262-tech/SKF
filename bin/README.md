# Optional native helpers

The npm local build does not bundle unsigned Windows executables, Tauri installers, Node binaries or browser/model toolchains. CLI and local Web work without WebView2. UIA/desktop helpers must be separately verified and explicitly enabled; unavailable capabilities fail closed. Existing development helpers remain on disk and are not deleted.
