import { describe, expect, it } from "vitest";
import {
  centroid,
  computeMassMetrics,
  floorAreaRatio,
  isClockwise,
  isSimplePolygon,
  netArea,
  normaliseWinding,
  perimeter,
  pointInPolygon,
  polygonArea,
  resolveStoryHeights,
  signedArea,
  storyElevations,
  validateProfile,
  type Point2,
} from "./geometry.js";

/** 20 x 10 rectangle, counter-clockwise. */
const RECT: Point2[] = [
  [0, 0],
  [20, 0],
  [20, 10],
  [0, 10],
];

/** 4 x 4 opening centred in RECT. */
const HOLE: Point2[] = [
  [8, 3],
  [12, 3],
  [12, 7],
  [8, 7],
];

describe("polygon measurement", () => {
  it("computes area with the shoelace formula", () => {
    expect(polygonArea(RECT)).toBe(200);
  });

  it("computes area of a non-convex outline", () => {
    // L-shape: 10x10 square with a 5x5 bite taken out.
    const shape: Point2[] = [
      [0, 0],
      [10, 0],
      [10, 5],
      [5, 5],
      [5, 10],
      [0, 10],
    ];
    expect(polygonArea(shape)).toBe(75);
  });

  it("signs area by winding direction", () => {
    expect(signedArea(RECT)).toBeGreaterThan(0);
    expect(signedArea([...RECT].reverse())).toBeLessThan(0);
    expect(isClockwise([...RECT].reverse())).toBe(true);
  });

  it("normalises winding without reversing an already-correct ring", () => {
    expect(normaliseWinding(RECT)).toBe(RECT);
    expect(normaliseWinding([...RECT].reverse())).toEqual(RECT);
  });

  it("computes perimeter", () => {
    expect(perimeter(RECT)).toBe(60);
  });

  it("returns zero area for a degenerate ring", () => {
    expect(polygonArea([[0, 0]])).toBe(0);
    expect(perimeter([])).toBe(0);
  });

  describe("centroid", () => {
    it("finds the centre of a rectangle", () => {
      expect(centroid(RECT)).toEqual([10, 5]);
    });

    it("uses the area centroid, not the vertex average", () => {
      // Extra vertices bunched along one edge drag the vertex average but not the area centroid.
      const weighted: Point2[] = [
        [0, 0],
        [5, 0],
        [10, 0],
        [15, 0],
        [20, 0],
        [20, 10],
        [0, 10],
      ];
      const [cx] = centroid(weighted);
      expect(cx).toBeCloseTo(10, 6);
    });

    it("falls back to the vertex average for a zero-area ring", () => {
      const line: Point2[] = [
        [0, 0],
        [10, 0],
        [20, 0],
      ];
      expect(centroid(line)).toEqual([10, 0]);
    });
  });

  it("subtracts holes from the net area", () => {
    expect(netArea(RECT, [HOLE])).toBe(200 - 16);
  });
});

describe("point in polygon", () => {
  it("detects inside and outside", () => {
    expect(pointInPolygon([10, 5], RECT)).toBe(true);
    expect(pointInPolygon([25, 5], RECT)).toBe(false);
    expect(pointInPolygon([-1, -1], RECT)).toBe(false);
  });
});

describe("self-intersection", () => {
  it("accepts a simple ring", () => {
    expect(isSimplePolygon(RECT)).toBe(true);
  });

  it("rejects a bow-tie", () => {
    // The shoelace formula returns a plausible number for this, which is exactly the danger.
    const bowtie: Point2[] = [
      [0, 0],
      [10, 10],
      [10, 0],
      [0, 10],
    ];
    expect(isSimplePolygon(bowtie)).toBe(false);
  });

  it("does not treat adjacent edges sharing a vertex as intersecting", () => {
    const triangle: Point2[] = [
      [0, 0],
      [10, 0],
      [5, 8],
    ];
    expect(isSimplePolygon(triangle)).toBe(true);
  });

  it("rejects fewer than three points", () => {
    expect(
      isSimplePolygon([
        [0, 0],
        [1, 1],
      ]),
    ).toBe(false);
  });
});

