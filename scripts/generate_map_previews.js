const fs = require("fs");
const path = require("path");

const MAP_DEFINITIONS = [
  { id: "demo", name: "Town 1 (Oxpond)", desc: "Original starter hospital. 1 main plot with compact grounds and helipad.", file: "build/stage/corsixth/Levels/demo.map" },
  { id: "avatar", name: "Avatar", desc: "Large metropolitan healthcare campus featuring 5 separate hospital plots.", file: "build/stage/corsixth/Levels/avatar.map" },
  { id: "confined_v5", name: "Confined", desc: "Challenging tight grounds across 4 compact plots requiring efficient layout.", file: "build/stage/corsixth/Levels/confined_v5.map" },
  { id: "finisham", name: "Finisham", desc: "Expansive hospital complex divided by a river with connecting bridges across 7 plots.", file: "build/stage/corsixth/Levels/finisham.map" },
  { id: "st.peter's", name: "St. Peter's", desc: "Sprawling classic compound with 7 distinct building wings and garden paths.", file: "build/stage/corsixth/Levels/st.peter's.map" },
  { id: "Four Corners", name: "Four Corners", desc: "4 large building quadrants separated by cross roads across 9 plots.", file: "build/stage/corsixth/Campaigns/Four Corners.map" },
  { id: "Greyham Gardens", name: "Greyham Gardens", desc: "Scenic parkland hospital surrounded by gardens across 7 plots.", file: "build/stage/corsixth/Campaigns/Greyham Gardens.map" },
  { id: "Royal Hospital", name: "Royal Hospital", desc: "Massive royal healthcare facility spanning 21 separate hospital plots.", file: "build/stage/corsixth/Campaigns/Royal Hospital.map" },
  { id: "Snuffit Sands", name: "Snuffit Sands", desc: "Desert oasis regional hospital with 5 open plots.", file: "build/stage/corsixth/Campaigns/Snuffit Sands.map" },
  { id: "Upper Pukington", name: "Upper Pukington", desc: "Suburban medical district with 7 spacious plots.", file: "build/stage/corsixth/Campaigns/Upper Pukington.map" },
  { id: "Wishinwell", name: "Wishinwell", desc: "Mountain valley hospital complex with 7 plots.", file: "build/stage/corsixth/Campaigns/Wishinwell.map" },
  { id: "Tufflook", name: "Tufflook", desc: "Industrial sector high-capacity medical center across 11 plots.", file: "build/stage/corsixth/Campaigns/Tufflook.map" },
];

