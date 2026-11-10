// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// slicerx_geom_interference and slicerx_geom_measure's section on a design's parts: overlapping boxes, boxes 0.3 mm
// apart, a pin in its hole and a section of a cylinder, open parts refused, and a measure without a section answering
// as before. Engine replies are recorded in fixtures/design-section-interference-replies.json.gz.
import { describe, expect, it } from "vitest";
import type { Design as HostDesign, DesignHost } from "@slicerx/cad-history";
import type { ToolContext } from "@slicerx/pilot";
import { cadTools, type CadFiles } from "../src/cad";
import { connect, data, text } from "./helpers";
import { useGeomEngine } from "./geom-engine";

const geom = useGeomEngine("design-section-interference-replies");

const rect = (w: number, h: number, cx: number, cy: number) => ({
  shape: { type: "rectangle", widthMm: w, heightMm: h },
  placement: { center: [cx, cy] },
});
const circle = (d: number, cx: number, cy: number) => ({
  shape: { type: "circle", diameterMm: d },
  placement: { center: [cx, cy] },
});
const top = (z: number) => ({ origin: [0, 0, z], normal: [0, 0, 1] });

type Fit = {
  interferes: boolean;
  overlap_mm3: number;
  clearance_mm: number;
  from?: number[];
  to?: number[];
};
type Cut = {
  section: {
    area_mm2: number;
    outline_mm: number;
    regions: number;
    holes: number;
    loops: { outer: number[][]; holes: number[][][] }[];
  };
};

async function harness() {
  const h = await connect({
    geomEngine: (op: string, request: unknown) => geom.engine(op, request),
  });
  const ok = async <T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> => {
    const r = await h.call(name, args);
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy();
    return data<{ output: T }>(r).output;
  };
  const design = (
    await ok<{ design: string }>("slicerx_design_new", { name: "Fit" })
  ).design;
  const box = (w: number, cx: number, cy: number, name: string) =>
    ok("slicerx_geom_extrude", {
      design,
      ...rect(w, w, cx, cy),
      distance_mm: 10,
      name,
    });
  return { h, ok, design, box };
}

