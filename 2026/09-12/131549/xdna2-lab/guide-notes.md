# XDNA2 / AIE2P — From Architecture to Programming

Source snapshot: 2026-09-12, Asia/Taipei. Root: `/home/chihmin/xdna2-lab/`.

## Toolchain choice
- Close-to-metal baseline: IRON / MLIR-AIE + Peano (LLVM-AIE).
- Higher-level experimental compiler-generated kernels: Triton-XDNA → triton-shared → Linalg / Transform → MLIR-AIR → MLIR-AIE + per-core compiler.
- IREE-AMDAIE downloaded for comparison, not selected as the default programming tutorial.
- No universal SOTA winner established; upstream benchmark statements apply only to their tested workloads and environments.

## Critical findings
- gfx1151 GPU target is separate from XDNA2 NPU (`npu2`, `aie2p-none-unknown-elf`).
- AIE2P arch 21 is not AIE2PS arch 22. Do not copy Versal AM027 FP16/FP8 capabilities to Ryzen XDNA2.
- Full NPU2 model: 8 columns × 4 compute rows; row0 shim, row1 memory, row2..5 compute. Actual usable partition depends on SKU/runtime.
- Per compute tile 64 KiB data SRAM; per memory tile 512 KiB; memory budget includes FIFO buffers, stack, globals and constants.
- Type representation, primitive support, mmul API support and tested frontend mapping are distinct.
- INT8: native matrix primitive. INT16 modes have shape-dependent acc32/acc64.
- INT8×INT4 4×16×16 API is unpack + two INT8 primitives in this Peano snapshot; not proof of native INT4 throughput.
- INT32×INT16 4×2×8 has direct primitive; broader INT32 combinations are often decomposed.
- BF16 4×8×8 non-BFP API helper uses 8×32-lane BF16 primitives and shuffle/broadcast. One API call is not one machine instruction.
- BFP16 EBS8 has direct 8×8×8 matrix path. Each 8 signed 8-bit mantissas share an 8-bit exponent (9-byte block). BFP16 is not BF16 or IEEE FP16.
- Independent BFP8 and IEEE FP8 MMUL support was not established for AIE2P.
- FP32 accumulators/output do not prove native FP32 multiplication. AIE API decomposition and compiler BF16-demotion are different precision paths.
- DMA packing, microtile geometry, outer tiling, buffering and numerical tolerance must be designed together.

## Start programming
Use separate IRON and Triton virtual environments. Match repository and wheel versions exactly; the source snapshots were captured independently and have not been built together.

IRON setup: `sources/mlir-aie/README.md` and `utils/env_install.sh` / `utils/env_setup.sh`.
Start with `programming_examples/basic/vector_scalar_add/vector_scalar_add.py`.
Full GEMM: `programming_examples/basic/matrix_multiplication/whole_array/whole_array.py`.
Suggested source-checked command (not executed):

```bash
python3 whole_array.py --dev npu2 --n-aie-cols 8 \
 -M 512 -K 512 -N 512 -m 64 -k 64 -n 32 \
 --dtype_in bf16 --dtype_out f32 --use-chess 0
```

Triton setup: `sources/Triton-XDNA/README.md`; use pinned dependencies for source build.
`examples/matmul_bf16_m64_n64_k64/transform_aie2p.mlir` is the NPU2 mapping.

```bash
AIR_TRANSFORM_TILING_SCRIPT=transform_aie2p.mlir python matmul_bf16_m64_n64_k64.py
```

The upstream script sweeps large sizes. Read it before running. It is not a tiny 64×64 one-shot benchmark.

## Download and verification scope
Downloaded source, primary PDF/HTML/Markdown documents and checksums. LLVM-AIE uses sparse checkout; selected Linux submodules included, not an offline complete build kit. No wheels installed, no compiler build, no NPU execution, no driver/BIOS/kernel/ROCm changes. Website tests and a working-set calculator are not NPU validation.

See `research-manifest.json` for exact SHAs, `type-mma-audit.md` for immutable source lines and limitations, and the website for diagrams and walkthroughs.
