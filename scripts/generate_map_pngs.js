const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function createPng(width, height, rgbaBuffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    const combined = Buffer.concat([typeBuf, data]);
    const crcVal = zlib.crc32(combined);
    crc.writeUInt32BE(crcVal, 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 bits per channel
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const rawData = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    rawData[y * (stride + 1)] = 0; // None filter
    rgbaBuffer.copy(rawData, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const idatData = zlib.deflateSync(rawData, { level: 9 });
  const idat = makeChunk("IDAT", idatData);
  const ihdrChunk = makeChunk("IHDR", ihdr);
  const iendChunk = makeChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idat, iendChunk]);
}

function hexToRgba(hex) {
  const num = parseInt(hex.replace("#", ""), 16);
  return [
    (num >> 16) & 255,
    (num >> 8) & 255,
    num & 255,
    255
  ];
}

const PLOT_COLORS = [
  hexToRgba("#000000"),
  hexToRgba("#faf5eb"), // Plot 1 (warm cream linoleum)
  hexToRgba("#dbeafe"), // Plot 2 (soft sky blue)
  hexToRgba("#fef3c7"), // Plot 3 (soft warm amber)
  hexToRgba("#f3e8ff"), // Plot 4 (soft lavender)
  hexToRgba("#dcfce7"), // Plot 5 (soft mint)
  hexToRgba("#ffe4e6"), // Plot 6 (soft rose)
  hexToRgba("#e2e8f0"), // Plot 7 (soft cool slate)
  hexToRgba("#fce7f3"), // Plot 8 (soft pink)
  hexToRgba("#ccfbf1"), // Plot 9 (soft teal)
  hexToRgba("#ede9fe"), // Plot 10 (soft indigo)
  hexToRgba("#fed7aa"), // Plot 11 (soft peach)
  hexToRgba("#fef9c3"), // Plot 12 (soft yellow)
];

const COLOR_WALL = hexToRgba("#0f172a");
const COLOR_WATER = hexToRgba("#0284c7");
const COLOR_ROAD = hexToRgba("#475569");
const COLOR_PAVEMENT = hexToRgba("#94a3b8");
const COLOR_GRASS_1 = hexToRgba("#1e3a24");
const COLOR_GRASS_2 = hexToRgba("#25482e");
const COLOR_BUSH = hexToRgba("#14532d");
const COLOR_HELI = hexToRgba("#eab308");
const COLOR_WHITE = [255, 255, 255, 255];
const COLOR_BLACK = [0, 0, 0, 255];
const COLOR_START = hexToRgba("#22c55e");

function renderMapToPng(mapBuffer, scale = 3) {
  const width = 128 * scale;
  const height = 128 * scale;
  const imgBuf = Buffer.alloc(width * height * 4);

  function setPixel(px, py, rgba) {
    if (px < 0 || px >= width || py < 0 || py >= height) return;
    const idx = (py * width + px) * 4;
    imgBuf[idx] = rgba[0];
    imgBuf[idx + 1] = rgba[1];
    imgBuf[idx + 2] = rgba[2];
    imgBuf[idx + 3] = rgba[3];
  }

  function fillRect(x, y, w, h, rgba) {
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        setPixel(x + c, y + r, rgba);
      }
    }
  }

  const parcelOffset = 131106;
  const heliOffset = 163884;
  const camOffset = 163876;

  const heliX = mapBuffer.readUInt16LE(heliOffset) % 128;
  const heliY = Math.floor(mapBuffer.readUInt16LE(heliOffset) / 128);
  const camX = mapBuffer.readUInt16LE(camOffset) % 128;
  const camY = Math.floor(mapBuffer.readUInt16LE(camOffset) / 128);

  const plotsFound = new Set();
  let hospitalTiles = 0;

  // 1. Draw tiles
  for (let ty = 0; ty < 128; ty++) {
    for (let tx = 0; tx < 128; tx++) {
      const tIdx = ty * 128 + tx;
      const pDataIdx = 34 + tIdx * 8;
      const parcel = mapBuffer.readUInt16LE(parcelOffset + tIdx * 2);
      const isHospital = !(mapBuffer[pDataIdx + 7] & 16);
      const baseTile = mapBuffer[pDataIdx + 2];

      const px = tx * scale;
      const py = ty * scale;

      let color = COLOR_GRASS_1;
      if (isHospital && parcel > 0) {
        plotsFound.add(parcel);
        hospitalTiles++;
        color = PLOT_COLORS[parcel] || PLOT_COLORS[((parcel - 1) % (PLOT_COLORS.length - 1)) + 1];
      } else {
        if (baseTile >= 69 && baseTile <= 73) {
          color = COLOR_WATER;
        } else if ((baseTile >= 150 && baseTile <= 165) || (baseTile >= 120 && baseTile <= 135)) {
          color = COLOR_ROAD;
        } else if (baseTile >= 4 && baseTile <= 10 && baseTile % 2 === 0) {
          color = COLOR_BUSH;
        } else {
          color = ((tx + ty * 3) % 4 === 0) ? COLOR_GRASS_2 : COLOR_GRASS_1;
        }
      }

      fillRect(px, py, scale, scale, color);
    }
  }

  // 2. Draw walls
  for (let ty = 0; ty < 128; ty++) {
    for (let tx = 0; tx < 128; tx++) {
      const tIdx = ty * 128 + tx;
      const pDataIdx = 34 + tIdx * 8;
      const northWall = mapBuffer[pDataIdx + 3];
      const westWall = mapBuffer[pDataIdx + 4];

      const px = tx * scale;
      const py = ty * scale;

      if (northWall !== 0) {
        fillRect(px, py, scale, 1, COLOR_WALL);
      }
      if (westWall !== 0) {
        fillRect(px, py, 1, scale, COLOR_WALL);
      }
    }
  }

  // 3. Draw Heliport if present
  if (heliX > 0 && heliY > 0 && heliX < 128 && heliY < 128) {
    const hx = heliX * scale + Math.floor(scale / 2);
    const hy = heliY * scale + Math.floor(scale / 2);
    const radius = Math.floor(scale * 2.5);

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 <= radius * radius) {
          if (d2 >= (radius - 1) * (radius - 1)) {
            setPixel(hx + dx, hy + dy, COLOR_WHITE);
          } else {
            setPixel(hx + dx, hy + dy, COLOR_HELI);
          }
        }
      }
    }
    // Draw simple 'H' in center
    for (let dy = -3; dy <= 3; dy++) {
      setPixel(hx - 2, hy + dy, COLOR_BLACK);
      setPixel(hx + 2, hy + dy, COLOR_BLACK);
    }
    setPixel(hx - 1, hy, COLOR_BLACK);
    setPixel(hx, hy, COLOR_BLACK);
    setPixel(hx + 1, hy, COLOR_BLACK);
  }

  // 4. Draw Entrance Marker if present
  if (camX > 0 && camY > 0 && camX < 128 && camY < 128) {
    const cx = camX * scale + Math.floor(scale / 2);
    const cy = camY * scale + Math.floor(scale / 2);
    // Draw green diamond
    for (let d = -3; d <= 3; d++) {
      for (let w = -(3 - Math.abs(d)); w <= (3 - Math.abs(d)); w++) {
        setPixel(cx + w, cy + d, COLOR_START);
      }
    }
  }

  const pngBuffer = createPng(width, height, imgBuf);
  return {
    plotsCount: plotsFound.size,
    hospitalTiles,
    pngBuffer
  };
}

