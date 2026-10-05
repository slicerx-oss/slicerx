/* SPDX-License-Identifier: Apache-2.0 */
/* Copyright (C) 2026 The SlicerX contributors */
/* Slices one model through the C ABI (libslicerx) and writes what the farm tool writes:
 * slice.gcode, slice.sxpv and result.json in the output folder.
 * Usage: farm_slice <model> <out dir> [config.json]
 * config.json holds settings by OrcaSlicer key, for example {"layer_height": 0.2}. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "slicerx.h"

static unsigned char *read_file(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  if (fseek(f, 0, SEEK_END) != 0) {
    fclose(f);
    return NULL;
  }
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  unsigned char *buf = n >= 0 ? malloc((size_t)n + 1) : NULL;
  if (buf && fread(buf, 1, (size_t)n, f) != (size_t)n) {
    free(buf);
    buf = NULL;
  }
  fclose(f);
  if (buf) buf[n] = 0;
  *len = (size_t)n;
  return buf;
}

static int write_file(const char *dir, const char *name, const uint8_t *data, size_t len) {
  char path[4096];
  snprintf(path, sizeof path, "%s/%s", dir, name);
  FILE *f = fopen(path, "wb");
  if (!f) {
    fprintf(stderr, "cannot write %s\n", path);
    return 0;
  }
  size_t put = fwrite(data, 1, len, f);
  fclose(f);
  return put == len;
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: %s <model> <out dir> [config.json]\n", argv[0]);
    return 2;
  }
  if (sx_abi_version() != SX_ABI_VERSION) {
    fprintf(stderr, "libslicerx ABI %u, header %u\n", sx_abi_version(), (unsigned)SX_ABI_VERSION);
    return 1;
  }
  size_t len = 0;
  unsigned char *model = read_file(argv[1], &len);
  if (!model) {
    fprintf(stderr, "cannot read %s\n", argv[1]);
    return 1;
  }
  /* The file name tells the loader the format (.stl, .3mf, .obj). */
  uint64_t mesh = sx_mesh_load(model, len, argv[1]);
  free(model);
  if (mesh == 0) {
    fprintf(stderr, "sx_mesh_load: %s\n", sx_last_error());
    return 1;
  }
  size_t config_len = 2;
  char *config = NULL;
  if (argc > 3) {
    config = (char *)read_file(argv[3], &config_len);
    if (!config) {
      fprintf(stderr, "cannot read %s\n", argv[3]);
      return 1;
    }
  }
  /* The same SliceRequest the CLI reads, with the mesh id from sx_mesh_load in place of a path. */
  size_t cap = config_len + 512;
  char *request = malloc(cap);
  if (!request) return 1;
  snprintf(request, cap,
           "{\"schemaVersion\":1,\"plate\":{\"bed\":{\"widthMm\":256,\"depthMm\":256,\"heightMm\":250},"
           "\"objects\":[{\"id\":\"o1\",\"mesh\":%llu}]},\"config\":%s}",
           (unsigned long long)mesh, config ? config : "{}");
  free(config);
  SxResult *result = sx_slice(request);
  free(request);
  if (!result) {
    fprintf(stderr, "sx_slice: %s\n", sx_last_error());
    sx_mesh_free(mesh);
    return 1;
  }
  SxBuffer json = sx_result_json(result);
  SxBuffer gcode = sx_result_gcode(result);
  SxBuffer preview = sx_result_preview(result);
  int ok = write_file(argv[2], "slice.gcode", gcode.ptr, gcode.len) &&
           write_file(argv[2], "slice.sxpv", preview.ptr, preview.len) &&
           write_file(argv[2], "result.json", json.ptr, json.len);
  if (ok) printf("%s: %zu bytes of G-code, %zu bytes of preview\n", argv[1], gcode.len, preview.len);
  sx_buffer_free(json);
  sx_buffer_free(gcode);
  sx_buffer_free(preview);
  sx_result_free(result);
  sx_mesh_free(mesh);
  return ok ? 0 : 1;
}
