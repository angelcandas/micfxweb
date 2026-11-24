// Hand-offs waiting in the browser's storage (IndexedDB) between handoff.html and the DAW
// page: what MicFX Voice sent ("in-<id>"), and what the DAW is sending ("out-<id>").
import type { HandoffPayload } from "@micfx/handoff";

const open = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open("micfx-handoff", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("items");
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function run<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = act(db.transaction("items", mode).objectStore("items"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export const putHandoff = (key: string, payload: HandoffPayload) => run("readwrite", (s) => s.put(payload, key));
export const takeHandoff = async (key: string) => {
  const payload = await run<HandoffPayload | undefined>("readonly", (s) => s.get(key) as IDBRequest<HandoffPayload | undefined>);
  await run("readwrite", (s) => s.delete(key));
  return payload;
};