const MAP_LIST = [
  { id: "demo", name: "Town 1 (Oxpond)", desc: "Original starter hospital. Compact grounds with starting plot and helipad.", file: "build/stage/corsixth/Levels/demo.map" },
  { id: "avatar", name: "Avatar", desc: "Large metropolitan healthcare campus featuring 5 separate hospital plots.", file: "build/stage/corsixth/Levels/avatar.map" },
  { id: "confined_v5", name: "Confined", desc: "Challenging tight grounds across 4 compact plots requiring efficient layout.", file: "build/stage/corsixth/Levels/confined_v5.map" },
  { id: "finisham", name: "Finisham", desc: "Expansive hospital complex divided by a river with connecting bridges across 7 plots.", file: "build/stage/corsixth/Levels/finisham.map" },
  { id: "st.peter's", name: "St. Peter's", desc: "Sprawling classic compound with 7 distinct building wings and garden paths.", file: "build/stage/corsixth/Levels/st.peter's.map" },
  { id: "level1", name: "Level 1 - Original Campaign", desc: "The original Theme Hospital campaign level with standard town boundaries.", file: "build/stage/corsixth/Levels/demo.map" },
  { id: "four_corners", name: "Four Corners", desc: "4 large building quadrants separated by cross roads across 9 plots.", file: "build/stage/corsixth/Campaigns/Four Corners.map" },
  { id: "greyham_gardens", name: "Greyham Gardens", desc: "Scenic parkland hospital surrounded by gardens across 7 plots.", file: "build/stage/corsixth/Campaigns/Greyham Gardens.map" },
  { id: "royal_hospital", name: "Royal Hospital", desc: "Massive royal healthcare facility spanning 21 separate hospital plots.", file: "build/stage/corsixth/Campaigns/Royal Hospital.map" },
  { id: "snuffit_sands", name: "Snuffit Sands", desc: "Desert oasis regional hospital with 5 open plots.", file: "build/stage/corsixth/Campaigns/Snuffit Sands.map" },
  { id: "upper_pukington", name: "Upper Pukington", desc: "Suburban medical district with 7 spacious plots.", file: "build/stage/corsixth/Campaigns/Upper Pukington.map" },
  { id: "wishinwell", name: "Wishinwell", desc: "Mountain valley hospital complex with 7 plots.", file: "build/stage/corsixth/Campaigns/Wishinwell.map" },
  { id: "tufflook", name: "Tufflook", desc: "Industrial sector high-capacity medical center across 11 plots.", file: "build/stage/corsixth/Campaigns/Tufflook.map" },
];

const outDir = path.join(__dirname, "../dist/assets/maps");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const metadata = [];

for (const m of MAP_LIST) {
  const filePath = path.join(__dirname, "../", m.file);
  if (!fs.existsSync(filePath)) {
    console.warn("File missing:", filePath);
    continue;
  }
  const buf = fs.readFileSync(filePath);
  const res = renderMapToPng(buf, 3);
  const filename = `${m.id.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.png`;
  fs.writeFileSync(path.join(outDir, filename), res.pngBuffer);

  metadata.push({
    id: m.id,
    name: m.name,
    desc: m.desc,
    plotsCount: res.plotsCount,
    hospitalTiles: res.hospitalTiles,
    image: `assets/maps/${filename}`
  });
  console.log(`✓ Generated ${filename}: ${res.pngBuffer.length} bytes (${res.plotsCount} plots, ${res.hospitalTiles} hospital tiles)`);
}

fs.writeFileSync(path.join(outDir, "maps.json"), JSON.stringify(metadata, null, 2), "utf8");
console.log(`Successfully generated ${metadata.length} PNG map previews in ${outDir}`);