describe("validateProfile", () => {
  it("passes a valid outline", () => {
    expect(validateProfile(RECT, [HOLE])).toEqual([]);
  });

  it("reports too few points and stops", () => {
    const issues = validateProfile([
      [0, 0],
      [1, 1],
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("too-few-points");
  });

  it("reports a self-intersecting outline", () => {
    const issues = validateProfile([
      [0, 0],
      [10, 10],
      [10, 0],
      [0, 10],
    ]);
    expect(issues.map((i) => i.code)).toContain("self-intersecting");
  });

  it("reports a zero-area outline", () => {
    const issues = validateProfile([
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
    expect(issues.map((i) => i.code)).toContain("zero-area");
  });

  it("reports a hole that escapes the outline", () => {
    const outside: Point2[] = [
      [30, 3],
      [34, 3],
      [34, 7],
      [30, 7],
    ];
    const issues = validateProfile(RECT, [outside]);
    expect(issues[0]?.code).toBe("hole-outside-outer");
    expect(issues[0]?.holeIndex).toBe(0);
  });
});

describe("story layout", () => {
  it("accumulates elevations", () => {
    expect(storyElevations([4, 3, 3])).toEqual([0, 4, 7]);
  });

  it("honours a base elevation", () => {
    expect(storyElevations([3, 3], 10)).toEqual([10, 13]);
  });

  describe("resolveStoryHeights", () => {
    it("expands a uniform height", () => {
      expect(resolveStoryHeights(3, undefined, 3.5)).toEqual([3.5, 3.5, 3.5]);
    });

    it("uses supplied per-story heights", () => {
      expect(resolveStoryHeights(3, [5, 3, 3])).toEqual([5, 3, 3]);
    });

    it("pads a short heights array with the last known height", () => {
      // Mid-edit the count often outruns the heights array; refusing to compute would make the
      // tool unusable while typing.
      expect(resolveStoryHeights(4, [5, 3])).toEqual([5, 3, 3, 3]);
    });

    it("ignores non-positive heights", () => {
      expect(resolveStoryHeights(3, [4, 0, -2])).toEqual([4, 4, 4]);
    });
  });
});

describe("computeMassMetrics", () => {
  it("computes the simple case", () => {
    const result = computeMassMetrics({ outer: RECT, storyHeights: [3, 3, 3] });

    expect(result.footprintArea).toBe(200);
    expect(result.grossFloorArea).toBe(600);
    expect(result.volume).toBe(1800);
    expect(result.height).toBe(9);
    expect(result.storyCount).toBe(3);
  });

  it("subtracts a courtyard from every story", () => {
    const result = computeMassMetrics({ outer: RECT, holes: [HOLE], storyHeights: [3, 3] });

    expect(result.footprintArea).toBe(184);
    expect(result.grossFloorArea).toBe(368);
    expect(result.volume).toBe(1104);
  });

  it("handles a taller ground floor", () => {
    const result = computeMassMetrics({ outer: RECT, storyHeights: [5, 3, 3] });

    expect(result.height).toBe(11);
    expect(result.volume).toBe(200 * 11);
    expect(result.stories.map((s) => s.elevation)).toEqual([0, 5, 8]);
  });

  it("excludes plant levels from GFA but not from volume", () => {
    const result = computeMassMetrics({
      outer: RECT,
      storyHeights: [3, 3, 3],
      excludedStories: [2],
    });

    expect(result.grossFloorArea).toBe(400);
    // The plant level still occupies space, so it still counts towards volume.
    expect(result.volume).toBe(1800);
  });

  it("respects a per-story setback", () => {
    const setback: Point2[] = [
      [2, 2],
      [18, 2],
      [18, 8],
      [2, 8],
    ];
    const result = computeMassMetrics({
      outer: RECT,
      storyHeights: [3, 3],
      storyOutlines: { 1: setback },
    });

    expect(result.stories[1]?.area).toBe(96);
    // The GFA must reflect the setback rather than footprint x storeys.
    expect(result.grossFloorArea).toBe(200 + 96);
    expect(result.volume).toBe(600 + 288);
  });

  it("uses the topmost story for the roof, not the footprint", () => {
    const setback: Point2[] = [
      [2, 2],
      [18, 2],
      [18, 8],
      [2, 8],
    ];
    const stepped = computeMassMetrics({
      outer: RECT,
      storyHeights: [3, 3],
      storyOutlines: { 1: setback },
    });
    const straight = computeMassMetrics({ outer: RECT, storyHeights: [3, 3] });

    expect(stepped.envelopeArea).toBeLessThan(straight.envelopeArea);
  });

  it("includes hole perimeter in the envelope", () => {
    const withHole = computeMassMetrics({ outer: RECT, holes: [HOLE], storyHeights: [3] });
    const withoutHole = computeMassMetrics({ outer: RECT, storyHeights: [3] });

    // A courtyard adds facade even though it removes floor area.
    expect(withHole.stories[0]?.perimeter).toBeGreaterThan(withoutHole.stories[0]?.perimeter ?? 0);
  });

  it("handles a mass with no stories", () => {
    const result = computeMassMetrics({ outer: RECT, storyHeights: [] });

    expect(result.grossFloorArea).toBe(0);
    expect(result.volume).toBe(0);
    expect(result.height).toBe(0);
  });
});

describe("floorAreaRatio", () => {
  it("divides GFA by site area", () => {
    expect(floorAreaRatio(600, 200)).toBe(3);
  });

  it("is undefined without a site area", () => {
    expect(floorAreaRatio(600, undefined)).toBeUndefined();
    expect(floorAreaRatio(600, 0)).toBeUndefined();
  });
});
