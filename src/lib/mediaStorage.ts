/**
 * A robust local persistence layer for media files (images and video Base64 streams)
 * utilizing standard client-side IndexedDB.
 * This completely avoids localStorage size limit errors (QuotaExceeded) and
 * allows saving/loading large documents from Firestore without violating rules or size bounds.
 */

const DB_NAME = 'RiaMediaStorage';
const STORE_NAME = 'media';
const DB_VERSION = 1;

function getDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error || new Error('Failed to open database'));
    };
  });
}

export interface StoredMedia {
  id: string;
  dataUrl: string;
  thumbnailUrl?: string;
  timestamp: number;
}

/**
 * Persists a captured photo or video Base64 stream inside IndexedDB.
 */
export async function saveMediaToIDB(id: string, dataUrl: string, thumbnailUrl?: string): Promise<void> {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      const record: StoredMedia = {
        id,
        dataUrl,
        thumbnailUrl,
        timestamp: Date.now(),
      };

      const request = store.put(record);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(request.error || new Error(`Failed to put media with ID: ${id}`));
      };
    });
  } catch (error) {
    console.error('Error saving media to IndexedDB:', error);
  }
}

/**
 * Retrieves a persistent media object by its ID from IndexedDB.
 */
export async function getMediaFromIDB(id: string): Promise<StoredMedia | null> {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(id);

      request.onsuccess = () => {
        resolve(request.result || null);
      };

      request.onerror = () => {
        reject(request.error || new Error(`Failed to get media with ID: ${id}`));
      };
    });
  } catch (error) {
    console.error('Error loading media from IndexedDB:', error);
    return null;
  }
}

/**
 * Deletes a persistent media object by its ID from IndexedDB.
 */
export async function deleteMediaFromIDB(id: string): Promise<void> {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(id);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(request.error || new Error(`Failed to delete media with ID: ${id}`));
      };
    });
  } catch (error) {
    console.error('Error deleting media from IndexedDB:', error);
  }
}

/**
 * Clears all locally cached media items.
 */
export async function clearAllMediaFromIDB(): Promise<void> {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(request.error || new Error('Failed to clear IDB media store'));
      };
    });
  } catch (error) {
    console.error('Error clearing IndexedDB media store:', error);
  }
}
