$ErrorActionPreference = 'Stop'
$projectPath = Split-Path $PSScriptRoot -Parent
New-Item -ItemType Directory -Force (Join-Path $projectPath 'artifacts') | Out-Null
wsl -d Ubuntu-24.04 --cd $projectPath -- bash -lc 'set -euo pipefail; source ~/.cargo/env; export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/rust-drive/target}"; cargo fmt --check; cargo clippy --locked --target x86_64-unknown-linux-musl -- -D warnings; cargo test --locked --target x86_64-unknown-linux-musl; cargo build --release --locked --target x86_64-unknown-linux-musl; cp "$CARGO_TARGET_DIR/x86_64-unknown-linux-musl/release/drive-service" artifacts/drive-service; python3 tests/integration.py artifacts/drive-service | tee artifacts/integration.log'
if ($LASTEXITCODE -ne 0) { throw 'Build or tests failed' }
