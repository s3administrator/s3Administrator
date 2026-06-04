const DB_NAME = "s3admin-thumbnails";
const DB_VERSION = 1;
const STORE_NAME = "thumbnails";
const MAX_AGE_DAYS = 30;

interface ThumbnailRecord {
  credentialId: string;
  bucket: string;
  key: string;
  lastModified: string;
  size: number;
  blob: Blob;
  generatedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: ["credentialId", "bucket", "key"],
        });
        store.createIndex("generatedAt", "generatedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedThumbnail(
  credentialId: string,
  bucket: string,
  key: string,
  lastModified: string,
  size: number
): Promise<Blob | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get([credentialId, bucket, key]);
    req.onsuccess = () => {
      const record: ThumbnailRecord | undefined = req.result;
      if (
        record &&
        record.lastModified === lastModified &&
        record.size === size
      ) {
        resolve(record.blob);
      } else {
        resolve(null);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function storeThumbnail(
  credentialId: string,
  bucket: string,
  key: string,
  lastModified: string,
  size: number,
  blob: Blob
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const record: ThumbnailRecord = {
      credentialId,
      bucket,
      key,
      lastModified,
      size,
      blob,
      generatedAt: Date.now(),
    };
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function deleteCachedThumbnail(
  credentialId: string,
  bucket: string,
  key: string
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).delete([credentialId, bucket, key]);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function clearOldThumbnails(
  maxAgeDays = MAX_AGE_DAYS
): Promise<void> {
  const db = await openDb();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index("generatedAt");
    const range = IDBKeyRange.upperBound(cutoff);
    const req = index.openCursor(range);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
