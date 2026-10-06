# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Exports the watch model: SigLIP2 base (google/siglip2-base-patch16-224, Apache-2.0 weights)
with the zero-shot prompts folded in, so the runtime only runs the image tower.

    python export_siglip2.py <out dir> [--check <image dir>]

Writes <out dir>/sx-watch-siglip2.onnx (input `pixel_values` [n, 3, 224, 224], RGB scaled to
-1..1; outputs `probs` [n, 4], softmax over PROMPTS, `hand` [n] and `debris` [n], each the share of
its own group's softmax that falls on the group's yes prompts, and `embedding` [n, 768], unit
length) and sx-watch-siglip2.json (prompts, kinds, the source model and its license). Weights are
stored as float16 (186 MB, outputs within 0.005 of float32); dynamic int8 quantization moved them
by up to 0.85 and is not used. The model file is not kept in git; it ships beside the sx-watch
binary. The export stays under 2 GB of memory.
"""
import gc, json, os, subprocess, sys

MODEL = "google/siglip2-base-patch16-224"
# The order is the order of `probs`. The kinds are sx-watch's report kinds; "normal" never reports.
PROMPTS = [
    ("spaghetti", "a photo of a failed 3D print with a tangled mess of spaghetti filament"),
    ("nozzle_blob", "a photo of a 3D printer nozzle covered in a blob of melted plastic"),
    ("detached", "a photo of a 3D print knocked over on the bed"),
    ("normal", "a photo of a 3D print in progress that looks normal"),
]
# Groups scored apart from PROMPTS, so adding them leaves `probs` exactly as it was. Each is
# (yes prompts, no prompts); the output is the softmax share of the yes prompts within the group.
# Picked from five phrasings on 20 frames with a hand pasted into a printer and 70 public frames
# without one: at 0.6 these catch 20 of 20 with one false hit (a spaghetti frame at 0.92).
HAND = (
    ["a photo of a human hand reaching into a 3D printer",
     "a photo of a person reaching into a 3D printer with their hand"],
    ["a photo of a 3D printer printing with nobody touching it",
     "a photo of a failed 3D print with a tangled mess of spaghetti filament"],
)
# Something left on the plate before a print. A clean plate already scores about 0.7 here, so
# sx-watch uses this as a rise over the person's empty-plate picture, not on its own.
DEBRIS = (
    ["a photo of a 3D printer build plate with debris, a leftover piece of plastic or dirt on it",
     "a photo of a small object left on an empty 3D printer build plate"],
    ["a photo of a clean, empty 3D printer build plate",
     "a photo of a smooth empty printer bed surface"],
)


def features(out):
    return out.pooler_output if hasattr(out, "pooler_output") else out


def watch_module(vision, text, hand, debris, scale, bias):
    """The image tower with the prompts folded in, as one module for the export."""
    import torch

    class Watch(torch.nn.Module):
        def __init__(self, vision, text, hand, debris, scale, bias):
            super().__init__()
            self.vision = vision
            self.register_buffer("text", text)
            self.register_buffer("hand_text", hand)
            self.register_buffer("debris_text", debris)
            self.hand_yes = len(HAND[0])
            self.debris_yes = len(DEBRIS[0])
            self.register_buffer("scale", scale.exp().reshape(()))
            self.register_buffer("bias", bias.reshape(()))

        def forward(self, pixel_values):
            e = features(self.vision(pixel_values=pixel_values))
            e = e / e.norm(dim=-1, keepdim=True)
            probs = torch.softmax(e @ self.text.T * self.scale + self.bias, dim=-1)
            hand = torch.softmax(e @ self.hand_text.T * self.scale + self.bias, dim=-1)[:, : self.hand_yes].sum(-1)
            debris = torch.softmax(e @ self.debris_text.T * self.scale + self.bias, dim=-1)[:, : self.debris_yes].sum(-1)
            return probs, hand, debris, e

    return Watch(vision, text, hand, debris, scale, bias).eval()


def load(module, weights, prefix, rows=None):
    """Loads one tower's weights from the checkpoint; `rows` keeps only those token table rows."""
    from safetensors import safe_open
    names = set(module.state_dict())
    state = {}
    with safe_open(weights, "pt") as f:
        for k in f.keys():
            if not k.startswith(prefix):
                continue
            name = k if k in names else k.removeprefix(prefix)
            t = f.get_tensor(k)
            state[name] = t[rows] if rows is not None and name.endswith("token_embedding.weight") else t
    missing, unexpected = module.load_state_dict(state, strict=False)
    assert not unexpected and all("position_ids" in k for k in missing), (missing[:3], unexpected[:3])


def main():
    """Runs the torch part in its own process, then converts and checks with that memory freed:
    torch keeps what it used, and both stages in one process pass 2 GB."""
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    subprocess.run([sys.executable, __file__, "--torch", *sys.argv[1:]], check=True)
    paths = [os.path.join(out_dir, n) for n in ("sx-watch-siglip2-fp32.onnx", "sx-watch-siglip2.onnx", "check.npz")]
    finish(*paths)


