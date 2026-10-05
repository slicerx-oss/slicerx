# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Exports the watch model: SigLIP2 base (google/siglip2-base-patch16-224, Apache-2.0 weights)
with the zero-shot prompts folded in, so the runtime only runs the image tower.

    python export_siglip2.py <out dir> [--check <image dir>]

Writes <out dir>/sx-watch-siglip2.onnx (input `pixel_values` [n, 3, 224, 224], RGB scaled to
-1..1; outputs `probs` [n, 4], softmax over PROMPTS, and `embedding` [n, 768], unit length) and
sx-watch-siglip2.json (prompts, kinds, the source model and its license). Weights are stored as
float16 (177 MB, probabilities within 0.005 of float32); dynamic int8 quantization moved them by
up to 0.85 and is not used. The model file is not kept in git; it ships beside the sx-watch binary.
"""
import json, os, sys

import torch
from transformers import AutoModel, AutoProcessor

MODEL = "google/siglip2-base-patch16-224"
# The order is the order of `probs`. The kinds are sx-watch's report kinds; "normal" never reports.
PROMPTS = [
    ("spaghetti", "a photo of a failed 3D print with a tangled mess of spaghetti filament"),
    ("nozzle_blob", "a photo of a 3D printer nozzle covered in a blob of melted plastic"),
    ("detached", "a photo of a 3D print knocked over on the bed"),
    ("normal", "a photo of a 3D print in progress that looks normal"),
]


def features(out):
    return out.pooler_output if hasattr(out, "pooler_output") else out


class Watch(torch.nn.Module):
    def __init__(self, model, text):
        super().__init__()
        self.model = model
        self.register_buffer("text", text)
        self.register_buffer("scale", model.logit_scale.detach().exp().reshape(()))
        self.register_buffer("bias", model.logit_bias.detach().reshape(()))

    def forward(self, pixel_values):
        e = features(self.model.get_image_features(pixel_values=pixel_values))
        e = e / e.norm(dim=-1, keepdim=True)
        return torch.softmax(e @ self.text.T * self.scale + self.bias, dim=-1), e


def main():
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    torch.set_grad_enabled(False)
    proc = AutoProcessor.from_pretrained(MODEL)
    model = AutoModel.from_pretrained(MODEL).eval()
    tok = proc(text=[p for _, p in PROMPTS], padding="max_length", max_length=64, return_tensors="pt")
    text = features(model.get_text_features(input_ids=tok["input_ids"]))
    text = text / text.norm(dim=-1, keepdim=True)
    watch = Watch(model, text).eval()
    onnx_path = os.path.join(out_dir, "sx-watch-siglip2.onnx")
    fp32_path = os.path.join(out_dir, "sx-watch-siglip2-fp32.onnx")
    torch.onnx.export(
        watch, (torch.zeros(1, 3, 224, 224),), fp32_path, input_names=["pixel_values"],
        output_names=["probs", "embedding"], dynamic_axes={"pixel_values": {0: "n"}, "probs": {0: "n"}, "embedding": {0: "n"}},
        opset_version=17, dynamo=False,
    )
    import onnx
    from onnxruntime.transformers.float16 import convert_float_to_float16
    onnx.save(convert_float_to_float16(onnx.load(fp32_path), keep_io_types=True), onnx_path)
    meta = {
        "source": MODEL, "license": "Apache-2.0", "size": 224, "mean": 0.5, "std": 0.5, "resize": "bilinear",
        "kinds": [k for k, _ in PROMPTS], "prompts": [p for _, p in PROMPTS],
    }
    json.dump(meta, open(os.path.join(out_dir, "sx-watch-siglip2.json"), "w"), indent=2)
    if "--check" in sys.argv:
        import glob
        import numpy as np
        import onnxruntime as ort
        from PIL import Image
        d = sys.argv[sys.argv.index("--check") + 1]
        files = sorted(glob.glob(os.path.join(d, "*.jpg")))[:8]
        sessions = {os.path.basename(p): ort.InferenceSession(p) for p in (onnx_path, fp32_path)}
        for f in files:
            img = Image.open(f).convert("RGB")
            px = proc(images=img, return_tensors="pt")["pixel_values"]
            full = model(pixel_values=px, input_ids=tok["input_ids"])
            ref = torch.softmax(full.logits_per_image[0], 0).numpy()
            line = [os.path.basename(f), "torch " + " ".join(f"{v:.3f}" for v in ref)]
            for name, s in sessions.items():
                got = s.run(["probs"], {"pixel_values": px.numpy()})[0][0]
                line.append(f"{name} max diff {np.abs(got - ref).max():.4f}")
            print(", ".join(line))
    os.remove(fp32_path)


if __name__ == "__main__":
    main()
