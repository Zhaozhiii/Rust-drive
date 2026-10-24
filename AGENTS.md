# Rust-drive contributor instructions

- Keep the backend lightweight and streaming; avoid full-file buffering.
- Preserve API compatibility and resumable upload persistence.
- Keep the frontend text-only, with no external resources or runtime dependencies.
- Run formatting, Clippy, unit tests and isolated integration tests for backend changes.
- Deployment scripts in `deploy/` include migration steps for the original installation. Review targets before running them.
- Never commit credentials, private keys, user files, backups or deployment state.
