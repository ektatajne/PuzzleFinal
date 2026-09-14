import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";

// Load environment variables
dotenv.config();

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  process.exit(1);
}

if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as any).WebSocket = class {};
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

const BUCKET_NAME = "puzzle-images";
const TARGET_SIZE = 900;
const SUPPORTED_GRID_SIZES = [2, 3, 4, 5, 6, 7, 8] as const;

interface PuzzleDef {
  file: string;
  slug: string;
  name: string;
}

const PUZZLES: PuzzleDef[] = [
  { file: "image_001.svg", slug: "cosmic-fox", name: "Cosmic Fox" },
  { file: "image_002.svg", slug: "futuristic-city", name: "Futuristic City" },
  { file: "image_003.svg", slug: "space-explorer", name: "Space Explorer" },
  { file: "image_004.svg", slug: "neon-cyberpunk", name: "Neon Cyberpunk" },
  { file: "image_005.svg", slug: "abstract-geometry", name: "Abstract Geometry" },
];

/** Store base64 data for embedded bundle: slug -> gridSize -> pieceId -> base64 */
const embeddedData: Record<string, Record<number, Record<number, string>>> = {};

async function seedPuzzles() {
  console.log("🧩 Starting Fuzal Full Puzzle Pre-Generation & Storage Seed Process...");

  // Ensure storage bucket exists
  const { data: buckets, error: bucketError } = await supabase.storage.listBuckets();
  if (bucketError) {
    console.error("Failed to list buckets:", bucketError.message);
  } else if (!buckets.find((b) => b.id === BUCKET_NAME)) {
    console.log(`Creating bucket '${BUCKET_NAME}'...`);
    const { error: createError } = await supabase.storage.createBucket(BUCKET_NAME, {
      public: true,
      allowedMimeTypes: ["image/webp", "image/png", "image/jpeg"],
    });
    if (createError) console.error("Error creating bucket:", createError.message);
  }

  for (const puzzle of PUZZLES) {
    console.log(`\n🎨 Processing puzzle: ${puzzle.name} (${puzzle.slug})...`);
    embeddedData[puzzle.slug] = {};
    const srcPath = path.join(process.cwd(), "public", "images", puzzle.file);

    let srcBuffer: Buffer;
    try {
      srcBuffer = await fs.readFile(srcPath);
    } catch (e) {
      console.warn(`Source file not found at ${srcPath}, skipping.`);
      continue;
    }

    // 1. Render canonical master 900x900 square image as WebP
    const masterWebPBuffer = await sharp(srcBuffer, { density: 200 })
      .resize(TARGET_SIZE, TARGET_SIZE, { fit: "cover" })
      .webp({ quality: 90 })
      .toBuffer();

    // 2. Upload master original image
    const originalPath = `${puzzle.slug}/original.webp`;
    const { error: origUploadErr } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(originalPath, masterWebPBuffer, {
        contentType: "image/webp",
        upsert: true,
      });

    if (origUploadErr) {
      console.error(`Failed to upload ${originalPath}:`, origUploadErr.message);
      continue;
    }
    console.log(`  ✓ Uploaded original: ${originalPath}`);

    const masterSharp = sharp(masterWebPBuffer);

    // 3. Pre-generate all pieces for all 7 supported sizes: 2x2, 3x3, 4x4, 5x5, 6x6, 7x7, 8x8
    for (const N of SUPPORTED_GRID_SIZES) {
      embeddedData[puzzle.slug][N] = {};
      const totalPieces = N * N;
      console.log(`  ✂️ Slicing ${N}x${N} (${totalPieces} pieces)...`);

      const uploadTasks: Promise<void>[] = [];

      for (let pieceId = 0; pieceId < totalPieces; pieceId++) {
        const col = pieceId % N;
        const row = Math.floor(pieceId / N);

        const x0 = Math.floor((col * TARGET_SIZE) / N);
        const x1 = Math.floor(((col + 1) * TARGET_SIZE) / N);
        const y0 = Math.floor((row * TARGET_SIZE) / N);
        const y1 = Math.floor(((row + 1) * TARGET_SIZE) / N);
        const extractWidth = x1 - x0;
        const extractHeight = y1 - y0;

        const tileBuffer = await masterSharp
          .clone()
          .extract({
            left: x0,
            top: y0,
            width: extractWidth,
            height: extractHeight,
          })
          .webp({ quality: 90 })
          .toBuffer();

        const pieceNumStr = String(pieceId).padStart(2, "0");
        const gridPiecePath = `${puzzle.slug}/pieces/${N}x${N}/${pieceNumStr}.webp`;

        // Store in embedded data bundle (for 2x2, 3x3, 4x4 fast path)
        if (N <= 4) {
          embeddedData[puzzle.slug][N][pieceId] = `data:image/webp;base64,${tileBuffer.toString("base64")}`;
        }

        // Upload to grid-specific path in Supabase Storage
        uploadTasks.push(
          supabase.storage
            .from(BUCKET_NAME)
            .upload(gridPiecePath, tileBuffer, {
              contentType: "image/webp",
              upsert: true,
            })
            .then(({ error }) => {
              if (error) console.error(`  ✗ Upload failed: ${gridPiecePath}`, error.message);
            }),
        );

        // If N=4, ALSO upload to flat path `${puzzle.slug}/pieces/${pieceNumStr}.webp`
        // so legacy/flat paths map to the 16-piece configuration
        if (N === 4) {
          const flatPiecePath = `${puzzle.slug}/pieces/${pieceNumStr}.webp`;
          uploadTasks.push(
            supabase.storage
              .from(BUCKET_NAME)
              .upload(flatPiecePath, tileBuffer, {
                contentType: "image/webp",
                upsert: true,
              })
              .then(({ error }) => {
                if (error) console.error(`  ✗ Flat upload failed: ${flatPiecePath}`, error.message);
              }),
          );
        }
      }

      await Promise.all(uploadTasks);
      console.log(`  ✓ Uploaded ${totalPieces} tiles for ${N}x${N}`);
    }

    // 4. Upsert row into puzzle_images table
    const { data: existingRows } = await supabase
      .from("puzzle_images")
      .select("id")
      .eq("name", puzzle.name)
      .limit(1);

    if (existingRows && existingRows.length > 0) {
      await supabase
        .from("puzzle_images")
        .update({
          storage_path: puzzle.slug,
          mime_type: "image/webp",
          width: TARGET_SIZE,
          height: TARGET_SIZE,
          grid_rows: 4,
          grid_columns: 4,
          active: true,
        })
        .eq("id", existingRows[0].id);
      console.log(`  ✓ Updated puzzle_images row (${existingRows[0].id})`);
    } else {
      const { data: inserted, error: insertErr } = await supabase
        .from("puzzle_images")
        .insert({
          name: puzzle.name,
          storage_path: puzzle.slug,
          mime_type: "image/webp",
          width: TARGET_SIZE,
          height: TARGET_SIZE,
          grid_rows: 4,
          grid_columns: 4,
          active: true,
        })
        .select("id")
        .single();

      if (insertErr) {
        console.error(`Failed to insert puzzle_images row:`, insertErr.message);
      } else {
        console.log(`  ✓ Inserted new puzzle_images row (${inserted?.id})`);
      }
    }
  }

  // 5. Generate embedded TypeScript bundle: src/lib/game/puzzlePiecesData.ts
  const bundlePath = path.join(process.cwd(), "src", "lib", "game", "puzzlePiecesData.ts");
  const tsContent = `/**
 * Pre-generated WebP puzzle pieces bundle.
 * Provides 0ms instant serving without runtime image processing or libvips dependency.
 * Auto-generated by scripts/seed-puzzles.ts.
 */

export const EMBEDDED_PIECES: Record<
  string,
  Record<number, Record<number, string>>
> = ${JSON.stringify(embeddedData, null, 2)};

export function getEmbeddedPieceDataUrl(
  slug: string,
  gridSize: number,
  pieceId: number,
): string | null {
  return EMBEDDED_PIECES[slug]?.[gridSize]?.[pieceId] ?? null;
}

export function getEmbeddedPieceBuffer(
  slug: string,
  gridSize: number,
  pieceId: number,
): Buffer | null {
  const dataUrl = getEmbeddedPieceDataUrl(slug, gridSize, pieceId);
  if (!dataUrl) return null;
  const base64 = dataUrl.replace(/^data:image\\/webp;base64,/, "");
  return Buffer.from(base64, "base64");
}

export function getEmbeddedAllPieces(
  slug: string,
  gridSize: number,
): Record<number, string> | null {
  const pieces = EMBEDDED_PIECES[slug]?.[gridSize];
  if (!pieces) return null;
  const total = gridSize * gridSize;
  if (Object.keys(pieces).length < total) return null;
  return pieces;
}

/** Legacy 3x3 helper for backward compatibility */
export function getPieceBuffer(slug: string, pieceId: number): Buffer | null {
  return getEmbeddedPieceBuffer(slug, 3, pieceId);
}

export function getAllPiecesForSlug(slug: string): Record<number, string> | null {
  return getEmbeddedAllPieces(slug, 3);
}
`;

  await fs.writeFile(bundlePath, tsContent, "utf-8");
  console.log(`\n🎉 Pre-generated embedded bundle saved to: ${bundlePath}`);
  console.log("🎉 All puzzle images and pieces successfully seeded into Supabase Storage!");
}

seedPuzzles().catch((err) => {
  console.error("Seed script failed:", err);
  process.exit(1);
});