function generateSvgFromMap(mapBuffer, mapDef) {
  const parcelOffset = 131106;
  const heliOffset = 163884;
  const camOffset = 163876;

  const heliX = mapBuffer.readUInt16LE(heliOffset) % 128;
  const heliY = Math.floor(mapBuffer.readUInt16LE(heliOffset) / 128);
  const camX = mapBuffer.readUInt16LE(camOffset) % 128;
  const camY = Math.floor(mapBuffer.readUInt16LE(camOffset) / 128);

  const plotPalette = [
    "#000000",
    "#fdfbf7", // Plot 1 (Starting hospital: cream hospital linoleum)
    "#e0f2fe", // Plot 2: soft cyan
    "#fef3c7", // Plot 3: soft amber
    "#f3e8ff", // Plot 4: soft purple
    "#dcfce7", // Plot 5: soft mint
    "#ffe4e6", // Plot 6: soft rose
    "#e2e8f0", // Plot 7: soft slate
    "#fce7f3", // Plot 8: soft pink
    "#ccfbf1", // Plot 9: soft teal
    "#ede9fe", // Plot 10: lavender
    "#fef9c3", // Plot 11: yellow
    "#fed7aa", // Plot 12: orange
    "#c7d2fe", // Plot 13: indigo
  ];

  let rects = [];
  let walls = [];
  let plotsFound = new Set();
  let totalHospitalTiles = 0;

  // Let's identify the bounding box of content (hospital + roads) to frame it nicely or use 128x128
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      const tIdx = y * 128 + x;
      const pDataIdx = 34 + tIdx * 8;
      const parcel = mapBuffer.readUInt16LE(parcelOffset + tIdx * 2);
      const isHospital = !(mapBuffer[pDataIdx + 7] & 16);
      const baseTile = mapBuffer[pDataIdx + 2];
      const northWall = mapBuffer[pDataIdx + 3];
      const westWall = mapBuffer[pDataIdx + 4];

      const px = x * 4;
      const py = y * 4;

      if (isHospital && parcel > 0) {
        plotsFound.add(parcel);
        totalHospitalTiles++;
        const color = plotPalette[parcel] || plotPalette[((parcel - 1) % (plotPalette.length - 1)) + 1];
        rects.push(`<rect x="${px}" y="${py}" width="4" height="4" fill="${color}"/>`);
      } else {
        // Outdoors
        if (baseTile >= 69 && baseTile <= 73) {
          // Water / River
          rects.push(`<rect x="${px}" y="${py}" width="4" height="4" fill="#0284c7"/>`);
        } else if ((baseTile >= 150 && baseTile <= 165) || (baseTile >= 120 && baseTile <= 135)) {
          // Pavement / Road
          rects.push(`<rect x="${px}" y="${py}" width="4" height="4" fill="#64748b"/>`);
        } else if (baseTile === 4 || baseTile === 6 || baseTile === 8 || baseTile === 10) {
          // Darker lawn / bushes
          rects.push(`<rect x="${px}" y="${py}" width="4" height="4" fill="#1b4332"/>`);
        } else {
          // Standard grass (Theme Hospital green)
          const shade = ((x + y * 3) % 5 === 0) ? "#235338" : "#2d6a4f";
          rects.push(`<rect x="${px}" y="${py}" width="4" height="4" fill="${shade}"/>`);
        }
      }

      if (northWall !== 0) {
        walls.push(`<line x1="${px}" y1="${py}" x2="${px + 4}" y2="${py}" stroke="#1e293b" stroke-width="1.8"/>`);
      }
      if (westWall !== 0) {
        walls.push(`<line x1="${px}" y1="${py}" x2="${px}" y2="${py + 4}" stroke="#1e293b" stroke-width="1.8"/>`);
      }
    }
  }

  // Heliport marker
  let heliSvg = "";
  if (heliX > 0 && heliY > 0 && heliX < 128 && heliY < 128) {
    const hx = heliX * 4 + 2;
    const hy = heliY * 4 + 2;
    heliSvg = `
      <circle cx="${hx}" cy="${hy}" r="10" fill="#eab308" stroke="#ffffff" stroke-width="2"/>
      <text x="${hx}" y="${hy + 3.8}" font-size="9" font-family="Arial, sans-serif" font-weight="900" fill="#0f172a" text-anchor="middle">H</text>
    `;
  }

  // Entrance / start marker
  let entranceSvg = "";
  if (camX > 0 && camY > 0 && camX < 128 && camY < 128) {
    const cx = camX * 4 + 2;
    const cy = camY * 4 + 2;
    entranceSvg = `
      <polygon points="${cx},${cy - 8} ${cx + 6},${cy + 4} ${cx - 6},${cy + 4}" fill="#22c55e" stroke="#ffffff" stroke-width="1.5"/>
    `;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%" shape-rendering="crispEdges">
    <rect width="512" height="512" fill="#1b4332"/>
    <g id="tiles">${rects.join("")}</g>
    <g id="walls" shape-rendering="auto">${walls.join("")}</g>
    <g id="markers" shape-rendering="auto">
      ${heliSvg}
      ${entranceSvg}
    </g>
  </svg>`;

  return {
    id: mapDef.id,
    name: mapDef.name,
    desc: mapDef.desc,
    plotsCount: plotsFound.size,
    hospitalTiles: totalHospitalTiles,
    svg
  };
}

const outDir = path.join(__dirname, "../dist/assets/maps");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const mapMetadata = [];

for (const m of MAP_DEFINITIONS) {
  const p = path.join(__dirname, "../", m.file);
  if (!fs.existsSync(p)) {
    console.warn("File missing:", p);
    continue;
  }
  const buf = fs.readFileSync(p);
  const result = generateSvgFromMap(buf, m);
  const svgFilename = `${m.id.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.svg`;
  fs.writeFileSync(path.join(outDir, svgFilename), result.svg, "utf8");

  mapMetadata.push({
    id: m.id,
    name: m.name,
    desc: m.desc,
    plotsCount: result.plotsCount,
    hospitalTiles: result.hospitalTiles,
    svgFile: `assets/maps/${svgFilename}`
  });
  console.log(`✓ Generated preview for ${m.name}: ${svgFilename} (${result.plotsCount} plots, ${result.hospitalTiles} tiles)`);
}

fs.writeFileSync(path.join(outDir, "maps.json"), JSON.stringify(mapMetadata, null, 2), "utf8");
console.log(`Successfully generated ${mapMetadata.length} map previews in ${outDir}`);
