/** Compact, truthful placement reports for MCP; full geometry stays in ZIP metadata. */
const pick = (object, keys) => Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, object[key]]));
const thin = (points, maximum) => !Array.isArray(points) || points.length <= maximum ? points : Array.from({length: maximum}, (_, i) => points[Math.round(i * (points.length - 1) / (maximum - 1))]);
const clean = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'number' && Number.isFinite(item) ? Math.round(item * 1000) / 1000 : item));

export function compactLayoutReport(layout, kind) {
  if (!layout) return null;
  if (kind !== 'map') {
    const report = {...layout, reportFormat: 'village-foundry-layout', reportVersion: 1};
    if (report.walkable?.rows) report.walkable = {...pick(report.walkable, ['cellSize', 'width', 'depth', 'origin', 'legend', 'mainAisleWidth', 'mainAisleClear', 'method']), gridInDownload: true};
    return clean(report);
  }
  const report = {
    reportFormat: 'village-foundry-layout', reportVersion: 1,
    ...pick(layout, ['style', 'landform', 'sea', 'landArea', 'requestedHouseCount', 'actualHouseCount', 'visibleHouseCount', 'placementWarnings', 'bridges', 'coastalAccess']),
    buildings: (layout.buildings || []).map(building => pick(building, ['id', 'seed', 'x', 'z', 'rotationDegrees', 'params', 'interior', 'entrance', 'footprint'])),
    paths: (layout.paths || []).map(path => ({...pick(path, ['id', 'width', 'kind', 'surface']), points: thin(path.points, 32)})),
    coastline: thin(layout.coastline, 64),
    decorationCounts: Object.fromEntries(['plots', 'fencePaths', 'gardens', 'trees', 'props', 'groves'].map(key => [key, layout[key]?.length || 0])),
    walkable: {...pick(layout.walkable, ['cellSize', 'width', 'depth', 'origin', 'legend']), gridInDownload: true},
    note: 'Paths and coastline are simplified for this report. The downloaded map recipe and village bundle contain complete paths, decorations, and the walkability grid.'
  };
  return clean(report);
}
