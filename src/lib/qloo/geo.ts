/**
 * Turn a heatmap cell (lat/lon) into a US state name.
 *
 * Why: the live US heatmap (checked 2026-10-21) returns geohash cells with lat/lon but no place
 * names, so "California" could never match "9q5c". The locality boundary option does return names,
 * but one call was ~160MB and often timed out, so it cannot run per request.
 *
 * How: each state has an approximate bounding box. Among the boxes that contain the point, pick
 * the one where the point sits most centrally (distance to the box centre, scaled by box size).
 * If no box contains it, take the nearest box centre. A short list of metro boxes (NYC, Chicago,
 * Portland...) is checked first, because those sit where state boxes overlap.
 *
 * Accuracy (2026-10-21): 330 of 334 points (98.8%) matched the state in Qloo's own locality names.
 * The metro boxes were tuned on those same points, so accuracy on unseen points may be lower;
 * borders stay approximate.
 */

// [name, minLat, maxLat, minLon, maxLon]
const BOXES: [string, number, number, number, number][] = [
  ["Alabama", 30.2, 35.0, -88.5, -84.9],
  ["Alaska", 51.2, 71.4, -179.2, -129.9],
  ["Arizona", 31.3, 37.0, -114.8, -109.0],
  ["Arkansas", 33.0, 36.5, -94.6, -89.6],
  ["California", 32.5, 42.0, -124.4, -114.1],
  ["Colorado", 37.0, 41.0, -109.1, -102.0],
  ["Connecticut", 40.95, 42.05, -73.73, -71.79],
  ["Delaware", 38.45, 39.84, -75.79, -75.05],
  ["District of Columbia", 38.79, 38.995, -77.12, -76.91],
  ["Florida", 24.4, 31.0, -87.6, -80.0],
  ["Georgia", 30.36, 35.0, -85.6, -80.84],
  ["Hawaii", 18.9, 22.25, -160.25, -154.8],
  ["Idaho", 42.0, 49.0, -117.24, -111.04],
  ["Illinois", 36.97, 42.51, -91.51, -87.5],
  ["Indiana", 37.77, 41.76, -88.1, -84.78],
  ["Iowa", 40.38, 43.5, -96.64, -90.14],
  ["Kansas", 37.0, 40.0, -102.05, -94.59],
  ["Kentucky", 36.5, 39.15, -89.57, -81.96],
  ["Louisiana", 28.93, 33.02, -94.04, -88.82],
  ["Maine", 43.06, 47.46, -71.08, -66.95],
  ["Maryland", 37.91, 39.72, -79.49, -75.05],
  ["Massachusetts", 41.24, 42.89, -73.51, -69.93],
  ["Michigan", 41.7, 48.3, -90.42, -82.41],
  ["Minnesota", 43.5, 49.38, -97.24, -89.49],
  ["Mississippi", 30.17, 35.0, -91.66, -88.1],
  ["Missouri", 35.99, 40.61, -95.77, -89.1],
  ["Montana", 44.36, 49.0, -116.05, -104.04],
  ["Nebraska", 40.0, 43.0, -104.05, -95.31],
  ["Nevada", 35.0, 42.0, -120.0, -114.04],
  ["New Hampshire", 42.7, 45.31, -72.56, -70.6],
  ["New Jersey", 38.93, 41.36, -75.56, -73.89],
  ["New Mexico", 31.33, 37.0, -109.05, -103.0],
  ["New York", 40.5, 45.02, -79.76, -71.86],
  ["North Carolina", 33.84, 36.59, -84.32, -75.46],
  ["North Dakota", 45.94, 49.0, -104.05, -96.55],
  ["Ohio", 38.4, 41.98, -84.82, -80.52],
  ["Oklahoma", 33.62, 37.0, -103.0, -94.43],
  ["Oregon", 41.99, 46.29, -124.57, -116.46],
  ["Pennsylvania", 39.72, 42.27, -80.52, -74.69],
  ["Rhode Island", 41.15, 42.02, -71.86, -71.12],
  ["South Carolina", 32.03, 35.22, -83.35, -78.54],
  ["South Dakota", 42.48, 45.94, -104.06, -96.44],
  ["Tennessee", 34.98, 36.68, -90.31, -81.65],
  ["Texas", 25.84, 36.5, -106.65, -93.51],
  ["Utah", 37.0, 42.0, -114.05, -109.04],
  ["Vermont", 42.73, 45.02, -73.44, -71.46],
  ["Virginia", 36.54, 39.47, -83.68, -75.24],
  ["Washington", 45.54, 49.0, -124.85, -116.92],
  ["West Virginia", 37.2, 40.64, -82.64, -77.72],
  ["Wisconsin", 42.49, 47.08, -92.89, -86.25],
  ["Wyoming", 41.0, 45.0, -111.06, -104.05],
  ["Puerto Rico", 17.88, 18.52, -67.27, -65.22],
  ["Guam", 13.23, 13.65, 144.6, 145.0],
];

// Checked first: metro areas that sit where state boxes overlap (big audiences live here, so a
// wrong label would be visible). Same [name, minLat, maxLat, minLon, maxLon] shape.
const OVERRIDES: [string, number, number, number, number][] = [
  ["New York", 40.49, 40.92, -74.26, -73.7], // New York City
  ["New York", 40.55, 41.2, -73.7, -71.85], // Long Island
  ["New York", 40.92, 41.4, -74.05, -73.62], // Westchester / Rockland
  ["Illinois", 41.46, 42.5, -88.4, -87.52], // Chicago area
  ["Missouri", 38.45, 38.85, -90.75, -90.18], // St. Louis
  ["Massachusetts", 42.03, 42.75, -73.5, -72.9], // Berkshires
  ["Pennsylvania", 40.3, 40.65, -80.25, -79.75], // Pittsburgh
  ["Oregon", 45.4, 45.605, -122.95, -122.4], // Portland (south of the Columbia)
  ["Washington", 45.605, 45.75, -122.75, -122.4], // Vancouver WA
];

function scaled(lat: number, lon: number, b: (typeof BOXES)[number]): number {
  const [, a, z, w, e] = b;
  const cy = (a + z) / 2;
  const cx = (w + e) / 2;
  return Math.hypot((lat - cy) / ((z - a) / 2), (lon - cx) / ((e - w) / 2));
}

export function stateOf(lat: number, lon: number): string {
  const metro = OVERRIDES.find(([, a, z, w, e]) => lat >= a && lat <= z && lon >= w && lon <= e);
  if (metro) return metro[0];
  const inside = BOXES.filter(([, a, z, w, e]) => lat >= a && lat <= z && lon >= w && lon <= e);
  if (inside.length) return inside.reduce((best, b) => (scaled(lat, lon, b) < scaled(lat, lon, best) ? b : best))[0];
  let best = BOXES[0];
  let bestD = Infinity;
  for (const b of BOXES) {
    const d = Math.hypot(lat - (b[1] + b[2]) / 2, (lon - (b[3] + b[4]) / 2) * Math.cos((lat * Math.PI) / 180));
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best[0];
}
