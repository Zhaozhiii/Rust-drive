# React Bits source

Upstream: https://github.com/DavidHDev/react-bits
Commit: e12c22192ac7b4b452c5e2feb9b586d74765d696

Vendored JS/CSS components adapted for the Rust-drive application. See LICENSE.md.

Application adapters:

- FlyingButton: externalAt(x, y), externalPoint/onEngine drive real OS file drags; mask smoke around the capsule; cap drag-layer canvas DPR at 1.
- FolderFloat: controlled open/onTrigger, live reduced-motion handling, stop Matter when document is hidden.
- WakeSlider: readOnly mode and no lit segment at zero progress.
- SlideCommit: Lucide icons, End positions and Enter/Space confirms; positioning stops a return spring; Escape and pointer cancellation never commit; grab starts at pointer-down. Optional reverse/handleOnly props support a trash handle dragged from the existing file row's right edge to its left edge. Clip overflow in both directions and use the shared 12px handle radius. Optional confirmationLabel arms a second pass without calling onConfirm, preserves the first pass's background, and uses a red handle and red fill for folder deletion.

Original CSS is retained. Application dimensions and black/white colors are supplied by surface.css and adapter props. The application bridge owns all network operations and upload state.
