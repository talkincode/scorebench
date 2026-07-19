# scorebench release

scorebench is the agent-native workbench for scorekit: a Tauri desktop shell for chat-driven scene authoring, scorekit validation/rendering, project-local memory, and WebAudio playback/visualization.

scorekit remains an external runtime dependency. On first launch, scorebench reports its discovered path, doctor status, machine-readable version compatibility, and scorekit-provided installation hints.

The release is created as a draft for manual review and publication. Verify `SHA256SUMS` and platform signing/notarization status before publishing. Publishing the release triggers the Homebrew cask update when `HOMEBREW_TAP_TOKEN` is configured.