describe("interference between two parts", () => {
  it("gives the volume two overlapping boxes share", async () => {
    const t = await harness();
    await t.box(10, 60, 60, "A");
    // 3 mm into A along x and 2 mm off along y: 3 by 8 by 10
    await t.box(10, 67, 62, "B");
    const r = await t.ok<Fit>("slicerx_geom_interference", {
      design: t.design,
      a: 0,
      b: 1,
    });
    expect(r).toMatchObject({ interferes: true, clearance_mm: 0 });
    expect(r.overlap_mm3).toBeCloseTo(240, 3);
    expect(r.from).toBeUndefined();
  });

  it("gives 0.3 mm between boxes 0.3 mm apart, with the closest points", async () => {
    const t = await harness();
    await t.box(10, 60, 60, "A");
    await t.box(10, 70.3, 60, "B");
    const r = await t.ok<Fit>("slicerx_geom_interference", {
      design: t.design,
      a: 0,
      b: 1,
    });
    expect(r).toMatchObject({ interferes: false, overlap_mm3: 0 });
    expect(r.clearance_mm).toBeCloseTo(0.3, 3);
    expect(r.to![0]! - r.from![0]!).toBeCloseTo(0.3, 3);
  });

  it("gives a pin in its hole its radial clearance, 0.2 mm less the facets", async () => {
    const t = await harness();
    await t.ok("slicerx_geom_extrude", {
      design: t.design,
      ...rect(30, 20, 60, 60),
      distance_mm: 6,
      name: "Arm",
    });
    await t.ok("slicerx_geom_extrude", {
      design: t.design,
      ...circle(3.4, 60, 60),
      frame: top(6),
      distance_mm: 6,
      operation: "cut",
    });
    await t.ok("slicerx_geom_extrude", {
      design: t.design,
      ...circle(3, 60, 60),
      distance_mm: 6,
      name: "Pin",
    });
    const r = await t.ok<Fit>("slicerx_geom_interference", {
      design: t.design,
      a: 0,
      b: 1,
    });
    expect(r.interferes).toBe(false);
    // round faces are drawn as facets, so the gap reads a little under 0.2 mm, within the 0.02 mm the tool text gives
    expect(r.clearance_mm).toBeLessThanOrEqual(0.2);
    expect(r.clearance_mm).toBeGreaterThan(0.18);
    const tight = await harness();
    await tight.ok("slicerx_geom_extrude", {
      design: tight.design,
      ...rect(30, 20, 60, 60),
      distance_mm: 6,
      name: "Arm",
    });
    await tight.ok("slicerx_geom_extrude", {
      design: tight.design,
      ...circle(3.4, 60, 60),
      frame: top(6),
      distance_mm: 6,
      operation: "cut",
    });
    await tight.ok("slicerx_geom_extrude", {
      design: tight.design,
      ...circle(3.6, 60, 60),
      distance_mm: 6,
      name: "Pin",
    });
    expect(
      (
        await tight.ok<Fit>("slicerx_geom_interference", {
          design: tight.design,
          a: 0,
          b: 1,
        })
      ).interferes,
    ).toBe(true);
  });

  it("refuses a part with itself or a part the design does not have, in plain words", async () => {
    const t = await harness();
    await t.box(10, 60, 60, "A");
    const self = await t.h.call("slicerx_geom_interference", {
      design: t.design,
      a: 0,
      b: 0,
    });
    expect(self.isError).toBe(true);
    expect(text(self)).toContain("a part does not interfere with itself");
    const missing = await t.h.call("slicerx_geom_interference", {
      design: t.design,
      a: 0,
      b: 3,
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("b: the design has 1 part");
  });
});

describe("a section at a plane, from geom.measure", () => {
  it("gives a cylinder its circle: about pi r squared, one region, one loop", async () => {
    const t = await harness();
    await t.ok("slicerx_geom_extrude", {
      design: t.design,
      ...circle(10, 60, 60),
      distance_mm: 20,
      name: "Rod",
    });
    const { section: r } = await t.ok<Cut>("slicerx_geom_measure", {
      design: t.design,
      section: { plane: { origin: [60, 60, 7.5], normal: [0, 0, 1] } },
    });
    expect(r).toMatchObject({ regions: 1, holes: 0 });
    // facets inside the circle: a little under 78.54 mm2, and an outline a little under 10 pi
    expect(r.area_mm2).toBeLessThanOrEqual(Math.PI * 25);
    expect(r.area_mm2 / (Math.PI * 25)).toBeGreaterThan(0.998);
    expect(r.outline_mm / (Math.PI * 10)).toBeGreaterThan(0.999);
    // the loop is in world mm on the plane, 5 mm from the axis
    for (const p of r.loops[0]!.outer) {
      expect(p[2]).toBeCloseTo(7.5, 6);
      expect(Math.hypot(p[0]! - 60, p[1]! - 60)).toBeCloseTo(5, 2);
    }
  });

  it("refuses a plane that misses the part, a zero normal and a section with a pick, in plain words", async () => {
    const t = await harness();
    await t.box(10, 60, 60, "A");
    const miss = await t.h.call("slicerx_geom_measure", {
      design: t.design,
      section: { plane: { origin: [0, 0, 50], normal: [0, 0, 1] } },
    });
    expect(miss.isError).toBe(true);
    expect(text(miss)).toContain(
      "the plane does not cut part 0 (A); give a point inside the part",
    );
    const zero = await t.h.call("slicerx_geom_measure", {
      design: t.design,
      section: { plane: { origin: [0, 0, 5], normal: [0, 0, 0] } },
    });
    expect(zero.isError).toBe(true);
    expect(text(zero)).toContain("give a direction, not zeros");
    const both = await t.h.call("slicerx_geom_measure", {
      design: t.design,
      a: { at: [60, 60, 10], normal: [0, 0, 1] },
      section: { plane: { origin: [60, 60, 5], normal: [0, 0, 1] } },
    });
    expect(text(both)).toContain("give either section or a and b, not both");
  });
});

// a box with one triangle taken out: open along three edges
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function openBox() {
  const positions = [
    0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0,
    10, 10,
  ];
  const indices = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2,
    3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ];
  return { positions, indices: indices.slice(3) };
}
function closedBox(x: number) {
  const b = openBox();
  return {
    positions: b.positions.map((v, k) => (k % 3 === 0 ? v + x : v)),
    indices: [0, 2, 1, ...b.indices],
  };
}
const files: CadFiles = {
  engine: false,
  call: async () => Promise.reject(new Error("no files here")),
  path: async (m) => m,
  stl: () => new Float32Array(),
};
const hostOf = (d: HostDesign): DesignHost =>
  ({
    get: () => d,
    list: () => [d],
    call: async () =>
      Promise.reject(new Error("an open part never reaches the engine")),
  }) as unknown as DesignHost;
async function refusal(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const d = {
    id: "d1",
    name: "Open",
    history: { version: 1, base: [], steps: [] },
    transform: IDENTITY,
    parts: [
      { name: "Lid", slot: 0, ...openBox() },
      { name: "Base", slot: 0, ...closedBox(20) },
    ],
    status: [],
    madeBy: {},
    redo: [],
  } as unknown as HostDesign;
  const tool = cadTools({ files, designs: hostOf(d) }).find(
    (t) => t.name === name,
  )!;
  return tool
    .run(
      tool.input.parse({ design: "d1", ...args }) as never,
      {} as ToolContext,
    )
    .then(
      () => "answered",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
}

describe("an open part", () => {
  it("is refused by the section, saying what is open", async () => {
    expect(
      await refusal("geom.measure", {
        section: { plane: { origin: [5, 5, 5], normal: [0, 0, 1] } },
      }),
    ).toBe(
      "section.part: part 0 (Lid) is not closed (3 open edges), so it has no inside to measure; repair it first (slicerx_geom_repair)",
    );
  });

  it("is refused by the interference check, saying what is open", async () => {
    expect(await refusal("geom.interference", { a: 1, b: 0 })).toBe(
      "b: part 0 (Lid) is not closed (3 open edges), so it has no inside to measure; repair it first (slicerx_geom_repair)",
    );
  });
});

describe("geom.measure without a section", () => {
  it("answers as it did before sections: two faces of a box", async () => {
    const t = await harness();
    await t.box(10, 60, 60, "A");
    const r = await t.h.call("slicerx_geom_measure", {
      design: t.design,
      a: { at: [60, 60, 10], normal: [0, 0, 1] },
      b: { at: [60, 60, 0], normal: [0, 0, -1] },
    });
    expect(r.isError, text(r)).toBeFalsy();
    // pinned from geom.measure 1.2.0, before sections
    expect(data(r)).toEqual({
      ok: true,
      summary:
        "Measured: distance 10 mm, center distance 10 mm, angle 180 degrees",
      output: {
        measurement: {
          angleDeg: 180,
          centerDistanceMm: 10.000000000000002,
          deltaMm: [0, 0, -10.000000000000002],
          distanceMm: 10.000000000000002,
          from: [60, 60, 10.000000000000002],
          parallel: true,
          to: [60, 60, 0],
        },
        a: {
          areaMm2: 100,
          kind: "plane",
          normal: [0, 0, 1],
          point: [60, 60, 10.000000000000002],
        },
        b: {
          areaMm2: 100,
          kind: "plane",
          normal: [0, 0, -1],
          point: [60, 60, 0],
        },
      },
    });
  });
});
