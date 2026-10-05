/* SPDX-License-Identifier: Apache-2.0 */
/* Copyright (C) 2026 The SlicerX contributors */
/* Slices a model through libslicerx and checks the result.
 * Usage: slice_reference <model> <expected layers> [out.gcode] */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "slicerx.h"

static unsigned char *read_file(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  unsigned char *buf = malloc((size_t)n);
  if (buf && fread(buf, 1, (size_t)n, f) != (size_t)n) {
    free(buf);
    buf = NULL;
  }
  fclose(f);
  *len = (size_t)n;
  return buf;
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: %s <model> <expected layers> [out.gcode]\n", argv[0]);
    return 2;
  }
  if (sx_abi_version() != SX_ABI_VERSION) {
    fprintf(stderr, "ABI mismatch\n");
    return 1;
  }
  size_t len = 0;
  unsigned char *model = read_file(argv[1], &len);
  if (!model) {
    fprintf(stderr, "cannot read %s\n", argv[1]);
    return 1;
  }
  uint64_t mesh = sx_mesh_load(model, len, argv[1]);
  free(model);
  if (mesh == 0) {
    fprintf(stderr, "sx_mesh_load: %s\n", sx_last_error());
    return 1;
  }
  char request[1024];
  snprintf(request, sizeof request,
           "{\"schemaVersion\":1,\"plate\":{\"objects\":[{\"id\":\"o1\",\"mesh\":%llu}]},"
           "\"config\":{\"layer_height\":0.2,\"initial_layer_print_height\":0.2,\"wall_loops\":2,"
           "\"top_shell_layers\":5,\"bottom_shell_layers\":3,\"sparse_infill_density\":15,"
           "\"line_width\":0.42,\"brim_width\":5}}",
           (unsigned long long)mesh);
  SxResult *result = sx_slice(request);
  if (!result) {
    fprintf(stderr, "sx_slice: %s\n", sx_last_error());
    return 1;
  }
  SxBuffer json = sx_result_json(result);
  SxBuffer gcode = sx_result_gcode(result);
  SxBuffer preview = sx_result_preview(result);
  char expect[64];
  snprintf(expect, sizeof expect, "\"layerCount\":%s,", argv[2]);
  int ok = json.ptr && memmem(json.ptr, json.len, expect, strlen(expect)) != NULL && gcode.len > 0 && preview.len > 32 &&
           memcmp(preview.ptr, "SXPV", 4) == 0;
  if (argc > 3) {
    FILE *f = fopen(argv[3], "wb");
    if (f) {
      fwrite(gcode.ptr, 1, gcode.len, f);
      fclose(f);
    }
  }
  printf("layers %s: %s, G-code %zu bytes, preview %zu bytes\n", argv[2], ok ? "ok" : "MISMATCH", gcode.len, preview.len);
  sx_buffer_free(json);
  sx_buffer_free(gcode);
  sx_buffer_free(preview);
  sx_result_free(result);
  sx_mesh_free(mesh);
  return ok ? 0 : 1;
}
