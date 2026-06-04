import type { GalleryItem } from "@/types";
import {
  getCachedThumbnail,
  storeThumbnail,
} from "@/lib/thumbnail-db";
import { normalizeExtension } from "@/lib/media";

const THUMBNAIL_MAX_WIDTH = 480;
const THUMBNAIL_QUALITY = 0.8;

// ---------------------------------------------------------------------------
// Concurrency-limited queue – prevents dozens of <video> / fetch operations
// from running at the same time which would starve the main thread and cause
// scroll jank.
// ---------------------------------------------------------------------------
const MAX_CONCURRENT = 5;
let running = 0;
const queue: Array<() => void> = [];

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      running++;
      fn().then(resolve, reject).finally(() => {
        running--;
        const next = queue.shift();
        if (next) next();
      });
    };

    if (running < MAX_CONCURRENT) {
      run();
    } else {
      queue.push(run);
    }
  });
}

// Prevents duplicate concurrent generation for the same key
const inFlight = new Map<string, Promise<Blob | null>>();

function cacheKey(
  credentialId: string,
  bucket: string,
  key: string
): string {
  return `${credentialId}|${bucket}|${key}`;
}

async function generateSvgThumbnail(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch SVG: ${response.status}`);
  }
  const blob = await response.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read SVG blob"));
    reader.readAsDataURL(blob);
  });

  const img = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load SVG as image"));
  });
  img.src = dataUrl;
  await loaded;

  // Use intrinsic dimensions or fall back to a default
  const naturalW = img.naturalWidth || 300;
  const naturalH = img.naturalHeight || 150;
  const scale = Math.min(1, THUMBNAIL_MAX_WIDTH / naturalW);
  const width = Math.round(naturalW * scale);
  const height = Math.round(naturalH * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to get 2D context");
  }
  ctx.drawImage(img, 0, 0, width, height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Canvas toBlob failed"))),
      "image/webp",
      THUMBNAIL_QUALITY,
    );
  });
}

async function generateImageThumbnail(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  const scale = Math.min(1, THUMBNAIL_MAX_WIDTH / bitmap.width);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to get 2D context");
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  return canvas.convertToBlob({ type: "image/webp", quality: THUMBNAIL_QUALITY });
}

async function generateVideoThumbnail(url: string): Promise<Blob> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.preload = "metadata";
  video.muted = true;

  const loaded = new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () =>
      reject(new Error("Failed to load video for thumbnail"));
  });

  video.src = url;
  await loaded;

  // Seek to 1 s (or mid-point if the clip is shorter than 2 s).
  // The browser fetches only the bytes it needs via Range requests.
  const seekTarget = Math.min(1, video.duration * 0.5);
  await new Promise<void>((resolve, reject) => {
    video.onseeked = () => resolve();
    video.onerror = () => reject(new Error("Failed to seek video"));
    video.currentTime = seekTarget;
  });

  // Capture the current frame to a canvas
  const scale = Math.min(1, THUMBNAIL_MAX_WIDTH / video.videoWidth);
  const width = Math.round(video.videoWidth * scale);
  const height = Math.round(video.videoHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to get 2D context");
  }
  ctx.drawImage(video, 0, 0, width, height);

  // Release the video element so the browser can free network / decoder resources
  video.src = "";
  video.load();

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Canvas toBlob failed")),
      "image/webp",
      THUMBNAIL_QUALITY,
    );
  });
}

/**
 * Returns a cached or freshly-generated thumbnail blob for a gallery item.
 * Deduplicates concurrent calls for the same key.
 * Returns null if generation is not applicable or fails.
 */
export async function getOrGenerateThumbnail(
  item: GalleryItem,
  credentialId: string,
  bucket: string
): Promise<Blob | null> {
  if (item.isFolder || !item.mediaType || !item.previewUrl) {
    return null;
  }

  const ck = cacheKey(credentialId, bucket, item.key);

  // Deduplicate in-flight requests
  const existing = inFlight.get(ck);
  if (existing) return existing;

  // Everything goes through the queue so items are processed in the order
  // they were requested (top-to-bottom in the gallery). The IndexedDB cache
  // check is inside the queue so that awaiting it doesn't shuffle the order.
  const promise = enqueue(async (): Promise<Blob | null> => {
    try {
      // Check IndexedDB cache first
      try {
        const cached = await getCachedThumbnail(
          credentialId,
          bucket,
          item.key,
          item.lastModified,
          item.size,
        );
        if (cached) return cached;
      } catch {
        // IndexedDB unavailable — proceed to generate
      }

      const ext = normalizeExtension(item.extension);
      const blob = item.isVideo
        ? await generateVideoThumbnail(item.previewUrl!)
        : ext === "svg"
          ? await generateSvgThumbnail(item.previewUrl!)
          : await generateImageThumbnail(item.previewUrl!);

      try {
        await storeThumbnail(
          credentialId,
          bucket,
          item.key,
          item.lastModified,
          item.size,
          blob
        );
      } catch {
        // Storage failure is non-fatal
      }

      return blob;
    } catch {
      return null;
    } finally {
      inFlight.delete(ck);
    }
  });

  inFlight.set(ck, promise);
  return promise;
}