def export(argv):
    import torch
    from huggingface_hub import hf_hub_download
    from safetensors import safe_open
    from transformers import AutoConfig, AutoProcessor, SiglipTextModel, SiglipVisionModel

    out_dir = argv[0]
    os.makedirs(out_dir, exist_ok=True)
    torch.set_grad_enabled(False)
    proc = AutoProcessor.from_pretrained(MODEL)
    # One tower at a time, so the export stays under 2 GB of memory. The text tower runs with only
    # the rows of its 256k-token table the prompts use, then goes before the image tower loads.
    config = AutoConfig.from_pretrained(MODEL)
    groups = [[p for _, p in PROMPTS], HAND[0] + HAND[1], DEBRIS[0] + DEBRIS[1]]
    toks = [proc(text=g, padding="max_length", max_length=64, return_tensors="pt")["input_ids"] for g in groups]
    used = torch.unique(torch.cat([t.flatten() for t in toks]))
    weights = hf_hub_download(MODEL, "model.safetensors")
    text_config = config.text_config
    text_config.vocab_size = len(used)
    text_model = SiglipTextModel(text_config).eval()
    load(text_model, weights, "text_model.", rows=used)
    with safe_open(weights, "pt") as f:
        scale, bias = f.get_tensor("logit_scale"), f.get_tensor("logit_bias")
    texts = []
    for t in toks:
        e = features(text_model(input_ids=torch.searchsorted(used, t)))
        texts.append(e / e.norm(dim=-1, keepdim=True))
    del text_model
    gc.collect()
    model = SiglipVisionModel(config.vision_config).eval()
    load(model, weights, "vision_model.")
    watch = watch_module(model, *texts, scale, bias)
    onnx_path = os.path.join(out_dir, "sx-watch-siglip2.onnx")
    fp32_path = os.path.join(out_dir, "sx-watch-siglip2-fp32.onnx")
    torch.onnx.export(
        watch, (torch.zeros(1, 3, 224, 224),), fp32_path, input_names=["pixel_values"],
        output_names=["probs", "hand", "debris", "embedding"],
        dynamic_axes={"pixel_values": {0: "n"}, "probs": {0: "n"}, "hand": {0: "n"}, "debris": {0: "n"}, "embedding": {0: "n"}},
        opset_version=17, dynamo=False,
    )
    meta = {
        "source": MODEL, "license": "Apache-2.0", "size": 224, "mean": 0.5, "std": 0.5, "resize": "bilinear",
        "kinds": [k for k, _ in PROMPTS], "prompts": [p for _, p in PROMPTS],
        "hand": {"yes": HAND[0], "no": HAND[1]}, "debris": {"yes": DEBRIS[0], "no": DEBRIS[1]},
    }
    json.dump(meta, open(os.path.join(out_dir, "sx-watch-siglip2.json"), "w"), indent=2)
    refs_path = os.path.join(out_dir, "check.npz")
    if os.path.exists(refs_path):
        os.remove(refs_path)
    if "--check" in argv:
        files, pixels, refs = references(proc, watch, argv[argv.index("--check") + 1])
        import numpy as np
        np.savez(refs_path, files=np.array(files), pixels=np.stack([p[0].numpy() for p in pixels]),
                 probs=np.stack([r[0] for r in refs]), hand=np.array([r[1] for r in refs]), debris=np.array([r[2] for r in refs]))


def finish(fp32_path, onnx_path, refs_path):
    import onnx
    from onnxruntime.transformers.float16 import convert_float_to_float16
    onnx.save(convert_float_to_float16(onnx.load(fp32_path), keep_io_types=True), onnx_path)
    if os.path.exists(refs_path):
        check(refs_path, (onnx_path, fp32_path))
        os.remove(refs_path)
    os.remove(fp32_path)


def references(proc, watch, d):
    """The pictures in `d` as the model takes them, and the torch outputs for each."""
    import glob
    from PIL import Image
    files = sorted(glob.glob(os.path.join(d, "*.jpg")))
    pixels = [proc(images=Image.open(f).convert("RGB"), return_tensors="pt")["pixel_values"] for f in files]
    return files, pixels, [[t[0].numpy() for t in watch(px)[:3]] for px in pixels]


def check(refs_path, paths):
    """Prints, per picture, the ONNX outputs and how far each ONNX file is from torch."""
    import numpy as np
    import onnxruntime as ort
    d = np.load(refs_path)
    refs = list(zip(d["probs"], d["hand"], d["debris"]))
    worst = {}
    for p in paths:
        s = ort.InferenceSession(p)
        for f, px, ref in zip(d["files"], d["pixels"], refs):
            got = s.run(["probs", "hand", "debris"], {"pixel_values": px[None]})
            diff = max(float(np.abs(g[0] - r).max()) for g, r in zip(got, ref))
            worst[p] = max(worst.get(p, 0.0), diff)
            if p == paths[0]:
                probs, hand, debris = (g[0] for g in got)
                print(os.path.basename(f), "probs", " ".join(f"{v:.3f}" for v in probs), f"hand {hand:.3f} debris {debris:.3f} diff {diff:.4f}")
        del s
    for p, w in worst.items():
        print(os.path.basename(p), "max diff from torch", f"{w:.4f}")


if __name__ == "__main__":
    if sys.argv[1] == "--torch":
        export(sys.argv[2:])
    else:
        main()
